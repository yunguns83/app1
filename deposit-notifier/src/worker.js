// 카카오워크 입금 알림 - Cloudflare Worker (API 서버)
import {
  isDeposit, extractAmount, findMatch, buildMessage, redactBalance, nameInText, sameDeposit, DEFAULT_TEMPLATE,
} from './parse.js';

const KW_API = 'https://api.kakaowork.com/v1/';
const DAY = 86400000;
const DEDUP_MS = 10 * 60 * 1000;   // 같은 알림이 10분 안에 또 오면 무시
const CROSS_APP_MS = 5 * 60 * 1000; // 다른 앱(기업은행/토스)에서 온 같은 입금 알림 판단 시간
const KEEP_DAYS = 60;              // 입금 기록 보관 기간
const RETRO_MS = DAY;              // 명단 등록 시 최근 24시간 미매칭 입금도 다시 확인

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const fail = (message, status = 400) => json({ ok: false, error: message }, status);

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function seoulTime(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 설정 ----------
async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return {
    conversationId: s.conversationId || env.KAKAOWORK_CONVERSATION_ID || '',
    conversationName: s.conversationName || '',
    template: s.template || DEFAULT_TEMPLATE,
    expireDays: Number(s.expireDays || 7),
  };
}
async function saveSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(key, String(value ?? '')).run();
}

// ---------- 비밀값 (서버 secret 우선, 없으면 앱 설정 화면에서 입력한 값) ----------
async function getRaw(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  return r?.value || '';
}
async function appKey(env) {
  return env.KAKAOWORK_APP_KEY || (await getRaw(env, 'secret.kakaoAppKey'));
}
function randomToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}
/** 휴대폰(MacroDroid) 전송용 토큰. 서버 secret 이 없으면 처음 한 번 자동 생성 */
async function notifyToken(env) {
  if (env.NOTIFY_TOKEN) return env.NOTIFY_TOKEN;
  let t = await getRaw(env, 'secret.notifyToken');
  if (!t) { t = randomToken(); await saveSetting(env, 'secret.notifyToken', t); }
  return t;
}
async function passwordHash(pw, salt) {
  return sha256(`${salt}:${pw}`);
}
async function hasPassword(env) {
  return !!(env.APP_PASSWORD || (await getRaw(env, 'secret.passwordHash')));
}
async function checkPassword(env, pw) {
  if (!pw) return false;
  if (env.APP_PASSWORD) return safeEqual(pw, env.APP_PASSWORD);
  const hash = await getRaw(env, 'secret.passwordHash');
  if (!hash) return false;
  return safeEqual(await passwordHash(pw, await getRaw(env, 'secret.passwordSalt')), hash);
}
async function setPassword(env, pw) {
  if (String(pw || '').length < 6) throw new Error('비밀번호는 6자 이상으로 정하세요');
  const salt = randomToken(12);
  await saveSetting(env, 'secret.passwordSalt', salt);
  await saveSetting(env, 'secret.passwordHash', await passwordHash(pw, salt));
}

// ---------- 카카오워크 ----------
async function kakao(env, method, path, body) {
  const key = await appKey(env);
  if (!key) throw new Error('카카오워크 봇 App Key가 없습니다 (설정 탭에서 입력)');
  const res = await fetch((env.KAKAOWORK_API_BASE || KW_API) + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data?.error?.message || data?.error?.code || `카카오워크 HTTP ${res.status}`);
  }
  return data;
}
async function sendKakao(env, text) {
  const { conversationId } = await getSettings(env);
  if (!conversationId) throw new Error('카카오워크 대화방이 설정되지 않았습니다 (설정 화면에서 선택)');
  await kakao(env, 'POST', 'messages.send', { conversation_id: Number(conversationId) || conversationId, text });
}

// ---------- 입금 처리 ----------
async function waitingList(env, settings) {
  const since = Date.now() - settings.expireDays * DAY;
  const { results } = await env.DB.prepare(
    "SELECT * FROM pending WHERE status = 'waiting' AND created_at >= ?1 ORDER BY created_at"
  ).bind(since).all();
  return results;
}

/** 매칭된 입금을 카카오워크로 보내고 기록 갱신 */
async function deliver(env, settings, deposit, p, patientOverride) {
  const patient = patientOverride || p?.patient || '';
  const msg = buildMessage({
    template: settings.template,
    patient,
    depositor: p?.depositor,
    amount: deposit.amount,
    expected: p?.amount,
    memo: p?.memo,
    time: seoulTime(deposit.received_at),
  });
  try {
    await sendKakao(env, msg);
    await env.DB.prepare("UPDATE deposits SET status = 'sent', pending_id = ?2, patient = ?3, error = NULL WHERE id = ?1")
      .bind(deposit.id, p?.id ?? null, patient).run();
    if (p) await env.DB.prepare("UPDATE pending SET status = 'done', deposit_id = ?2, done_at = ?3 WHERE id = ?1")
      .bind(p.id, deposit.id, Date.now()).run();
    return { status: 'sent', patient, message: msg };
  } catch (e) {
    await env.DB.prepare("UPDATE deposits SET status = 'failed', pending_id = ?2, patient = ?3, error = ?4 WHERE id = ?1")
      .bind(deposit.id, p?.id ?? null, patient, String(e.message)).run();
    return { status: 'failed', patient, error: String(e.message) };
  }
}

async function readNotifyBody(request) {
  const url = new URL(request.url);
  const raw = await request.text();
  let title = url.searchParams.get('title') || '';
  let text = url.searchParams.get('text') || '';
  if (raw) {
    const type = request.headers.get('Content-Type') || '';
    let parsed = null;
    if (type.includes('json') || raw.trim().startsWith('{')) {
      try { parsed = JSON.parse(raw); } catch { /* 일반 텍스트로 처리 */ }
    } else if (type.includes('x-www-form-urlencoded')) {
      parsed = Object.fromEntries(new URLSearchParams(raw));
    }
    if (parsed && typeof parsed === 'object') {
      title = parsed.title || title;
      text = parsed.text || parsed.message || parsed.notification || text;
    } else {
      text = raw;
    }
  }
  return [title, text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function handleNotify(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('X-Token') || '';
  if (!safeEqual(token, await notifyToken(env))) return fail('토큰이 올바르지 않습니다', 401);

  const text = await readNotifyBody(request);
  if (!text) return fail('알림 내용이 비어 있습니다');
  if (!isDeposit(text)) return json({ ok: true, result: 'ignored', reason: '입금 알림이 아님' }); // 저장하지 않음

  const now = Date.now();
  const hash = await sha256(text);
  const dup = await env.DB.prepare('SELECT id FROM deposits WHERE hash = ?1 AND received_at >= ?2')
    .bind(hash, now - DEDUP_MS).first();
  if (dup) return json({ ok: true, result: 'duplicate' });

  // 오래된 기록 정리
  await env.DB.prepare('DELETE FROM deposits WHERE received_at < ?1').bind(now - KEEP_DAYS * DAY).run();
  await env.DB.prepare("DELETE FROM pending WHERE status != 'waiting' AND created_at < ?1").bind(now - KEEP_DAYS * DAY).run();

  const amount = extractAmount(text);
  // 다른 앱에서 먼저 온 같은 입금이면 무시 (기업은행 앱 + 토스 앱 동시 알림)
  if (amount) {
    const { results: recent } = await env.DB.prepare(
      "SELECT text, amount FROM deposits WHERE amount = ?1 AND received_at >= ?2"
    ).bind(amount, now - CROSS_APP_MS).all();
    if (recent.some((r) => sameDeposit(r, { text, amount }))) return json({ ok: true, result: 'duplicate', reason: '다른 앱에서 온 같은 입금' });
  }

  const ins = await env.DB.prepare(
    "INSERT INTO deposits (received_at, text, hash, amount, status) VALUES (?1, ?2, ?3, ?4, 'unmatched') RETURNING id"
  ).bind(now, redactBalance(text), hash, amount).first();
  const deposit = { id: ins.id, received_at: now, amount, text };

  const settings = await getSettings(env);
  const p = findMatch(await waitingList(env, settings), text, amount);
  if (!p) return json({ ok: true, result: 'unmatched', amount });
  const r = await deliver(env, settings, deposit, p);
  return json({ ok: r.status === 'sent', result: r.status, patient: r.patient, amount, error: r.error });
}

// ---------- 직원용 API ----------
async function state(env) {
  const settings = await getSettings(env);
  const pending = await waitingList(env, settings);
  const { results: done } = await env.DB.prepare(
    "SELECT * FROM pending WHERE status = 'done' AND done_at >= ?1 ORDER BY done_at DESC LIMIT 30"
  ).bind(Date.now() - 2 * DAY).all();
  const { results: deposits } = await env.DB.prepare(
    "SELECT id, received_at, text, amount, patient, status, error FROM deposits WHERE status != 'ignored' ORDER BY received_at DESC LIMIT 50"
  ).all();
  return {
    ok: true,
    pending, done, deposits,
    settings: { ...settings, hasAppKey: !!(await appKey(env)), notifyToken: await notifyToken(env), passwordFromServer: !!env.APP_PASSWORD },
  };
}

async function addPending(env, body) {
  const patient = String(body.patient || '').trim();
  if (patient.length < 2) throw new Error('환자 이름을 2글자 이상 입력하세요');
  const depositor = String(body.depositor || '').trim() || null;
  const amount = Number(String(body.amount || '').replace(/[^\d]/g, '')) || null;
  const memo = String(body.memo || '').trim() || null;
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO pending (patient, depositor, amount, memo, created_at, status) VALUES (?1, ?2, ?3, ?4, ?5, 'waiting') RETURNING *"
  ).bind(patient, depositor, amount, memo, now).first();

  // 직원이 등록하기 전에 이미 들어온 입금이 있으면 바로 매칭
  const { results } = await env.DB.prepare(
    "SELECT * FROM deposits WHERE status = 'unmatched' AND received_at >= ?1 ORDER BY received_at"
  ).bind(now - RETRO_MS).all();
  const hit = results.find((d) => [depositor, patient].filter(Boolean).some((n) => nameInText(n, d.text)));
  if (hit) {
    const r = await deliver(env, await getSettings(env), hit, row);
    return { pending: row, matched: r };
  }
  return { pending: row };
}

async function api(request, env, path) {
  const method = request.method;
  const body = method === 'POST' || method === 'PUT' ? await request.json().catch(() => ({})) : {};
  let m;

  if (path === '/api/state' && method === 'GET') return json(await state(env));

  if (path === '/api/pending' && method === 'POST') return json({ ok: true, ...(await addPending(env, body)) });

  if ((m = path.match(/^\/api\/pending\/(\d+)$/)) && method === 'DELETE') {
    await env.DB.prepare("UPDATE pending SET status = 'canceled' WHERE id = ?1 AND status = 'waiting'").bind(m[1]).run();
    return json({ ok: true });
  }

  // 미매칭/실패 입금을 직접 보내기 (보호자 이름으로 입금한 경우 등)
  if ((m = path.match(/^\/api\/deposits\/(\d+)\/send$/)) && method === 'POST') {
    const d = await env.DB.prepare('SELECT * FROM deposits WHERE id = ?1').bind(m[1]).first();
    if (!d) return fail('입금 기록이 없습니다', 404);
    let p = null;
    if (body.pendingId) p = await env.DB.prepare('SELECT * FROM pending WHERE id = ?1').bind(body.pendingId).first();
    else if (d.pending_id) p = await env.DB.prepare('SELECT * FROM pending WHERE id = ?1').bind(d.pending_id).first();
    const patient = String(body.patient || '').trim() || p?.patient || d.patient;
    if (!patient) return fail('환자 이름을 입력하세요');
    if (body.amount) d.amount = Number(String(body.amount).replace(/[^\d]/g, '')) || d.amount;
    await env.DB.prepare('UPDATE deposits SET amount = ?2 WHERE id = ?1').bind(d.id, d.amount).run();
    const r = await deliver(env, await getSettings(env), d, p, patient);
    return json({ ok: r.status === 'sent', ...r });
  }

  if ((m = path.match(/^\/api\/deposits\/(\d+)\/ignore$/)) && method === 'POST') {
    await env.DB.prepare("UPDATE deposits SET status = 'ignored' WHERE id = ?1").bind(m[1]).run();
    return json({ ok: true });
  }

  // 알림 문구 해석 미리보기 (설정 확인용, 저장·전송 없음)
  if (path === '/api/test-parse' && method === 'POST') {
    const text = String(body.text || '');
    const settings = await getSettings(env);
    const amount = extractAmount(text);
    const p = isDeposit(text) ? findMatch(await waitingList(env, settings), text, amount) : null;
    return json({ ok: true, isDeposit: isDeposit(text), amount, match: p ? p.patient : null });
  }

  if (path === '/api/settings' && method === 'POST') {
    for (const k of ['conversationId', 'conversationName', 'template', 'expireDays']) {
      if (k in body) await saveSetting(env, k, body[k]);
    }
    return json({ ok: true, settings: await getSettings(env) });
  }

  // 카카오워크 App Key 입력 (저장만 하고 다시 보여주지 않음)
  if (path === '/api/secret/appkey' && method === 'POST') {
    const key = String(body.appKey || '').trim();
    if (key.length < 10) return fail('App Key를 확인하세요');
    await saveSetting(env, 'secret.kakaoAppKey', key);
    return json({ ok: true });
  }
  if (path === '/api/secret/password' && method === 'POST') {
    if (env.APP_PASSWORD) return fail('비밀번호가 서버(secret)에 설정되어 있어 여기서 바꿀 수 없습니다');
    await setPassword(env, body.password);
    return json({ ok: true });
  }
  // 휴대폰 전송 토큰 새로 만들기 (토큰이 새어 나갔을 때)
  if (path === '/api/secret/notify-token' && method === 'POST') {
    if (env.NOTIFY_TOKEN) return fail('토큰이 서버(secret)에 설정되어 있어 여기서 바꿀 수 없습니다');
    await saveSetting(env, 'secret.notifyToken', randomToken());
    return json({ ok: true, notifyToken: await notifyToken(env) });
  }

  if (path === '/api/kakao/conversations' && method === 'GET') {
    const data = await kakao(env, 'GET', 'conversations.list?limit=100');
    return json({ ok: true, conversations: data.conversations || [] });
  }

  // 직원 이메일로 단체방 만들기 (봇은 기존 방에 초대될 수 없어서 봇이 방을 엽니다)
  if (path === '/api/kakao/open' && method === 'POST') {
    const emails = String(body.emails || '').split(/[\s,;]+/).filter(Boolean);
    if (!emails.length) return fail('이메일을 입력하세요');
    const ids = [];
    for (const email of emails) {
      const u = await kakao(env, 'GET', `users.find_by_email?email=${encodeURIComponent(email)}`);
      ids.push(u.user.id);
    }
    const c = await kakao(env, 'POST', 'conversations.open', ids.length === 1 ? { user_id: ids[0] } : { user_ids: ids });
    const conv = c.conversation;
    await saveSetting(env, 'conversationId', conv.id);
    await saveSetting(env, 'conversationName', conv.name || emails.join(', '));
    return json({ ok: true, conversation: conv });
  }

  if (path === '/api/kakao/test' && method === 'POST') {
    await sendKakao(env, '✅ 입금 알림 봇 연결 테스트입니다.');
    return json({ ok: true });
  }

  return fail('없는 주소입니다', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (path === '/api/notify') {
        if (request.method !== 'POST' && request.method !== 'GET') return fail('POST로 보내세요', 405);
        return await handleNotify(request, env);
      }
      // 처음 설치: 비밀번호가 아직 없으면 첫 화면에서 정함
      if (path === '/api/setup') {
        if (request.method === 'GET') return json({ ok: true, needsPassword: !(await hasPassword(env)) });
        if (await hasPassword(env)) return fail('이미 비밀번호가 정해져 있습니다', 403);
        const b = await request.json().catch(() => ({}));
        await setPassword(env, b.password);
        return json({ ok: true });
      }
      const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!(await checkPassword(env, auth))) return fail('비밀번호가 올바르지 않습니다', 401);
      if (path === '/api/login') return json({ ok: true });
      return await api(request, env, path);
    } catch (e) {
      return fail(String(e.message || e), 500);
    }
  },
};

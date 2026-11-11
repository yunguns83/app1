'use strict';
const $ = (s) => document.querySelector(s);
const PW_KEY = 'dn-password';
let password = '';
let data = null;
let pollTimer = null;

try { password = localStorage.getItem(PW_KEY) || ''; } catch { /* 저장소 사용 불가 */ }

// ---------- 공통 ----------
async function call(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${password}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const out = await res.json().catch(() => ({ ok: false, error: `서버 응답 오류 (${res.status})` }));
  if (res.status === 401 && path !== '/api/login') { logout(); throw new Error('다시 로그인하세요'); }
  if (!res.ok || out.ok === false) throw new Error(out.error || out.message || `오류 ${res.status}`);
  return out;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3000);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => (n == null ? '금액 확인 필요' : `${Number(n).toLocaleString('ko-KR')}원`);
function when(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

// ---------- 로그인 ----------
function showLogin() {
  $('#login').hidden = false;
  $('#main').hidden = true;
  $('#pw').focus();
}
function logout() {
  password = '';
  try { localStorage.removeItem(PW_KEY); } catch { /* 무시 */ }
  clearInterval(pollTimer);
  showLogin();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  password = $('#pw').value;
  $('#loginErr').textContent = '';
  try {
    await call('/api/login', { method: 'POST' });
    try { localStorage.setItem(PW_KEY, password); } catch { /* 무시 */ }
    start();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});
$('#logout').addEventListener('click', logout);

// ---------- 화면 ----------
function render() {
  if (!data) return;
  const { pending, done, deposits, settings } = data;

  $('#cntWaiting').textContent = pending.length || '';
  const unmatched = deposits.filter((d) => d.status === 'unmatched' || d.status === 'failed').length;
  $('#cntUnmatched').textContent = unmatched || '';

  const connected = settings.hasAppKey && settings.conversationId;
  $('#conn').textContent = connected ? '● 연결됨' : '● 설정 필요';
  $('#conn').className = 'conn ' + (connected ? 'ok' : 'bad');

  $('#waitingList').innerHTML = pending.length
    ? pending.map((p) => `
      <li>
        <div class="main">
          <strong>${esc(p.patient)}</strong>
          ${p.depositor ? `<span class="tag">입금자 ${esc(p.depositor)}</span>` : ''}
          ${p.amount ? `<span class="amt">${won(p.amount)}</span>` : ''}
          ${p.memo ? `<div class="sub">${esc(p.memo)}</div>` : ''}
          <div class="sub">${when(p.created_at)} 등록</div>
        </div>
        <button class="ghost small" data-cancel="${p.id}">취소</button>
      </li>`).join('')
    : '<li class="empty">대기 중인 환자가 없습니다</li>';

  $('#doneList').innerHTML = done.length
    ? done.map((p) => `<li><div class="main">✅ <strong>${esc(p.patient)}</strong> <span class="sub">${when(p.done_at)} 전송</span></div></li>`).join('')
    : '<li class="empty">-</li>';

  const label = { sent: '전송됨', unmatched: '명단에 없음', failed: '전송 실패' };
  $('#depositList').innerHTML = deposits.length
    ? deposits.map((d) => `
      <li class="st-${d.status}">
        <div class="main">
          <span class="badge">${label[d.status] || d.status}</span>
          <span class="amt">${won(d.amount)}</span>
          ${d.patient ? `<strong>${esc(d.patient)}</strong>` : ''}
          <div class="raw">${esc(d.text)}</div>
          ${d.error ? `<div class="err">${esc(d.error)}</div>` : ''}
          <div class="sub">${when(d.received_at)}</div>
        </div>
        ${d.status !== 'sent' ? `<div class="btns">
          <button class="primary small" data-send="${d.id}">${d.status === 'failed' ? '다시 보내기' : '보내기'}</button>
          ${d.status === 'unmatched' ? `<button class="ghost small" data-ignore="${d.id}">환자 아님</button>` : ''}
        </div>` : ''}
      </li>`).join('')
    : '<li class="empty">아직 입금 알림이 없습니다</li>';

  // 설정 (입력 중일 때 덮어쓰지 않도록 처음 한 번만 채움)
  $('#convNow').textContent = settings.conversationId
    ? `현재: ${settings.conversationName || '대화방'} (ID ${settings.conversationId})`
    : '아직 대화방이 선택되지 않았습니다.';
  if (!settings.hasAppKey) $('#convNow').textContent += ' ⚠️ 서버에 KAKAOWORK_APP_KEY가 없습니다.';
  if (!render.filled) {
    $('#template').value = settings.template;
    $('#expireDays').value = settings.expireDays;
    render.filled = true;
  }
}

async function refresh() {
  try {
    data = await call('/api/state');
    render();
  } catch (e) {
    if (password) toast(e.message, true);
  }
}

function start() {
  $('#login').hidden = true;
  $('#main').hidden = false;
  $('#notifyUrl').textContent = `${location.origin}/api/notify?token=TOKEN`;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && password) refresh(); });

// 탭
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
}));

// 대기 등록
$('#fAmount').addEventListener('input', (e) => {
  const n = e.target.value.replace(/[^\d]/g, '');
  e.target.value = n ? Number(n).toLocaleString('ko-KR') : '';
});
$('#sendAmount').addEventListener('input', (e) => {
  const n = e.target.value.replace(/[^\d]/g, '');
  e.target.value = n ? Number(n).toLocaleString('ko-KR') : '';
});
$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(e.submitter, async () => {
    const out = await call('/api/pending', {
      method: 'POST',
      body: { patient: $('#fPatient').value, depositor: $('#fDepositor').value, amount: $('#fAmount').value, memo: $('#fMemo').value },
    });
    e.target.reset();
    if (out.matched?.status === 'sent') toast(`이미 들어온 입금과 맞아서 바로 보냈어요 (${out.matched.patient})`);
    else if (out.matched?.status === 'failed') toast(`입금은 찾았지만 전송 실패: ${out.matched.error}`, true);
    else toast('등록했습니다. 입금되면 자동으로 보내요');
    await refresh();
    $('#fPatient').focus();
  });
});

$('#waitingList').addEventListener('click', (e) => {
  const id = e.target.dataset.cancel;
  if (!id) return;
  const p = data.pending.find((x) => String(x.id) === id);
  if (!confirm(`${p?.patient} 님을 대기 명단에서 뺄까요?`)) return;
  guard(e.target, async () => { await call(`/api/pending/${id}`, { method: 'DELETE' }); await refresh(); });
});

// 입금 내역: 직접 보내기 / 무시
let sendingId = null;
$('#depositList').addEventListener('click', (e) => {
  const { send, ignore } = e.target.dataset;
  if (ignore) {
    guard(e.target, async () => { await call(`/api/deposits/${ignore}/ignore`, { method: 'POST' }); await refresh(); });
  }
  if (send) {
    const d = data.deposits.find((x) => String(x.id) === send);
    sendingId = send;
    $('#sendText').textContent = d.text;
    $('#sendPick').innerHTML = '<option value="">— 대기 명단에서 선택 —</option>' +
      data.pending.map((p) => `<option value="${p.id}">${esc(p.patient)}${p.amount ? ` (${won(p.amount)})` : ''}</option>`).join('');
    $('#sendPatient').value = d.patient || '';
    $('#sendAmount').value = d.amount ? Number(d.amount).toLocaleString('ko-KR') : '';
    $('#sendDlg').showModal();
  }
});
$('#sendPick').addEventListener('change', (e) => {
  const p = data.pending.find((x) => String(x.id) === e.target.value);
  if (p) $('#sendPatient').value = p.patient;
});
$('#sendDlg').addEventListener('close', () => {
  if ($('#sendDlg').returnValue !== 'ok' || !sendingId) return;
  const id = sendingId;
  sendingId = null;
  guard(null, async () => {
    await call(`/api/deposits/${id}/send`, {
      method: 'POST',
      body: { pendingId: $('#sendPick').value || undefined, patient: $('#sendPatient').value, amount: $('#sendAmount').value },
    });
    toast('카카오워크로 보냈습니다');
    await refresh();
  });
});

// ---------- 설정 ----------
$('#convLoad').addEventListener('click', (e) => guard(e.target, async () => {
  const { conversations } = await call('/api/kakao/conversations');
  $('#convSelect').innerHTML = '<option value="">— 대화방 선택 —</option>' + conversations.map((c) =>
    `<option value="${esc(c.id)}" data-name="${esc(c.name || '')}">${esc(c.name || '(이름 없음)')} · ${esc(c.type || '')} · ${c.users_count ?? '?'}명</option>`).join('');
  if (!conversations.length) toast('봇이 들어가 있는 대화방이 없습니다. 아래에서 단체방을 만드세요.', true);
}));
$('#convSelect').addEventListener('change', (e) => guard(null, async () => {
  const opt = e.target.selectedOptions[0];
  if (!opt.value) return;
  await call('/api/settings', { method: 'POST', body: { conversationId: opt.value, conversationName: opt.dataset.name } });
  toast('대화방을 저장했습니다');
  await refresh();
}));
$('#convOpen').addEventListener('click', (e) => guard(e.target, async () => {
  const { conversation } = await call('/api/kakao/open', { method: 'POST', body: { emails: $('#emails').value } });
  toast(`단체방을 열고 저장했습니다 (ID ${conversation.id})`);
  await refresh();
}));
$('#testSend').addEventListener('click', (e) => guard(e.target, async () => {
  await call('/api/kakao/test', { method: 'POST' });
  toast('테스트 메시지를 보냈습니다');
}));
$('#saveSettings').addEventListener('click', (e) => guard(e.target, async () => {
  await call('/api/settings', { method: 'POST', body: { template: $('#template').value, expireDays: $('#expireDays').value || 7 } });
  toast('저장했습니다');
  await refresh();
}));
$('#parseBtn').addEventListener('click', (e) => guard(e.target, async () => {
  const r = await call('/api/test-parse', { method: 'POST', body: { text: $('#parseText').value } });
  $('#parseResult').textContent = r.isDeposit
    ? `✅ 입금으로 인식 · 금액 ${won(r.amount)} · ${r.match ? `대기 명단 '${r.match}'와 일치` : '대기 명단과 일치하는 이름 없음'}`
    : '❌ 입금 알림으로 인식되지 않음 (무시됩니다)';
}));

// ---------- 설치 / 오프라인 ----------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#installBtn').hidden = true;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

if (password) start(); else showLogin();

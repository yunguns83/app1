// 은행 앱 알림 문구 해석 + 입금 대기 명단과 매칭 (순수 함수, 테스트 가능)

/** 비교용 정규화: 공백·괄호·특수문자 제거 */
export function normalize(s) {
  return String(s || '').replace(/[\s()\[\]{}<>|·.,:;'"\-_/\\]/g, '');
}

/** 잔액 숫자를 가려서 저장/표시 (개인 통장 잔액 노출 방지) */
export function redactBalance(text) {
  return String(text || '').replace(/(잔액|잔고)\s*[:：]?\s*[\d,]+\s*원?/g, '$1 ***');
}

/** 입금 알림인지 판단. '입출금통장' 같은 단어는 제외하고 본다. */
// 토스 받은 돈 알림: "홍길동님이 50,000원을 보냈어요" (보낸 돈은 "~님에게 보냈어요"라서 해당 안 됨)
const TOSS_IN = /님이\s*[\d,]+\s*원을?\s*(보냈어요|입금했어요)/;

export function isDeposit(text) {
  const t = String(text || '').replace(/입출금/g, '');
  if (/출금|입금\s*취소|취소|지급|결제|송금완료|님에게/.test(t)) return false;
  return /입금/.test(t) || TOSS_IN.test(t);
}

/**
 * 입금액 추출. 쉼표가 있는 숫자 또는 '원'이 붙은 숫자만 금액으로 본다
 * (날짜·시각·계좌번호 오인 방지). '잔액' 뒤 숫자는 제외하고, '입금' 단어와 가장 가까운 것을 고른다.
 */
export function extractAmount(text) {
  const t = String(text || '');
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(\s*원)?/g;
  const anchors = [];
  for (const m of t.matchAll(/입금|보냈어요/g)) anchors.push(m.index);
  let best = null;
  for (const m of t.matchAll(re)) {
    const hasComma = m[1].includes(',');
    const hasWon = !!m[2];
    if (!hasComma && !hasWon) continue;
    const before = t.slice(Math.max(0, m.index - 8), m.index);
    if (/잔액|잔고/.test(before)) continue;
    const prevCh = t[m.index - 1];
    if (prevCh && /[\d*\-]/.test(prevCh)) continue; // 계좌번호 일부
    const value = Number(m[1].replace(/,/g, ''));
    if (!value) continue;
    const dist = anchors.length ? Math.min(...anchors.map((a) => Math.abs(a - m.index))) : 0;
    if (!best || dist < best.dist) best = { value, dist };
  }
  return best ? best.value : null;
}

/** 이름이 알림 문구에 들어 있는지. 가운데 글자 마스킹(홍*동, 홍○동)도 허용 */
export function nameInText(name, text) {
  const n = normalize(name);
  const t = normalize(text);
  if (n.length < 2) return false;
  if (t.includes(n)) return true;
  if (n.length >= 3) {
    const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chars = [...n];
    const pattern = chars
      .map((c, i) => (i === 0 || i === chars.length - 1 ? esc(c) : `(?:${esc(c)}|[*＊○●xX])`))
      .join('');
    if (new RegExp(pattern).test(t)) return true;
  }
  return false;
}

/**
 * 대기 명단에서 알림과 맞는 항목 찾기.
 * - 입금자명(depositor) 또는 환자 이름(patient)이 문구에 있으면 후보
 * - 더 긴 이름 우선 (김민 vs 김민수), 같은 길이면 예상 금액 일치 우선, 그다음 먼저 등록한 순
 */
export function findMatch(pendingList, text, amount) {
  const candidates = [];
  for (const p of pendingList) {
    const names = [p.depositor, p.patient].filter(Boolean);
    let len = 0;
    for (const nm of names) if (nameInText(nm, text)) len = Math.max(len, normalize(nm).length);
    if (len) candidates.push({ p, len, amountOk: p.amount && amount ? p.amount === amount : false });
  }
  candidates.sort((a, b) =>
    b.len - a.len ||
    Number(b.amountOk) - Number(a.amountOk) ||
    a.p.created_at - b.p.created_at
  );
  return candidates.length ? candidates[0].p : null;
}

export function formatWon(n) {
  return n == null ? '확인 필요' : Number(n).toLocaleString('ko-KR');
}

export const DEFAULT_TEMPLATE = '💰 계좌이체 입금 확인\n· 환자: {환자}\n· 금액: {금액}원\n· 시각: {시각}';

/** 카카오워크로 보낼 문구 만들기 */
export function buildMessage({ template, patient, depositor, amount, expected, memo, time }) {
  let msg = (template || DEFAULT_TEMPLATE)
    .replaceAll('{환자}', patient || '')
    .replaceAll('{금액}', formatWon(amount))
    .replaceAll('{입금자}', depositor || patient || '')
    .replaceAll('{시각}', time || '')
    .replaceAll('{메모}', memo || '');
  if (depositor && normalize(depositor) !== normalize(patient) && !(template || '').includes('{입금자}')) {
    msg += `\n· 입금자: ${depositor}`;
  }
  if (memo && !(template || '').includes('{메모}')) msg += `\n· 메모: ${memo}`;
  if (expected && amount && expected !== amount) {
    msg += `\n⚠️ 예상 금액(${formatWon(expected)}원)과 다릅니다`;
  }
  return msg;
}

// 은행·앱 이름 등 이름 비교에서 뺄 단어
const STOP = new Set(['입금', '잔액', '잔고', '기업', '기업은행', '은행', '토스', '토스뱅크', '통장', '계좌', '알림',
  '보냈어요', '입금했어요', '원을', '내통장', '입금알림', '받은', '송금', '이체', '저축예금', '보통예금']);
function nameTokens(text) {
  return new Set((String(text || '').match(/[가-힣]{2,6}/g) || [])
    .map((w) => w.replace(/(님이|님|에게|으로|로부터)$/, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w)));
}

/**
 * 같은 입금이 다른 앱에서 또 온 알림인지 (예: 기업은행 앱 + 토스 앱).
 * 금액이 같고, 은행 이름 등을 뺀 한글 단어(입금자 이름)가 하나라도 겹치면 같은 입금으로 본다.
 */
export function sameDeposit(a, b) {
  if (!a?.amount || a.amount !== b?.amount) return false;
  const ta = nameTokens(a.text);
  for (const w of nameTokens(b.text)) if (ta.has(w)) return true;
  return false;
}

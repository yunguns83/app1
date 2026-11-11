import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeposit, extractAmount, findMatch, nameInText, redactBalance, buildMessage, sameDeposit } from '../src/parse.js';

const samples = [
  // [알림 문구, 입금 여부, 금액]
  ['[KB]11/11 10:23 123456**789 홍길동 입금 50,000 잔액1,234,567', true, 50000],
  ['신한은행 입금 35,000원 홍길동 11/11 14:02 잔액 2,000,000원', true, 35000],
  ['입금 120,000원 김영희 | 잔액 3,456,000원', true, 120000],
  ['농협 입금50,000원 11/11 10:23 351-****-1234-56 홍길동 잔액1,000,000원', true, 50000],
  ['토스뱅크 45,000원 입금 홍길동 → 내 입출금통장', true, 45000],
  ['[KB]11/11 10:23 123456**789 쿠팡 출금 23,000 잔액1,211,567', false, null],
  ['신한카드 승인 홍길동 12,000원 일시불 결제', false, null],
  ['입금취소 50,000원 홍길동', false, null],
  ['우리은행 입출금 알림 이체출금 30,000원', false, null],
  // 기업은행 i-ONE Bank 실제 형식 (제목 + 내용, MacroDroid 본문 "[not_title] [notification]")
  ['입출금내역 알림 [입금] 1원 홍길동 156-*******-01-013 11/11 22:46', true, 1],
  ['입출금내역 알림 [입금] 50,000원 홍길동 156-*******-01-013 11/11 22:46', true, 50000],
  ['입출금내역 알림 [입금] 1,250,000원 김영희 156-*******-01-013 11/11 09:05', true, 1250000],
  ['입출금내역 알림 [출금] 14,225원 우아한형제들 156-*******-01-013 11/11 22:42', false, null],
  // 기업은행 기타 예상 형식
  ['[IBK기업은행] 입금 50,000원 홍길동 11/11 10:23 123-******-01-011 잔액1,234,567원', true, 50000],
  ['IBK기업은행 입금 50,000원 홍길동 잔액 1,234,567원', true, 50000],
  ['기업 11/11 10:23 123-******-01-011 출금 30,000원 쿠팡 잔액1,204,567원', false, null],
  // 토스 — 예상 형식, 실제 문구로 확인 필요
  ['50,000원 입금 홍길동 → 기업 123-******-01-011', true, 50000],
  ['홍길동님이 50,000원을 보냈어요', true, 50000],
  ['홍길동님에게 50,000원을 보냈어요', false, null],
  ['토스 결제 12,000원 스타벅스', false, null],
];

test('입금 여부와 금액', () => {
  for (const [text, dep, amt] of samples) {
    assert.equal(isDeposit(text), dep, text);
    if (dep) assert.equal(extractAmount(text), amt, text);
  }
});

test('이름 매칭 (공백, 마스킹)', () => {
  assert.ok(nameInText('홍길동', '입금 50,000 홍 길동'));
  assert.ok(nameInText('홍길동', '입금 50,000원 홍*동'));
  assert.ok(!nameInText('홍길동', '입금 50,000원 김길동'));
  assert.ok(!nameInText('홍', '홍'));
});

test('더 긴 이름 우선, 같은 이름이면 예상 금액 일치 우선', () => {
  const list = [
    { id: 1, patient: '김민', created_at: 1 },
    { id: 2, patient: '김민수', created_at: 2 },
  ];
  assert.equal(findMatch(list, '입금 10,000원 김민수', 10000).id, 2);

  const same = [
    { id: 1, patient: '이영희', amount: 30000, created_at: 1 },
    { id: 2, patient: '이영희', amount: 50000, created_at: 2 },
  ];
  assert.equal(findMatch(same, '입금 50,000원 이영희', 50000).id, 2);
  assert.equal(findMatch(same, '입금 70,000원 이영희', 70000).id, 1);
});

test('보호자 이름(입금자명)으로 매칭', () => {
  const list = [{ id: 7, patient: '박지우', depositor: '박철수', created_at: 1 }];
  assert.equal(findMatch(list, '입금 40,000원 박철수', 40000).id, 7);
  assert.equal(findMatch(list, '입금 40,000원 최민호', 40000), null);
});

test('잔액 가리기', () => {
  assert.equal(redactBalance('입금 5,000원 잔액 1,234,567원'), '입금 5,000원 잔액 ***');
});

test('메시지 생성', () => {
  const msg = buildMessage({ patient: '박지우', depositor: '박철수', amount: 40000, expected: 45000, time: '11. 11. 10:23' });
  assert.match(msg, /환자: 박지우/);
  assert.match(msg, /금액: 40,000원/);
  assert.match(msg, /입금자: 박철수/);
  assert.match(msg, /예상 금액\(45,000원\)과 다릅니다/);
});

test('기업은행 앱과 토스 앱에서 온 같은 입금은 하나로 본다', () => {
  const ibk = { amount: 50000, text: '[IBK기업은행] 입금 50,000원 홍길동 11/11 10:23 잔액 ***' };
  assert.ok(sameDeposit(ibk, { amount: 50000, text: '50,000원 입금 홍길동 → 기업 123-******-01-011' }));
  assert.ok(sameDeposit(ibk, { amount: 50000, text: '홍길동님이 50,000원을 보냈어요' }));
  // 같은 금액이라도 다른 사람이면 별개
  assert.ok(!sameDeposit(ibk, { amount: 50000, text: '50,000원 입금 김영희 → 기업' }));
  // 같은 사람이라도 금액이 다르면 별개
  assert.ok(!sameDeposit(ibk, { amount: 30000, text: '30,000원 입금 홍길동 → 기업' }));
});

test('기업은행 실제 형식: 이름 매칭', () => {
  const list = [{ id: 1, patient: '홍길동', created_at: 1 }, { id: 2, patient: '김영희', created_at: 2 }];
  assert.equal(findMatch(list, '입출금내역 알림 [입금] 50,000원 홍길동 156-*******-01-013 11/11 22:46', 50000).id, 1);
  // 계좌번호의 * 가 이름 가림 표시로 오인되지 않음
  assert.equal(findMatch([{ id: 3, patient: '이수민', created_at: 1 }], '입출금내역 알림 [입금] 50,000원 홍길동 156-*******-01-013', 50000), null);
});

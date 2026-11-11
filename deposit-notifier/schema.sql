-- 입금 대기 명단 (직원이 등록)
CREATE TABLE IF NOT EXISTS pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient TEXT NOT NULL,          -- 환자 이름
  depositor TEXT,                 -- 입금자명이 다를 때 (보호자 등)
  amount INTEGER,                 -- 예상 금액 (선택)
  memo TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | done | canceled
  deposit_id INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending (status, created_at);

-- 입금 알림 기록 (입금 알림만 저장, 잔액은 가려서 저장)
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  amount INTEGER,
  pending_id INTEGER,
  patient TEXT,
  status TEXT NOT NULL,           -- sent | unmatched | failed | ignored
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_deposits_time ON deposits (received_at);
CREATE INDEX IF NOT EXISTS idx_deposits_hash ON deposits (hash);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

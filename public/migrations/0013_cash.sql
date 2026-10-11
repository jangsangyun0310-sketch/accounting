-- 사무실 현금 (2026-10-11): 현금도 통장처럼 등록하고(is_cash = 1) 입금은 이체로 옮긴다.
-- 결산서는 현금을 통장과 따로 "보유 현금"으로 보여 준다.
ALTER TABLE accounts ADD COLUMN is_cash INTEGER NOT NULL DEFAULT 0 CHECK (is_cash IN (0, 1));

-- 금고 현금 확인: 그날 금고에서 센 금액 (장부 계산과는 상관없는 참고 기록 — 이 표만 지우면 기능이 빠진다)
CREATE TABLE cash_counts (
  count_date TEXT    NOT NULL CHECK (date(count_date) = count_date),
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  counted    INTEGER NOT NULL CHECK (typeof(counted) = 'integer' AND counted >= 0),
  updated_at TEXT    NOT NULL,
  updated_by TEXT    NOT NULL,
  PRIMARY KEY (count_date, account_id)
);

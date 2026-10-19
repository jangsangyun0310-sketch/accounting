-- 월말결산서 비고 (2026-10-19): 달마다 · 통장마다 · 줄마다 직접 적는 비고.
-- row_key = 'IN:내역' · 'OUT:내역' · 'IN_SUM' · 'OUT_SUM' (내역 = 거래의 내용, 내용이 없으면 기타)
-- 전년도 이월금 · 잔액 줄의 비고는 고정 문구라 저장하지 않는다.
CREATE TABLE month_notes (
  month      TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  row_key    TEXT    NOT NULL CHECK (length(row_key) BETWEEN 1 AND 120),
  note       TEXT    NOT NULL CHECK (length(trim(note)) > 0 AND length(note) <= 60),
  updated_at TEXT    NOT NULL,
  updated_by TEXT    NOT NULL,
  PRIMARY KEY (month, account_id, row_key)
);

-- 통장이 지워지면 비고도 지운다 (외래키 설정과 상관없이)
CREATE TRIGGER trg_month_notes_account_ad AFTER DELETE ON accounts
BEGIN DELETE FROM month_notes WHERE account_id = OLD.id; END;

-- 개인별 납부 (2026-10-11): 특별회계 수입의 납부자 이름. 연말에 사람별 납부 내역서를 만든다.
-- 거래 표는 마감 후 잠기므로 이름은 따로 둔다 → 마감한 날도 이름만 고칠 수 있다 (금액·통장·날짜는 그대로 잠김).
-- 같은 이름은 사무장이 직접 구분해서 적는다. 예) 홍길동(베드로)
CREATE TABLE tx_payers (
  tx_id      INTEGER PRIMARY KEY REFERENCES transactions (id) ON DELETE CASCADE,
  payer      TEXT    NOT NULL CHECK (length(trim(payer)) > 0 AND length(payer) <= 30),
  updated_at TEXT    NOT NULL,
  updated_by TEXT    NOT NULL
);
CREATE INDEX ix_tx_payers_payer ON tx_payers (payer);

-- 거래가 지워지면 이름도 지운다 (외래키 설정과 상관없이)
CREATE TRIGGER trg_tx_payers_tx_ad AFTER DELETE ON transactions
BEGIN DELETE FROM tx_payers WHERE tx_id = OLD.id; END;

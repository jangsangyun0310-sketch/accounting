-- 수입 차감 (2026-10-11): 봉헌권처럼 미리 수입으로 잡은 금액을 주일헌금 안에서 빼는 줄 (수입 내역에 − 로 보임).
-- 금액은 그대로 0보다 크게 두고, "수입 과목 + 출금 방향" 거래로 저장한다. 결산에서는 마이너스 수입으로 계산한다.
-- 차감할 수 있는 과목은 설정에서 표시한 수입 과목뿐이다 (allow_deduction = 1).
ALTER TABLE budget_subjects ADD COLUMN allow_deduction INTEGER NOT NULL DEFAULT 0 CHECK (allow_deduction IN (0, 1));

DROP TRIGGER trg_tx_bi_subject;
CREATE TRIGGER trg_tx_bi_subject BEFORE INSERT ON transactions
WHEN NEW.kind = 'NORMAL' AND NOT EXISTS (SELECT 1 FROM restore_session) AND NOT EXISTS (
  SELECT 1 FROM budget_subjects
  WHERE id = NEW.subject_id AND is_active = 1
    AND (kind = CASE NEW.direction WHEN 'IN' THEN 'INCOME' ELSE 'EXPENSE' END
         OR (NEW.direction = 'OUT' AND kind = 'INCOME' AND allow_deduction = 1))
)
BEGIN SELECT RAISE(ABORT, 'SUBJECT_MISMATCH'); END;

-- 차감 거래가 있는 과목은 "차감 허용"을 끌 수 없다
CREATE TRIGGER trg_subjects_bu_deduction BEFORE UPDATE OF allow_deduction ON budget_subjects
WHEN NEW.allow_deduction = 0 AND OLD.allow_deduction = 1
  AND EXISTS (SELECT 1 FROM transactions WHERE subject_id = OLD.id AND kind = 'NORMAL' AND direction = 'OUT')
BEGIN SELECT RAISE(ABORT, 'SUBJECT_IN_USE'); END;

-- 주일미사 1인당 헌금: 주일헌금 과목 (봉헌권 포함 금액으로 들어오는 수입 과목)
ALTER TABLE journal_settings ADD COLUMN offering_subject_id INTEGER REFERENCES budget_subjects (id);

-- 데이터 무결성 트리거
-- API 검증과 별도로 DB 차원에서 한 번 더 막는다. 오류 메시지는 API가 번역하는 코드값이다.
-- 잠금 기준: CLOSED 상태인 마감일 중 tx_date 이상인 날짜가 있으면 그 거래일은 잠긴 것으로 본다.
-- (마감은 날짜순으로만 진행되므로 "가장 마지막 마감일 이하 = 잠김"과 같다.)

------------------------------------------------------------------------------
-- 거래
------------------------------------------------------------------------------

CREATE TRIGGER trg_tx_bi_closed BEFORE INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date >= NEW.tx_date)
BEGIN SELECT RAISE(ABORT, 'DATE_CLOSED'); END;

CREATE TRIGGER trg_tx_bi_start BEFORE INSERT ON transactions
WHEN NOT EXISTS (SELECT 1 FROM parish_settings WHERE id = 1 AND start_date <= NEW.tx_date)
BEGIN SELECT RAISE(ABORT, 'BEFORE_START_DATE'); END;

CREATE TRIGGER trg_tx_bi_status BEFORE INSERT ON transactions
WHEN NEW.status <> 'POSTED'
BEGIN SELECT RAISE(ABORT, 'INVALID_STATUS'); END;

CREATE TRIGGER trg_tx_bi_account BEFORE INSERT ON transactions
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND is_active = 1)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_INACTIVE'); END;

CREATE TRIGGER trg_tx_bi_subject BEFORE INSERT ON transactions
WHEN NEW.kind = 'NORMAL' AND NOT EXISTS (
  SELECT 1 FROM budget_subjects
  WHERE id = NEW.subject_id AND is_active = 1
    AND kind = CASE NEW.direction WHEN 'IN' THEN 'INCOME' ELSE 'EXPENSE' END
)
BEGIN SELECT RAISE(ABORT, 'SUBJECT_MISMATCH'); END;

-- 수정 거래는 반드시 이미 취소된 원본을 가리켜야 한다 (같은 batch 안에서 원본 취소 → 새 거래 순서)
CREATE TRIGGER trg_tx_bi_replaces BEFORE INSERT ON transactions
WHEN NEW.replaces_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM transactions WHERE id = NEW.replaces_id AND status = 'VOIDED'
)
BEGIN SELECT RAISE(ABORT, 'REPLACES_NOT_VOIDED'); END;

-- 허용되는 UPDATE는 POSTED → VOIDED (취소 정보 기록) 하나뿐
CREATE TRIGGER trg_tx_bu_immutable BEFORE UPDATE ON transactions
WHEN OLD.status <> 'POSTED' OR NEW.status <> 'VOIDED'
  OR NEW.id             IS NOT OLD.id
  OR NEW.tx_date        IS NOT OLD.tx_date
  OR NEW.kind           IS NOT OLD.kind
  OR NEW.direction      IS NOT OLD.direction
  OR NEW.account_id     IS NOT OLD.account_id
  OR NEW.subject_id     IS NOT OLD.subject_id
  OR NEW.transfer_group IS NOT OLD.transfer_group
  OR NEW.amount         IS NOT OLD.amount
  OR NEW.memo           IS NOT OLD.memo
  OR NEW.voucher_no     IS NOT OLD.voucher_no
  OR NEW.replaces_id    IS NOT OLD.replaces_id
  OR NEW.created_at     IS NOT OLD.created_at
  OR NEW.created_by     IS NOT OLD.created_by
BEGIN SELECT RAISE(ABORT, 'TX_IMMUTABLE'); END;

CREATE TRIGGER trg_tx_bu_closed BEFORE UPDATE ON transactions
WHEN EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date >= OLD.tx_date)
BEGIN SELECT RAISE(ABORT, 'DATE_CLOSED'); END;

CREATE TRIGGER trg_tx_bd BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'TX_NO_DELETE'); END;

------------------------------------------------------------------------------
-- 일 마감
------------------------------------------------------------------------------

-- 마감은 날짜순: 이전 날짜에 아직 잠기지 않은 거래가 있으면 마감 불가
CREATE TRIGGER trg_close_bi_order BEFORE INSERT ON daily_closings
WHEN NEW.status = 'CLOSED' AND EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.tx_date < NEW.close_date
    AND NOT EXISTS (SELECT 1 FROM daily_closings c
                    WHERE c.status = 'CLOSED' AND c.close_date >= t.tx_date)
)
BEGIN SELECT RAISE(ABORT, 'CLOSE_ORDER'); END;

-- 이미 더 뒤 날짜까지 마감된 상태에서 앞 날짜를 마감하는 것은 무의미하므로 차단
CREATE TRIGGER trg_close_bi_locked BEFORE INSERT ON daily_closings
WHEN EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date > NEW.close_date)
BEGIN SELECT RAISE(ABORT, 'ALREADY_LOCKED'); END;

CREATE TRIGGER trg_close_bi_status BEFORE INSERT ON daily_closings
WHEN NEW.status <> 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'CLOSING_INVALID'); END;

-- UPDATE는 상태 전환(CLOSED ↔ REOPENED)만 허용
CREATE TRIGGER trg_close_bu_shape BEFORE UPDATE ON daily_closings
WHEN NEW.close_date <> OLD.close_date OR NEW.status = OLD.status
BEGIN SELECT RAISE(ABORT, 'CLOSING_INVALID'); END;

-- 마감취소는 가장 마지막 마감일부터 역순으로만
CREATE TRIGGER trg_close_bu_reopen BEFORE UPDATE ON daily_closings
WHEN OLD.status = 'CLOSED' AND NEW.status = 'REOPENED' AND EXISTS (
  SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date > OLD.close_date
)
BEGIN SELECT RAISE(ABORT, 'REOPEN_NOT_LATEST'); END;

-- 재마감 시에도 날짜순 규칙 동일 적용
CREATE TRIGGER trg_close_bu_reclose_order BEFORE UPDATE ON daily_closings
WHEN OLD.status = 'REOPENED' AND NEW.status = 'CLOSED' AND EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.tx_date < NEW.close_date
    AND NOT EXISTS (SELECT 1 FROM daily_closings c
                    WHERE c.status = 'CLOSED' AND c.close_date >= t.tx_date)
)
BEGIN SELECT RAISE(ABORT, 'CLOSE_ORDER'); END;

CREATE TRIGGER trg_close_bu_reclose_locked BEFORE UPDATE ON daily_closings
WHEN OLD.status = 'REOPENED' AND NEW.status = 'CLOSED' AND EXISTS (
  SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date > NEW.close_date
)
BEGIN SELECT RAISE(ABORT, 'ALREADY_LOCKED'); END;

CREATE TRIGGER trg_close_bd BEFORE DELETE ON daily_closings
BEGIN SELECT RAISE(ABORT, 'CLOSING_NO_DELETE'); END;

------------------------------------------------------------------------------
-- 이력 테이블: 추가만 가능
------------------------------------------------------------------------------

CREATE TRIGGER trg_closing_events_bu BEFORE UPDATE ON closing_events
BEGIN SELECT RAISE(ABORT, 'LOG_IMMUTABLE'); END;
CREATE TRIGGER trg_closing_events_bd BEFORE DELETE ON closing_events
BEGIN SELECT RAISE(ABORT, 'LOG_IMMUTABLE'); END;
CREATE TRIGGER trg_audit_bu BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'LOG_IMMUTABLE'); END;
CREATE TRIGGER trg_audit_bd BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'LOG_IMMUTABLE'); END;

------------------------------------------------------------------------------
-- 설정 데이터 보호
------------------------------------------------------------------------------

-- 마감된 날짜가 하나라도 있으면 초기잔액 변경 불가 (과거 결산서가 달라지므로)
CREATE TRIGGER trg_accounts_bu_opening BEFORE UPDATE OF opening_balance ON accounts
WHEN NEW.opening_balance IS NOT OLD.opening_balance
  AND EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED')
BEGIN SELECT RAISE(ABORT, 'OPENING_LOCKED'); END;

-- 거래가 있는 통장은 회계 구분 변경·삭제 불가 (비활성화만 허용)
CREATE TRIGGER trg_accounts_bu_fund BEFORE UPDATE OF fund_id ON accounts
WHEN NEW.fund_id IS NOT OLD.fund_id
  AND EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_IN_USE'); END;

CREATE TRIGGER trg_accounts_bd BEFORE DELETE ON accounts
WHEN EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_IN_USE'); END;

-- 사용된 과목은 수입/지출 구분 변경·삭제 불가 (비활성화만 허용)
CREATE TRIGGER trg_subjects_bu_kind BEFORE UPDATE OF kind ON budget_subjects
WHEN NEW.kind IS NOT OLD.kind
  AND EXISTS (SELECT 1 FROM transactions WHERE subject_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'SUBJECT_IN_USE'); END;

CREATE TRIGGER trg_subjects_bd BEFORE DELETE ON budget_subjects
WHEN EXISTS (SELECT 1 FROM transactions WHERE subject_id = OLD.id)
  OR EXISTS (SELECT 1 FROM budget_subjects WHERE parent_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'SUBJECT_IN_USE'); END;

-- 거래가 있으면 운영 개시일 변경 불가
CREATE TRIGGER trg_settings_bu_start BEFORE UPDATE OF start_date ON parish_settings
WHEN NEW.start_date IS NOT OLD.start_date AND EXISTS (SELECT 1 FROM transactions)
BEGIN SELECT RAISE(ABORT, 'START_DATE_LOCKED'); END;

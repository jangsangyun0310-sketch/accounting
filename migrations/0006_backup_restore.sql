-- 백업·복구

-- 백업·복구 기록 (추가만 가능)
CREATE TABLE backup_log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL CHECK (action IN ('BACKUP', 'RESTORE')),
  summary TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER trg_backup_log_bu BEFORE UPDATE ON backup_log
BEGIN SELECT RAISE(ABORT, 'LOG_IMMUTABLE'); END;
CREATE TRIGGER trg_backup_log_bd BEFORE DELETE ON backup_log
BEGIN SELECT RAISE(ABORT, 'LOG_IMMUTABLE'); END;

-- 복구 세션: 복구 batch 의 처음에 1행을 넣고 끝에서 지운다 (같은 트랜잭션이라 남지 않음).
-- 데이터가 하나라도 있으면 세션을 열 수 없으므로, 아래 트리거 완화는 빈 DB 복구에만 적용된다.
CREATE TABLE restore_session (id INTEGER PRIMARY KEY CHECK (id = 1));
CREATE TRIGGER trg_restore_session_bi BEFORE INSERT ON restore_session
WHEN EXISTS (SELECT 1 FROM setup_lock) OR EXISTS (SELECT 1 FROM parish_settings)
  OR EXISTS (SELECT 1 FROM accounts) OR EXISTS (SELECT 1 FROM budget_subjects)
  OR EXISTS (SELECT 1 FROM approval_steps) OR EXISTS (SELECT 1 FROM transactions)
  OR EXISTS (SELECT 1 FROM daily_closings) OR EXISTS (SELECT 1 FROM closing_events)
  OR EXISTS (SELECT 1 FROM audit_log)
BEGIN SELECT RAISE(ABORT, 'RESTORE_NOT_EMPTY'); END;

-- 원본 그대로 넣어야 하는 행(취소된 거래, 사용중지 통장·과목의 거래, 마감취소된 날)을 막는 4개 트리거만
-- 복구 세션 중에는 건너뛴다. 마감일 잠금·마감 순서·이체 쌍 검사 등 나머지는 복구 중에도 그대로 적용.
DROP TRIGGER trg_tx_bi_status;
CREATE TRIGGER trg_tx_bi_status BEFORE INSERT ON transactions
WHEN NEW.status <> 'POSTED' AND NOT EXISTS (SELECT 1 FROM restore_session)
BEGIN SELECT RAISE(ABORT, 'INVALID_STATUS'); END;

DROP TRIGGER trg_tx_bi_account;
CREATE TRIGGER trg_tx_bi_account BEFORE INSERT ON transactions
WHEN NOT EXISTS (SELECT 1 FROM restore_session)
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND is_active = 1)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_INACTIVE'); END;

DROP TRIGGER trg_tx_bi_subject;
CREATE TRIGGER trg_tx_bi_subject BEFORE INSERT ON transactions
WHEN NEW.kind = 'NORMAL' AND NOT EXISTS (SELECT 1 FROM restore_session) AND NOT EXISTS (
  SELECT 1 FROM budget_subjects
  WHERE id = NEW.subject_id AND is_active = 1
    AND kind = CASE NEW.direction WHEN 'IN' THEN 'INCOME' ELSE 'EXPENSE' END
)
BEGIN SELECT RAISE(ABORT, 'SUBJECT_MISMATCH'); END;

DROP TRIGGER trg_close_bi_status;
CREATE TRIGGER trg_close_bi_status BEFORE INSERT ON daily_closings
WHEN NEW.status <> 'CLOSED' AND NOT EXISTS (SELECT 1 FROM restore_session)
BEGIN SELECT RAISE(ABORT, 'CLOSING_INVALID'); END;

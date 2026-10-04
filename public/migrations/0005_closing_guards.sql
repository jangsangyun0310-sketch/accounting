-- 마감 이후 과거 잔액이 바뀌는 경로 차단

-- 마감 후 새 통장은 초기잔액 0 만 허용 (돈은 거래·이체로 넣는다)
CREATE TRIGGER trg_accounts_bi_opening BEFORE INSERT ON accounts
WHEN NEW.opening_balance <> 0 AND EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED')
BEGIN SELECT RAISE(ABORT, 'OPENING_LOCKED_NEW'); END;

-- 마감 후 초기잔액이 있는 통장은 삭제 불가 (사용중지만)
CREATE TRIGGER trg_accounts_bd_opening BEFORE DELETE ON accounts
WHEN OLD.opening_balance <> 0 AND EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED')
BEGIN SELECT RAISE(ABORT, 'OPENING_LOCKED_DELETE'); END;

-- 운영 개시일은 거래뿐 아니라 마감 기록이 있어도 변경 불가
DROP TRIGGER trg_settings_bu_start;
CREATE TRIGGER trg_settings_bu_start BEFORE UPDATE OF start_date ON parish_settings
WHEN NEW.start_date IS NOT OLD.start_date
  AND (EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM daily_closings))
BEGIN SELECT RAISE(ABORT, 'START_DATE_LOCKED'); END;

-- 운영 개시일 이전 날짜는 마감 불가
CREATE TRIGGER trg_close_bi_start BEFORE INSERT ON daily_closings
WHEN NOT EXISTS (SELECT 1 FROM parish_settings WHERE id = 1 AND start_date <= NEW.close_date)
BEGIN SELECT RAISE(ABORT, 'BEFORE_START_DATE'); END;

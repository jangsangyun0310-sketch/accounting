-- 마감은 하루씩 빠짐없이 (2026-10-08): 거래가 없는 날도 직접 마감한다.
-- 마감할 수 있는 날은 "마지막 마감일 다음 날" 하나뿐이다 (마감한 적이 없으면 운영 개시일).
-- 예전에 거래 없이 뒤 날짜 마감으로 함께 잠긴 날(자동 마감)은 그대로 두고, 그 다음부터 이 규칙을 적용한다.

CREATE TRIGGER trg_close_bi_every_day BEFORE INSERT ON daily_closings
WHEN NEW.status = 'CLOSED' AND NEW.close_date <> date(COALESCE(
  (SELECT MAX(close_date) FROM daily_closings WHERE status = 'CLOSED'),
  date((SELECT start_date FROM parish_settings WHERE id = 1), '-1 day')
), '+1 day')
BEGIN SELECT RAISE(ABORT, 'CLOSE_SEQUENCE'); END;

CREATE TRIGGER trg_close_bu_every_day BEFORE UPDATE ON daily_closings
WHEN OLD.status = 'REOPENED' AND NEW.status = 'CLOSED' AND NEW.close_date <> date(COALESCE(
  (SELECT MAX(close_date) FROM daily_closings WHERE status = 'CLOSED'),
  date((SELECT start_date FROM parish_settings WHERE id = 1), '-1 day')
), '+1 day')
BEGIN SELECT RAISE(ABORT, 'CLOSE_SEQUENCE'); END;

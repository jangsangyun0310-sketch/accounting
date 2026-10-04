-- 거래 취소 기록을 남기지 않는다 (성당마다 사무장 한 명이 쓰고 외부 검토가 없음, 기록이 오히려 혼란)
--   취소 = 삭제, 수정 = 삭제 후 새로 입력(한 batch). 마감된 날짜의 거래는 여전히 삭제·수정 불가.

DROP TRIGGER trg_tx_bd;
DROP TRIGGER trg_tx_bu_immutable;
DROP TRIGGER trg_tx_bu_closed;
DROP TRIGGER trg_tx_au_transfer_void;

-- 기존 취소 기록 정리 (취소된 거래는 잔액·마감 스냅샷에 포함되지 않으므로 지워도 결산은 그대로)
UPDATE transactions SET replaces_id = NULL WHERE replaces_id IS NOT NULL;
DELETE FROM transactions WHERE status = 'VOIDED';

-- 거래 행은 직접 고치지 않는다
CREATE TRIGGER trg_tx_bu BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'TX_IMMUTABLE'); END;

-- 마감된 날짜의 거래는 삭제 불가
CREATE TRIGGER trg_tx_bd_closed BEFORE DELETE ON transactions
WHEN EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date >= OLD.tx_date)
BEGIN SELECT RAISE(ABORT, 'DATE_CLOSED'); END;

-- 이체 한쪽을 지우면 반대쪽도 함께
CREATE TRIGGER trg_tx_ad_transfer AFTER DELETE ON transactions
WHEN OLD.kind = 'TRANSFER'
BEGIN DELETE FROM transactions WHERE transfer_group = OLD.transfer_group; END;

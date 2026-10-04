-- 거래 수정·이체 무결성 보강

-- 한 원본 거래에는 수정 거래가 하나만 존재 (동시에 두 번 수정되는 것 방지)
CREATE UNIQUE INDEX ux_tx_replaces ON transactions (replaces_id) WHERE replaces_id IS NOT NULL;

-- 이체 묶음은 출금 1건 + 입금 1건
CREATE UNIQUE INDEX ux_tx_transfer_direction ON transactions (transfer_group, direction)
  WHERE transfer_group IS NOT NULL;

-- 이체 묶음의 두 거래는 날짜·금액이 같고 통장이 달라야 한다
CREATE TRIGGER trg_tx_bi_transfer_pair BEFORE INSERT ON transactions
WHEN NEW.kind = 'TRANSFER' AND EXISTS (
  SELECT 1 FROM transactions
  WHERE transfer_group = NEW.transfer_group
    AND (tx_date <> NEW.tx_date OR amount <> NEW.amount OR account_id = NEW.account_id)
)
BEGIN SELECT RAISE(ABORT, 'TRANSFER_MISMATCH'); END;

-- 이체 한쪽이 취소되면 반대쪽도 함께 취소 (같은 사유·시각·사용자)
CREATE TRIGGER trg_tx_au_transfer_void AFTER UPDATE OF status ON transactions
WHEN NEW.kind = 'TRANSFER' AND NEW.status = 'VOIDED' AND OLD.status = 'POSTED'
BEGIN
  UPDATE transactions
     SET status = 'VOIDED', void_reason = NEW.void_reason, voided_at = NEW.voided_at, voided_by = NEW.voided_by
   WHERE transfer_group = NEW.transfer_group AND id <> NEW.id AND status = 'POSTED';
END;

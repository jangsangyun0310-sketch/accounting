-- 비품대장 (2026-10-12): 종이 대장처럼 올린 다음 날부터는 고치지 않는다 (올린 날은 고칠 수 있음, 한국 시간).
--   품명 · 규격 · 수량 · 구매일자 · 구매금액 · 구매처는 다음 날부터 잠긴다 (트리거).
--   둘 곳 · 비고는 언제든 바꿀 수 있다 (물건을 옮길 때). 바뀐 기록은 audit_log 에 남는다.
--   폐기 = 폐기일자 · 사유를 적는다 (줄은 남고 합계에서 빠짐). 삭제 = 잘못 올린 줄에 빨간 두 줄 (실제로 지우지 않음).
--   폐기 · 삭제한 줄은 더 바꿀 수 없다. 행을 지우는 것은 막는다.
-- 지출 과목에 is_equipment 를 켜 두면 거래 입력에서 그 과목으로 지출할 때 비품대장에도 올릴 수 있다 (tx_id 로 이어짐).
ALTER TABLE budget_subjects ADD COLUMN is_equipment INTEGER NOT NULL DEFAULT 0 CHECK (is_equipment IN (0, 1));

CREATE TABLE equipment (
  id             INTEGER PRIMARY KEY,
  item_no        TEXT    NOT NULL UNIQUE,              -- 관리번호: 구매연도-순번 (예 2026-007)
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 50),
  spec           TEXT    NOT NULL DEFAULT '' CHECK (length(spec) <= 60),
  quantity       INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  purchase_date  TEXT    NOT NULL CHECK (date(purchase_date) = purchase_date),
  price          INTEGER NOT NULL CHECK (price >= 0),
  vendor         TEXT    NOT NULL DEFAULT '' CHECK (length(vendor) <= 40),
  location       TEXT    NOT NULL DEFAULT '' CHECK (length(location) <= 40),
  note           TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  tx_id          INTEGER,                              -- 이어진 지출 거래 (거래가 지워지면 NULL)
  disposed_at    TEXT    CHECK (disposed_at IS NULL OR (date(disposed_at) = disposed_at AND disposed_at >= purchase_date)),
  dispose_reason TEXT    NOT NULL DEFAULT '' CHECK (length(dispose_reason) <= 100),
  deleted_at     TEXT    CHECK (deleted_at IS NULL OR date(deleted_at) = deleted_at),
  delete_reason  TEXT    NOT NULL DEFAULT '' CHECK (length(delete_reason) <= 100),
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  updated_by     TEXT    NOT NULL,
  CHECK (disposed_at IS NULL OR deleted_at IS NULL)
);
CREATE INDEX ix_equipment_tx ON equipment (tx_id);

CREATE TRIGGER trg_equipment_bd BEFORE DELETE ON equipment
BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_NO_DELETE'); END;

CREATE TRIGGER trg_equipment_bu_locked BEFORE UPDATE ON equipment
WHEN NEW.id IS NOT OLD.id OR NEW.item_no IS NOT OLD.item_no
  OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
  OR ((NEW.name IS NOT OLD.name OR NEW.spec IS NOT OLD.spec OR NEW.quantity IS NOT OLD.quantity
       OR NEW.purchase_date IS NOT OLD.purchase_date OR NEW.price IS NOT OLD.price OR NEW.vendor IS NOT OLD.vendor)
      AND date(OLD.created_at, '+9 hours') < date('now', '+9 hours'))
  OR (NEW.tx_id IS NOT OLD.tx_id AND NEW.tx_id IS NOT NULL)
  OR ((OLD.disposed_at IS NOT NULL OR OLD.deleted_at IS NOT NULL) AND (
       NEW.location IS NOT OLD.location OR NEW.note IS NOT OLD.note OR NEW.disposed_at IS NOT OLD.disposed_at OR NEW.dispose_reason IS NOT OLD.dispose_reason
       OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.delete_reason IS NOT OLD.delete_reason))
BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOCKED'); END;

-- 비품 사진 · 영수증: 브라우저가 줄인 JPEG 를 data URL 로 (사목일지 사진처럼 장부 백업 파일에는 넣지 않는다)
CREATE TABLE equipment_photos (
  id           INTEGER PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment (id),
  image        TEXT    NOT NULL CHECK (image GLOB 'data:image/jpeg;base64,*' AND length(image) <= 1500000),
  created_at   TEXT    NOT NULL,
  created_by   TEXT    NOT NULL
);
CREATE INDEX ix_equipment_photos_item ON equipment_photos (equipment_id, id);

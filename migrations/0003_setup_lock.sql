-- 최초 설정은 한 번만 실행되도록 잠금 행을 둔다.
-- 설정 batch 의 첫 문장이 이 행을 INSERT 하므로, 동시에 두 번 실행되어도 두 번째는 통째로 실패한다.
CREATE TABLE setup_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TRIGGER trg_setup_lock_bu BEFORE UPDATE ON setup_lock
BEGIN SELECT RAISE(ABORT, 'SETUP_DONE'); END;
CREATE TRIGGER trg_setup_lock_bd BEFORE DELETE ON setup_lock
BEGIN SELECT RAISE(ABORT, 'SETUP_DONE'); END;

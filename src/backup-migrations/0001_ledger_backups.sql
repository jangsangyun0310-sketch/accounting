-- 서버 자동 백업 (매일 새벽, 성당별 장부 전체)
-- 장부 백업 자료(JSON)를 gzip 으로 줄여 1MB 조각으로 나눠 둔다 (D1 한 값 2MB 제한).
CREATE TABLE ledger_backups (
  parish_id   TEXT    NOT NULL,
  backup_date TEXT    NOT NULL,               -- 한국 날짜 YYYY-MM-DD
  created_at  TEXT    NOT NULL,
  json_size   INTEGER NOT NULL,               -- 압축 전 크기 (byte)
  checksum    TEXT    NOT NULL,               -- 백업 자료 안의 검사값 (복구할 때 다시 확인)
  counts      TEXT    NOT NULL,               -- 표별 행 수 (JSON)
  chunks      INTEGER NOT NULL,
  PRIMARY KEY (parish_id, backup_date)
);

CREATE TABLE ledger_backup_chunks (
  parish_id   TEXT    NOT NULL,
  backup_date TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  data        BLOB    NOT NULL,
  PRIMARY KEY (parish_id, backup_date, seq)
);

-- 사목일지 6. 사진 (2026-10-11): 하루 2장까지 (자리 1 = 왼쪽, 2 = 오른쪽).
-- 브라우저가 줄인 JPEG 를 data URL 글자로 저장한다. 크기가 커서 장부 백업 파일에는 넣지 않는다.
CREATE TABLE journal_photos (
  journal_date TEXT    NOT NULL CHECK (date(journal_date) = journal_date),
  slot         INTEGER NOT NULL CHECK (slot IN (1, 2)),
  image        TEXT    NOT NULL CHECK (image GLOB 'data:image/jpeg;base64,*' AND length(image) <= 1500000),
  caption      TEXT    NOT NULL DEFAULT '' CHECK (length(caption) <= 60),
  updated_at   TEXT    NOT NULL,
  updated_by   TEXT    NOT NULL,
  PRIMARY KEY (journal_date, slot)
);

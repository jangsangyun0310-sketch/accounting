-- 사목일지 4. 공문서 수발신 (2026-10-11): 그날 받거나 보낸 공문서. 구분이 비어 있어도 된다
CREATE TABLE journal_documents (
  journal_date TEXT    NOT NULL REFERENCES journals (journal_date) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 50),
  direction    TEXT    NOT NULL DEFAULT '' CHECK (direction IN ('', 'IN', 'OUT')), -- 수신 · 발신
  doc_no       TEXT    NOT NULL DEFAULT '' CHECK (length(doc_no) <= 30),            -- 문서번호
  party        TEXT    NOT NULL DEFAULT '' CHECK (length(party) <= 40),             -- 보낸 곳 · 받는 곳
  title        TEXT    NOT NULL DEFAULT '' CHECK (length(title) <= 100),            -- 제목
  PRIMARY KEY (journal_date, seq)
);

-- 함께 쓰는 사람: 성당 하나에 여러 사용자 (모두 같은 권한)
-- 아직 로그인하지 않은 사람의 등록. 그 이메일의 구글 계정으로 처음 로그인하면 성당에 연결되고 이 행은 지워진다.
-- 한 이메일은 한 성당에만 등록할 수 있다 (사용자는 성당 하나에만 속한다).
CREATE TABLE invites (
  email      TEXT PRIMARY KEY CHECK (email = lower(email)),
  parish_id  TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX invites_parish ON invites(parish_id);

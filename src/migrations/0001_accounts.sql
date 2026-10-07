-- 본당살림 서비스 계정: 성당과 로그인 사용자, 로그인 세션
-- (장부 자료는 2단계에서 성당별로 따로 저장한다)

CREATE TABLE parishes (
  id         TEXT PRIMARY KEY,                 -- 무작위 ID
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 50),
  created_at TEXT NOT NULL
);

-- 구글 계정 하나 = 사용자 하나. 가입 직후에는 성당이 없다(parish_id NULL) → 성당 등록 화면
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,          -- 구글 계정 고유번호 (이메일은 바뀔 수 있음)
  email         TEXT NOT NULL,
  name          TEXT,
  parish_id     TEXT REFERENCES parishes(id),
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);
CREATE INDEX users_parish ON users(parish_id);

-- 로그인 세션. 쿠키에는 무작위 토큰, 여기에는 그 해시만 둔다 (DB 가 새어도 세션을 훔칠 수 없게)
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

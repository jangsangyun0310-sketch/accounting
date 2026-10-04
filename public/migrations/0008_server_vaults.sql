-- [서버 전용] 성당별 암호화 보관함
-- 서버는 암호문과 확인용 해시만 가진다. 암호를 푸는 열쇠는 각 성당 브라우저에서 비밀번호로만 만들어진다.
-- (파일 이름의 _server_ : 브라우저 엔진은 이 마이그레이션을 적용하지 않는다)

CREATE TABLE vaults (
  id              TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 64),
  kdf             TEXT    NOT NULL,              -- JSON: 열쇠 만드는 방법(알고리즘·반복 횟수·salt). 비밀이 아님
  auth_hash       TEXT    NOT NULL,              -- 확인용 열쇠의 SHA-256 (암호화 열쇠와는 다른 값)
  version         INTEGER NOT NULL CHECK (version >= 1),
  size            INTEGER NOT NULL,
  chunks          INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- 암호문 조각 (D1 한 행 2MB 제한 때문에 1MB 씩 나눠 저장)
CREATE TABLE vault_chunks (
  vault_id TEXT    NOT NULL REFERENCES vaults (id),
  version  INTEGER NOT NULL,
  idx      INTEGER NOT NULL,
  data     BLOB    NOT NULL,
  PRIMARY KEY (vault_id, version, idx)
);

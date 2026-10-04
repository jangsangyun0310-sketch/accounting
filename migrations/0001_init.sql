-- 본당살림 기본 스키마
-- 원칙
--  * 금액은 모두 원 단위 INTEGER. typeof 검사로 실수(REAL)·문자열 저장을 차단한다.
--  * 날짜는 'YYYY-MM-DD'(한국 시간 기준) 문자열. date(x) = x 검사로 형식을 강제한다.
--  * 기록 시각(*_at)은 UTC ISO-8601 문자열.
--  * 잔액은 저장하지 않는다. 초기잔액 + POSTED 거래 합계로 계산한다.

-- 성당 기본 설정 (항상 1행)
CREATE TABLE parish_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  parish_name     TEXT    NOT NULL CHECK (length(trim(parish_name)) > 0),
  start_date      TEXT    NOT NULL CHECK (date(start_date) = start_date), -- 운영 개시일 (초기잔액 기준일)
  writer_name     TEXT    NOT NULL DEFAULT '',                            -- 결산서 기본 작성자
  setup_completed INTEGER NOT NULL DEFAULT 0 CHECK (setup_completed IN (0, 1)),
  updated_at      TEXT    NOT NULL,
  updated_by      TEXT    NOT NULL
);

-- 회계 구분 (구조상 고정: 일반회계 / 특별회계)
CREATE TABLE funds (
  id         INTEGER PRIMARY KEY,
  code       TEXT    NOT NULL UNIQUE CHECK (code IN ('GENERAL', 'SPECIAL')),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL
);
INSERT INTO funds (id, code, name, sort_order) VALUES
  (1, 'GENERAL', '일반회계', 1),
  (2, 'SPECIAL', '특별회계', 2);

-- 통장
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY,
  fund_id         INTEGER NOT NULL REFERENCES funds (id),
  name            TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  bank_name       TEXT    NOT NULL DEFAULT '',
  account_no      TEXT    NOT NULL DEFAULT '',
  opening_balance INTEGER NOT NULL DEFAULT 0
                  CHECK (typeof(opening_balance) = 'integer' AND opening_balance >= 0),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  updated_by      TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_accounts_name ON accounts (name);

-- 예산과목 (관/항/목 계층을 parent_id로 표현)
CREATE TABLE budget_subjects (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('INCOME', 'EXPENSE')),
  parent_id  INTEGER REFERENCES budget_subjects (id),
  code       TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  updated_by TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_subjects_name ON budget_subjects (kind, ifnull(parent_id, 0), name);

-- 결재 단계 (seq 순서대로 결재란에 출력)
CREATE TABLE approval_steps (
  seq   INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 10),
  title TEXT    NOT NULL CHECK (length(trim(title)) > 0)
);

-- 거래 (한 번 기록되면 내용 불변. 수정 = 취소 + 새 거래, 삭제 = 취소)
--  kind = NORMAL   : 일반 수입·지출. 예산과목 필수
--  kind = TRANSFER : 통장 간 이체. 같은 transfer_group 의 OUT 1건 + IN 1건 한 쌍
CREATE TABLE transactions (
  id             INTEGER PRIMARY KEY,
  tx_date        TEXT    NOT NULL CHECK (date(tx_date) = tx_date),
  kind           TEXT    NOT NULL DEFAULT 'NORMAL' CHECK (kind IN ('NORMAL', 'TRANSFER')),
  direction      TEXT    NOT NULL CHECK (direction IN ('IN', 'OUT')),
  account_id     INTEGER NOT NULL REFERENCES accounts (id),
  subject_id     INTEGER REFERENCES budget_subjects (id),
  transfer_group TEXT,
  amount         INTEGER NOT NULL
                 CHECK (typeof(amount) = 'integer' AND amount > 0 AND amount <= 1000000000000),
  memo           TEXT    NOT NULL DEFAULT '',
  voucher_no     TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOIDED')),
  replaces_id    INTEGER REFERENCES transactions (id), -- 수정으로 생성된 경우 원본 거래
  void_reason    TEXT,
  voided_at      TEXT,
  voided_by      TEXT,
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL,
  CHECK (
    (kind = 'NORMAL'   AND subject_id IS NOT NULL AND transfer_group IS NULL) OR
    (kind = 'TRANSFER' AND subject_id IS NULL     AND transfer_group IS NOT NULL)
  ),
  CHECK (
    (status = 'POSTED' AND voided_at IS NULL AND voided_by IS NULL) OR
    (status = 'VOIDED' AND voided_at IS NOT NULL AND voided_by IS NOT NULL
                       AND length(trim(ifnull(void_reason, ''))) > 0)
  )
);
CREATE INDEX ix_tx_account_date ON transactions (account_id, tx_date) WHERE status = 'POSTED';
CREATE INDEX ix_tx_date ON transactions (tx_date);
CREATE INDEX ix_tx_transfer ON transactions (transfer_group) WHERE transfer_group IS NOT NULL;

-- 일 마감 현재 상태 (날짜당 1행, 삭제 불가)
CREATE TABLE daily_closings (
  close_date        TEXT PRIMARY KEY CHECK (date(close_date) = close_date),
  status            TEXT NOT NULL CHECK (status IN ('CLOSED', 'REOPENED')),
  approval_snapshot TEXT NOT NULL, -- JSON: 마감 시점 결재선
  balance_snapshot  TEXT NOT NULL, -- JSON: 마감 시점 통장별 잔액
  writer_name       TEXT NOT NULL,
  closed_at         TEXT NOT NULL,
  closed_by         TEXT NOT NULL,
  reopened_at       TEXT,
  reopened_by       TEXT,
  reopen_reason     TEXT,
  CHECK (status = 'CLOSED' OR length(trim(ifnull(reopen_reason, ''))) > 0)
);

-- 마감·마감취소 이력 (추가만 가능)
CREATE TABLE closing_events (
  id         INTEGER PRIMARY KEY,
  close_date TEXT NOT NULL CHECK (date(close_date) = close_date),
  action     TEXT NOT NULL CHECK (action IN ('CLOSE', 'REOPEN')),
  reason     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL
);
CREATE INDEX ix_closing_events_date ON closing_events (close_date);

-- 감사 로그 (추가만 가능)
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  entity      TEXT    NOT NULL,
  entity_id   TEXT,
  action      TEXT    NOT NULL,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);

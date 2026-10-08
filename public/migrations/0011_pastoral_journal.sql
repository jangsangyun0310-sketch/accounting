-- 사목일지 (2026-10-09): 날마다 신자 현황 · 미사 · 성사 · 특이사항을 적는다. 회계는 그날 마감 내용을 불러온다.
-- 숫자는 1년 통계를 내기 위해 모두 정수 칸에 둔다.

-- 하루 한 장. 총원(세대·인원)이 NULL 이면 자동(전날 총원 + 전입 − 전출), 값이 있으면 직접 고친 총원
CREATE TABLE journals (
  journal_date     TEXT    PRIMARY KEY CHECK (date(journal_date) = journal_date),
  households_in    INTEGER NOT NULL DEFAULT 0 CHECK (households_in BETWEEN 0 AND 100000),
  households_out   INTEGER NOT NULL DEFAULT 0 CHECK (households_out BETWEEN 0 AND 100000),
  households_total INTEGER          CHECK (households_total IS NULL OR households_total BETWEEN 0 AND 10000000),
  members_in       INTEGER NOT NULL DEFAULT 0 CHECK (members_in BETWEEN 0 AND 100000),
  members_out      INTEGER NOT NULL DEFAULT 0 CHECK (members_out BETWEEN 0 AND 100000),
  members_total    INTEGER          CHECK (members_total IS NULL OR members_total BETWEEN 0 AND 10000000),
  baptism          INTEGER NOT NULL DEFAULT 0 CHECK (baptism BETWEEN 0 AND 100000),      -- 세례
  confirmation     INTEGER NOT NULL DEFAULT 0 CHECK (confirmation BETWEEN 0 AND 100000), -- 견진
  anointing        INTEGER NOT NULL DEFAULT 0 CHECK (anointing BETWEEN 0 AND 100000),    -- 병자
  marriage         INTEGER NOT NULL DEFAULT 0 CHECK (marriage BETWEEN 0 AND 100000),     -- 혼인
  funeral          INTEGER NOT NULL DEFAULT 0 CHECK (funeral BETWEEN 0 AND 100000),      -- 장례
  communion        INTEGER NOT NULL DEFAULT 0 CHECK (communion BETWEEN 0 AND 100000),    -- 봉성체
  notes            TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),             -- 특이사항
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL
);

-- 그날의 미사 (구분: 주일·평일·혼배·장례·특별)
CREATE TABLE journal_masses (
  journal_date TEXT    NOT NULL REFERENCES journals (journal_date) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 50),
  mass_time    TEXT    NOT NULL DEFAULT '' CHECK (mass_time = '' OR mass_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  name         TEXT    NOT NULL DEFAULT '' CHECK (length(name) <= 30),
  kind         TEXT    NOT NULL CHECK (kind IN ('SUNDAY', 'WEEKDAY', 'WEDDING', 'FUNERAL', 'SPECIAL')),
  attendance   INTEGER NOT NULL DEFAULT 0 CHECK (attendance BETWEEN 0 AND 1000000),
  confessions  INTEGER NOT NULL DEFAULT 0 CHECK (confessions BETWEEN 0 AND 1000000),
  PRIMARY KEY (journal_date, seq)
);

-- 요일별 기본 미사 (weekday 0 = 주일, 6 = 토요일). 사목일지를 처음 열면 이 미사들이 채워진다
CREATE TABLE mass_schedule (
  id        INTEGER PRIMARY KEY,
  weekday   INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  mass_time TEXT    NOT NULL CHECK (mass_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  name      TEXT    NOT NULL DEFAULT '' CHECK (length(name) <= 30),
  kind      TEXT    NOT NULL CHECK (kind IN ('SUNDAY', 'WEEKDAY', 'WEDDING', 'FUNERAL', 'SPECIAL'))
);

-- 사목일지를 시작할 때의 총원
CREATE TABLE journal_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  start_households INTEGER NOT NULL DEFAULT 0 CHECK (start_households BETWEEN 0 AND 10000000),
  start_members    INTEGER NOT NULL DEFAULT 0 CHECK (start_members BETWEEN 0 AND 10000000),
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL
);

-- 일일결산·사목일지 결재선 (비어 있으면 월말·연말 결재선 approval_steps 를 그대로 쓴다)
CREATE TABLE daily_approval_steps (
  seq   INTEGER PRIMARY KEY,
  title TEXT    NOT NULL
);

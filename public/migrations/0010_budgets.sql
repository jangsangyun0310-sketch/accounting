-- 예산 대비 집행 (2026-10-08): 해마다 과목별 예산액
-- 과목을 지우면(거래가 없어야 지울 수 있다) 그 과목의 예산도 함께 지운다.
CREATE TABLE budgets (
  year       INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  subject_id INTEGER NOT NULL REFERENCES budget_subjects (id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL CHECK (amount > 0 AND amount = CAST(amount AS INTEGER) AND amount <= 1000000000000),
  updated_at TEXT    NOT NULL,
  updated_by TEXT    NOT NULL,
  PRIMARY KEY (year, subject_id)
);

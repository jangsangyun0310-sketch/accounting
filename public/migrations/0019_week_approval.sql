-- 주간결산서 결재란 (2026-10-19): doc_approvals 에 'week' 를 받도록 표를 다시 만든다 (CHECK 는 고칠 수 없어서).
-- 지금 있는 결재란은 그대로 옮기고, 주간결산서는 처음에 결산서(월말결산서) 결재란과 같게 둔다.
CREATE TABLE doc_approvals_new (
  doc    TEXT PRIMARY KEY CHECK (doc IN ('journal', 'daily', 'month', 'year', 'budget', 'accounts', 'donors', 'week')),
  titles TEXT NOT NULL CHECK (json_valid(titles) AND json_type(titles) = 'array' AND json_array_length(titles) <= 10)
);
INSERT INTO doc_approvals_new (doc, titles) SELECT doc, titles FROM doc_approvals;
INSERT OR IGNORE INTO doc_approvals_new (doc, titles) SELECT 'week', titles FROM doc_approvals WHERE doc = 'month';
DROP TABLE doc_approvals;
ALTER TABLE doc_approvals_new RENAME TO doc_approvals;

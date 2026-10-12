-- 서류별 결재란 (2026-10-13): 사목일지 · 일일결산 · 월말결산 · 연말결산 · 예산 대비 · 통장별 내역 · 개인별 납부
-- titles = 결재 칸 직함 JSON 배열. [] 이면 그 서류에는 결재란을 넣지 않는다.
-- 예전 결재선(approval_steps = 월말·연말·예산, daily_approval_steps = 사목일지)은 지우지 않고 처음 값으로만 옮긴다.
-- (서버 장부는 UNION 을 길게 이을 수 없어서 서류마다 한 줄씩 넣는다)
CREATE TABLE doc_approvals (
  doc    TEXT PRIMARY KEY CHECK (doc IN ('journal', 'daily', 'month', 'year', 'budget', 'accounts', 'donors')),
  titles TEXT NOT NULL CHECK (json_valid(titles) AND json_type(titles) = 'array' AND json_array_length(titles) <= 10)
);

INSERT INTO doc_approvals (doc, titles) SELECT 'journal', CASE WHEN EXISTS (SELECT 1 FROM daily_approval_steps)
  THEN (SELECT json_group_array(title) FROM (SELECT title FROM daily_approval_steps ORDER BY seq))
  ELSE (SELECT json_group_array(title) FROM (SELECT title FROM approval_steps ORDER BY seq)) END;
INSERT INTO doc_approvals (doc, titles) SELECT 'daily', titles FROM doc_approvals WHERE doc = 'journal';
INSERT INTO doc_approvals (doc, titles) SELECT 'month', (SELECT json_group_array(title) FROM (SELECT title FROM approval_steps ORDER BY seq));
INSERT INTO doc_approvals (doc, titles) SELECT 'year', titles FROM doc_approvals WHERE doc = 'month';
INSERT INTO doc_approvals (doc, titles) SELECT 'budget', titles FROM doc_approvals WHERE doc = 'month';
INSERT INTO doc_approvals (doc, titles) VALUES ('accounts', '[]'), ('donors', '[]');

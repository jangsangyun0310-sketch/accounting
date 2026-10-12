// 서류별 결재란 (doc_approvals). titles 가 빈 배열이면 그 서류에는 결재란이 없다.

/** 결재란을 따로 두는 서류 */
export const APPROVAL_DOCS = ['journal', 'daily', 'month', 'year', 'budget', 'accounts', 'donors'];

/** 처음 설정할 때: 받은 결재선을 사목일지 · 결산서에 넣고, 통장별 내역 · 개인별 납부는 결재란 없이 */
export const DEFAULT_EMPTY_DOCS = ['accounts', 'donors'];

const MAIN_SQL = '(SELECT json_group_array(title) FROM (SELECT title FROM approval_steps ORDER BY seq))';
const JOURNAL_SQL = `(CASE WHEN EXISTS (SELECT 1 FROM daily_approval_steps)
  THEN (SELECT json_group_array(title) FROM (SELECT title FROM daily_approval_steps ORDER BY seq)) ELSE ${MAIN_SQL} END)`;

/**
 * 예전 결재선으로 서류별 결재란을 채우는 SQL 문들 (0018 마이그레이션과 같은 규칙).
 * 이 표가 없던 예전 백업을 복구한 뒤에 쓴다. 이미 있는 서류는 그대로 둔다.
 * (서버 장부는 UNION 을 길게 이을 수 없어서 서류마다 한 문장)
 */
export const DERIVE_DOC_APPROVALS_SQL = APPROVAL_DOCS.map((doc) => {
  const value = DEFAULT_EMPTY_DOCS.includes(doc) ? "'[]'" : doc === 'journal' || doc === 'daily' ? JOURNAL_SQL : MAIN_SQL;
  return `INSERT OR IGNORE INTO doc_approvals (doc, titles) SELECT '${doc}', ${value}`;
});

/** 일일결산 결재란 JSON 배열 — 마감 기록에 남기는 SQL 조각 */
export const DAILY_APPROVAL_SNAPSHOT_SQL = `COALESCE((SELECT titles FROM doc_approvals WHERE doc = 'daily'), '[]')`;

/** 한 서류의 결재 칸 직함 목록 */
export async function approvalOf(db, doc) {
  const titles = await db.prepare('SELECT titles FROM doc_approvals WHERE doc = ?').bind(doc).first('titles');
  return titles ? JSON.parse(titles) : [];
}

/** 모든 서류의 결재란 { doc: [직함] } */
export async function allApprovals(db) {
  const { results } = await db.prepare('SELECT doc, titles FROM doc_approvals').all();
  const map = Object.fromEntries(results.map((r) => [r.doc, JSON.parse(r.titles)]));
  return Object.fromEntries(APPROVAL_DOCS.map((d) => [d, map[d] ?? []]));
}

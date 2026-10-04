// 최초 설정: 성당 정보·통장·과목·결재선을 한 번에 저장한다 (전부 성공 또는 전부 실패)
import { ApiError, json, readJson } from '../lib/http.js';
import { auditStatement } from '../lib/db.js';
import {
  accountInput, approvalTitles, array, noDuplicates, parishInput, subjectInput,
} from '../lib/validate.js';

export function validateSetup(body) {
  const parish = parishInput(body?.parish);
  const accounts = array(body?.accounts, '통장', { min: 1, max: 100 }).map(accountInput);
  noDuplicates(accounts.map((a) => a.name), '통장명');
  const subjects = array(body?.subjects, '예산과목', { min: 2, max: 300 }).map(subjectInput);
  for (const kind of ['INCOME', 'EXPENSE']) {
    const names = subjects.filter((s) => s.kind === kind).map((s) => s.name);
    if (names.length === 0) {
      throw new ApiError(400, 'INVALID_INPUT', `${kind === 'INCOME' ? '수입' : '지출'} 과목을 1개 이상 입력하세요.`);
    }
    noDuplicates(names, kind === 'INCOME' ? '수입 과목' : '지출 과목');
  }
  return { parish, accounts, subjects, approvalSteps: approvalTitles(body?.approvalSteps) };
}

export async function runSetup({ request, env, actor }) {
  const input = validateSetup(await readJson(request));
  const db = env.DB;

  const state = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM setup_lock) AS locked,
            (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM budget_subjects)
          + (SELECT COUNT(*) FROM approval_steps) + (SELECT COUNT(*) FROM transactions) AS existing`
  ).first();
  if (state.locked > 0) throw new ApiError(409, 'SETUP_DONE', '최초 설정이 이미 완료되었습니다. 변경은 설정 화면에서 하세요.');
  if (state.existing > 0) throw new ApiError(409, 'SETUP_NOT_EMPTY', '이미 입력된 데이터가 있어 최초 설정을 진행할 수 없습니다.');

  const now = new Date().toISOString();
  const by = actor.email;
  const fundId = { GENERAL: 1, SPECIAL: 2 };
  const order = { GENERAL: 0, SPECIAL: 0, INCOME: 0, EXPENSE: 0 };
  const { parish } = input;

  const statements = [
    // 첫 문장: 잠금. 이미 설정된 경우 여기서 batch 전체가 실패한다.
    db.prepare('INSERT INTO setup_lock (id, created_at, created_by) VALUES (1, ?, ?)').bind(now, by),
    db.prepare(
      `INSERT INTO parish_settings (id, parish_name, start_date, writer_name, setup_completed, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, 1, ?4, ?5)
       ON CONFLICT (id) DO UPDATE SET parish_name = ?1, start_date = ?2, writer_name = ?3,
         setup_completed = 1, updated_at = ?4, updated_by = ?5`
    ).bind(parish.parishName, parish.startDate, parish.writerName, now, by),
    ...input.accounts.map((a) => db.prepare(
      `INSERT INTO accounts (fund_id, name, bank_name, account_no, opening_balance, sort_order,
                             created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7, ?8)`
    ).bind(fundId[a.fundCode], a.name, a.bankName, a.accountNo, a.openingBalance, ++order[a.fundCode], now, by)),
    ...input.subjects.map((s) => db.prepare(
      `INSERT INTO budget_subjects (kind, name, sort_order, created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?5)`
    ).bind(s.kind, s.name, ++order[s.kind], now, by)),
    ...input.approvalSteps.map((title, i) =>
      db.prepare('INSERT INTO approval_steps (seq, title) VALUES (?, ?)').bind(i + 1, title)),
    auditStatement(db, { actor: by, entity: 'setup', entityId: 1, action: 'SETUP', after: input }),
  ];
  await db.batch(statements);
  return json({ ok: true });
}

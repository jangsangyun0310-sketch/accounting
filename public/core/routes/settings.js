// 설정 조회·변경: 성당 정보, 통장, 예산과목, 결재선
// 모든 변경은 감사 로그와 같은 batch 로 저장한다.
import { ApiError, json, readJson } from '../lib/http.js';
import { auditRowStatement, auditStatement, readRowJson } from '../lib/db.js';
import {
  accountInput, approvalTitles, array, bool, id as parseId, noDuplicates, oneOf, parishInput,
  subjectInput, text, FUND_CODES, SUBJECT_KINDS,
} from '../lib/validate.js';

import { count, massTime, MASS_KINDS } from './journal.js';

const FUND_ID = { GENERAL: 1, SPECIAL: 2 };

export async function getSettings({ env }) {
  const db = env.DB;
  const [parish, funds, accounts, subjects, steps, flags, dailySteps, schedule, journalStart] = await db.batch([
    db.prepare('SELECT parish_name, start_date, writer_name, setup_completed FROM parish_settings WHERE id = 1'),
    db.prepare('SELECT id, code, name FROM funds ORDER BY sort_order'),
    db.prepare(
      `SELECT a.id, f.code AS fund_code, a.name, a.bank_name, a.account_no, a.opening_balance,
              a.sort_order, a.is_active,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count
       FROM accounts a JOIN funds f ON f.id = a.fund_id
       ORDER BY f.sort_order, a.sort_order, a.id`
    ),
    db.prepare(
      `SELECT s.id, s.kind, s.parent_id, s.code, s.name, s.sort_order, s.is_active,
              (SELECT COUNT(*) FROM transactions t WHERE t.subject_id = s.id) AS tx_count
       FROM budget_subjects s ORDER BY s.kind DESC, s.sort_order, s.id`
    ),
    db.prepare('SELECT seq, title FROM approval_steps ORDER BY seq'),
    db.prepare(
      `SELECT EXISTS (SELECT 1 FROM transactions) AS has_tx,
              EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED') AS has_closed`
    ),
    db.prepare('SELECT seq, title FROM daily_approval_steps ORDER BY seq'),
    db.prepare('SELECT id, weekday, mass_time, name, kind FROM mass_schedule ORDER BY weekday, mass_time, id'),
    db.prepare('SELECT start_households, start_members FROM journal_settings WHERE id = 1'),
  ]);
  const p = parish.results[0] ?? null;
  const f = flags.results[0];
  return json({
    setupCompleted: p ? p.setup_completed === 1 : false,
    parish: p && { parishName: p.parish_name, startDate: p.start_date, writerName: p.writer_name },
    funds: funds.results,
    accounts: accounts.results.map((a) => ({
      id: a.id, fundCode: a.fund_code, name: a.name, bankName: a.bank_name, accountNo: a.account_no,
      openingBalance: a.opening_balance, sortOrder: a.sort_order, isActive: a.is_active === 1, txCount: a.tx_count,
    })),
    subjects: subjects.results.map((s) => ({
      id: s.id, kind: s.kind, parentId: s.parent_id, code: s.code, name: s.name,
      sortOrder: s.sort_order, isActive: s.is_active === 1, txCount: s.tx_count,
    })),
    approvalSteps: steps.results,
    // 일일결산·사목일지 결재선. 비어 있으면 approvalSteps 를 그대로 쓴다
    dailyApprovalSteps: dailySteps.results,
    massSchedule: schedule.results.map((m) => ({ id: m.id, weekday: m.weekday, time: m.mass_time, name: m.name, kind: m.kind })),
    journalStart: {
      households: journalStart.results[0]?.start_households ?? 0,
      members: journalStart.results[0]?.start_members ?? 0,
      saved: Boolean(journalStart.results[0]),
    },
    // 화면에서 잠긴 항목을 미리 안내하기 위한 정보 (실제 차단은 DB 트리거)
    locks: { startDate: f.has_tx === 1, openingBalance: f.has_closed === 1 },
  });
}

async function requireSetup(db) {
  const done = await db.prepare('SELECT setup_completed FROM parish_settings WHERE id = 1').first('setup_completed');
  if (done !== 1) throw new ApiError(409, 'SETUP_REQUIRED', '최초 설정을 먼저 완료하세요.');
}

async function requireRow(db, table, id, label) {
  const before = await readRowJson(db, table, id);
  if (before == null) throw new ApiError(404, 'NOT_FOUND', `${label}을(를) 찾을 수 없습니다.`);
  return before;
}

// ---- 성당 정보 ----

export async function updateParish({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const input = parishInput(await readJson(request));
  const before = await readRowJson(db, 'parish_settings', 1);
  await db.batch([
    db.prepare(
      `UPDATE parish_settings SET parish_name = ?, start_date = ?, writer_name = ?, updated_at = ?, updated_by = ?
       WHERE id = 1`
    ).bind(input.parishName, input.startDate, input.writerName, new Date().toISOString(), actor.email),
    auditRowStatement(db, { actor: actor.email, action: 'UPDATE', table: 'parish_settings', id: 1, beforeJson: before }),
  ]);
  return json({ ok: true });
}

// ---- 통장 ----

export async function createAccount({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const a = accountInput(await readJson(request));
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO accounts (fund_id, name, bank_name, account_no, opening_balance, sort_order,
                             created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts WHERE fund_id = ?1),
               ?6, ?7, ?6, ?7)`
    ).bind(FUND_ID[a.fundCode], a.name, a.bankName, a.accountNo, a.openingBalance, now, actor.email),
    auditRowStatement(db, { actor: actor.email, action: 'CREATE', table: 'accounts', id: 'last' }),
  ]);
  return json({ ok: true }, 201);
}

export async function updateAccount({ request, env, actor, params }) {
  const db = env.DB;
  await requireSetup(db);
  const id = parseId(params.id, '통장 번호');
  const body = await readJson(request);
  const a = accountInput(body);
  const isActive = bool(body.isActive, '사용 여부');
  const before = await requireRow(db, 'accounts', id, '통장');
  await db.batch([
    db.prepare(
      `UPDATE accounts SET fund_id = ?, name = ?, bank_name = ?, account_no = ?, opening_balance = ?,
              is_active = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`
    ).bind(FUND_ID[a.fundCode], a.name, a.bankName, a.accountNo, a.openingBalance, isActive ? 1 : 0,
      new Date().toISOString(), actor.email, id),
    auditRowStatement(db, { actor: actor.email, action: 'UPDATE', table: 'accounts', id, beforeJson: before }),
  ]);
  return json({ ok: true });
}

export async function deleteAccount({ env, actor, params }) {
  const db = env.DB;
  await requireSetup(db);
  const id = parseId(params.id, '통장 번호');
  const before = await requireRow(db, 'accounts', id, '통장');
  await db.batch([
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
    auditStatement(db, { actor: actor.email, entity: 'accounts', entityId: id, action: 'DELETE', before: JSON.parse(before) }),
  ]);
  return json({ ok: true });
}

export async function reorderAccounts({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const body = await readJson(request);
  const fundCode = oneOf(body?.fundCode, FUND_CODES, '회계 구분');
  const ids = await validateReorder(db, body?.ids, 'SELECT id FROM accounts WHERE fund_id = ?', FUND_ID[fundCode]);
  await db.batch(reorderStatements(db, 'accounts', ids, { actor: actor.email, group: fundCode }));
  return json({ ok: true });
}

// ---- 예산과목 ----

export async function createSubject({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const s = subjectInput(await readJson(request));
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO budget_subjects (kind, name, sort_order, created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM budget_subjects WHERE kind = ?1),
               ?3, ?4, ?3, ?4)`
    ).bind(s.kind, s.name, now, actor.email),
    auditRowStatement(db, { actor: actor.email, action: 'CREATE', table: 'budget_subjects', id: 'last' }),
  ]);
  return json({ ok: true }, 201);
}

export async function updateSubject({ request, env, actor, params }) {
  const db = env.DB;
  await requireSetup(db);
  const id = parseId(params.id, '과목 번호');
  const body = await readJson(request);
  const s = subjectInput(body);
  const isActive = bool(body.isActive, '사용 여부');
  const before = await requireRow(db, 'budget_subjects', id, '과목');
  await db.batch([
    db.prepare(
      `UPDATE budget_subjects SET kind = ?, name = ?, is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?`
    ).bind(s.kind, s.name, isActive ? 1 : 0, new Date().toISOString(), actor.email, id),
    auditRowStatement(db, { actor: actor.email, action: 'UPDATE', table: 'budget_subjects', id, beforeJson: before }),
  ]);
  return json({ ok: true });
}

export async function deleteSubject({ env, actor, params }) {
  const db = env.DB;
  await requireSetup(db);
  const id = parseId(params.id, '과목 번호');
  const before = await requireRow(db, 'budget_subjects', id, '과목');
  await db.batch([
    db.prepare('DELETE FROM budget_subjects WHERE id = ?').bind(id),
    auditStatement(db, { actor: actor.email, entity: 'budget_subjects', entityId: id, action: 'DELETE', before: JSON.parse(before) }),
  ]);
  return json({ ok: true });
}

export async function reorderSubjects({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const body = await readJson(request);
  const kind = oneOf(body?.kind, SUBJECT_KINDS, '수입/지출 구분');
  const ids = await validateReorder(db, body?.ids, 'SELECT id FROM budget_subjects WHERE kind = ?', kind);
  await db.batch(reorderStatements(db, 'budget_subjects', ids, { actor: actor.email, group: kind }));
  return json({ ok: true });
}

// ---- 결재선 ----

export async function updateApprovalSteps({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const titles = approvalTitles((await readJson(request))?.titles);
  const { results: before } = await db.prepare('SELECT seq, title FROM approval_steps ORDER BY seq').all();
  await db.batch([
    db.prepare('DELETE FROM approval_steps'),
    ...titles.map((t, i) => db.prepare('INSERT INTO approval_steps (seq, title) VALUES (?, ?)').bind(i + 1, t)),
    auditStatement(db, {
      actor: actor.email, entity: 'approval_steps', entityId: null, action: 'UPDATE',
      before: before.map((s) => s.title), after: titles,
    }),
  ]);
  return json({ ok: true });
}

/** 일일결산·사목일지 결재선 (월말·연말과 따로) */
export async function updateDailyApprovalSteps({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const titles = approvalTitles((await readJson(request))?.titles);
  const { results: before } = await db.prepare('SELECT seq, title FROM daily_approval_steps ORDER BY seq').all();
  await db.batch([
    db.prepare('DELETE FROM daily_approval_steps'),
    ...titles.map((t, i) => db.prepare('INSERT INTO daily_approval_steps (seq, title) VALUES (?, ?)').bind(i + 1, t)),
    auditStatement(db, {
      actor: actor.email, entity: 'daily_approval_steps', entityId: null, action: 'UPDATE',
      before: before.map((s) => s.title), after: titles,
    }),
  ]);
  return json({ ok: true });
}

// ---- 사목일지: 요일별 기본 미사 · 시작 총원 ----

export async function updateMassSchedule({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const items = array((await readJson(request))?.items, '기본 미사', { max: 100 }).map((m, i) => {
    const weekday = Number(m?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new ApiError(400, 'INVALID_INPUT', `${i + 1}번째 줄의 요일이 올바르지 않습니다.`);
    return {
      weekday,
      time: massTime(m?.time, `${i + 1}번째 줄의 시간`, { required: true }),
      name: text(m?.name, `${i + 1}번째 줄의 미사 이름`, { max: 30, required: false }),
      kind: oneOf(m?.kind, MASS_KINDS, `${i + 1}번째 줄의 구분`),
    };
  });
  const { results: before } = await db.prepare('SELECT weekday, mass_time, name, kind FROM mass_schedule ORDER BY weekday, mass_time, id').all();
  await db.batch([
    db.prepare('DELETE FROM mass_schedule'),
    ...items.map((m) => db.prepare('INSERT INTO mass_schedule (weekday, mass_time, name, kind) VALUES (?, ?, ?, ?)')
      .bind(m.weekday, m.time, m.name, m.kind)),
    auditStatement(db, { actor: actor.email, entity: 'mass_schedule', entityId: null, action: 'UPDATE', before, after: items }),
  ]);
  return json({ ok: true, count: items.length });
}

export async function updateJournalSettings({ request, env, actor }) {
  const db = env.DB;
  await requireSetup(db);
  const body = await readJson(request);
  const households = count(body?.households, '시작 세대 수', 10000000);
  const members = count(body?.members, '시작 인원', 10000000);
  const before = await db.prepare('SELECT start_households, start_members FROM journal_settings WHERE id = 1').first();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO journal_settings (id, start_households, start_members, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET start_households = excluded.start_households, start_members = excluded.start_members,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(households, members, now, actor.email),
    auditStatement(db, { actor: actor.email, entity: 'journal_settings', entityId: 1, action: 'UPDATE', before, after: { households, members } }),
  ]);
  return json({ ok: true });
}

// ---- 공용: 순서 변경 ----

/** 요청한 id 목록이 해당 그룹의 전체 id 와 정확히 같은지 확인 */
async function validateReorder(db, rawIds, sql, groupValue) {
  const ids = array(rawIds, '순서', { min: 1, max: 300 }).map((v) => parseId(v));
  noDuplicates(ids, '번호');
  const { results } = await db.prepare(sql).bind(groupValue).all();
  const existing = new Set(results.map((r) => r.id));
  if (existing.size !== ids.length || ids.some((v) => !existing.has(v))) {
    throw new ApiError(409, 'STALE', '목록이 변경되었습니다. 화면을 새로고침한 뒤 다시 시도하세요.');
  }
  return ids;
}

function reorderStatements(db, table, ids, { actor, group }) {
  return [
    ...ids.map((id, i) => db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).bind(i + 1, id)),
    auditStatement(db, { actor, entity: table, entityId: null, action: 'REORDER', after: { group, ids } }),
  ];
}

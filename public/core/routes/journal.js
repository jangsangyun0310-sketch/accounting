// 사목일지
//   GET /api/journal?date=YYYY-MM-DD : 그날의 사목일지 (저장 전이면 요일별 기본 미사로 채운 빈 일지)
//   PUT /api/journal {date, households, members, masses, sacraments, notes} : 그날 사목일지를 통째로 저장
// 회계 부분은 화면이 /api/reports/daily 로 따로 불러온다 (마감한 날만 보여 준다).
// 총원: 직접 고친 값(households_total·members_total)이 없으면 전날 총원 + 전입 − 전출.
//       첫 날의 전날 총원은 설정의 시작 총원.
import { json, readJson } from '../lib/http.js';
import { auditStatement } from '../lib/db.js';
import { array, bad, date as parseDate, oneOf, text } from '../lib/validate.js';
import { isValidDate, todayKST } from '../../js/shared/dates.js';

export const MASS_KINDS = ['SUNDAY', 'WEEKDAY', 'WEDDING', 'FUNERAL', 'SPECIAL'];
export const SACRAMENTS = ['baptism', 'confirmation', 'anointing', 'marriage', 'funeral', 'communion'];

/** 일일결산·사목일지 결재선 JSON 배열 (따로 정하지 않았으면 월말·연말 결재선) — 마감 기록에 남기는 SQL 조각 */
export const DAILY_APPROVAL_SNAPSHOT_SQL = `(CASE WHEN EXISTS (SELECT 1 FROM daily_approval_steps)
  THEN (SELECT json_group_array(title) FROM (SELECT title FROM daily_approval_steps ORDER BY seq))
  ELSE (SELECT json_group_array(title) FROM (SELECT title FROM approval_steps ORDER BY seq)) END)`;

export async function dailyApprovalSteps(db) {
  const { results } = await db.prepare(
    `SELECT title FROM (SELECT title, seq, 0 AS g FROM daily_approval_steps
       UNION ALL SELECT title, seq, 1 FROM approval_steps WHERE NOT EXISTS (SELECT 1 FROM daily_approval_steps))
     ORDER BY g, seq`
  ).all();
  return results.map((r) => r.title);
}

/** 0 이상 정수 (빈칸·null 은 0) */
export function count(value, label, max = 100000) {
  if (value == null || value === '') return 0;
  const n = typeof value === 'string' && /^\s*[\d,]+\s*$/.test(value) ? Number(value.replace(/[,\s]/g, '')) : value;
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw bad(`${label}은(는) 0 이상 ${max.toLocaleString('ko-KR')} 이하의 숫자로 입력하세요.`, 'BAD_COUNT');
  return n;
}

export function massTime(value, label, { required = false } = {}) {
  const v = text(value, label, { max: 5, required });
  if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${label}은(는) 06:00 처럼 시:분으로 입력하세요.`, 'BAD_TIME');
  return v;
}

/** 그 날짜 전날까지의 총원 {households, members}: 시작 총원에서 하루씩 (직접 고친 날은 그 값으로) */
async function totalsBefore(db, date) {
  const [start, rows] = await db.batch([
    db.prepare('SELECT start_households, start_members FROM journal_settings WHERE id = 1'),
    db.prepare(
      `SELECT households_in, households_out, households_total, members_in, members_out, members_total
       FROM journals WHERE journal_date < ? ORDER BY journal_date`
    ).bind(date),
  ]);
  let households = start.results[0]?.start_households ?? 0;
  let members = start.results[0]?.start_members ?? 0;
  for (const r of rows.results) {
    households = r.households_total ?? households + r.households_in - r.households_out;
    members = r.members_total ?? members + r.members_in - r.members_out;
  }
  return { households, members };
}

const weekdayOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

export async function get({ env, url }) {
  const db = env.DB;
  const d = url.searchParams.get('date') || todayKST();
  if (!isValidDate(d)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  const [journal, masses, schedule, parish] = await db.batch([
    db.prepare('SELECT * FROM journals WHERE journal_date = ?').bind(d),
    db.prepare('SELECT mass_time, name, kind, attendance, confessions FROM journal_masses WHERE journal_date = ? ORDER BY seq').bind(d),
    db.prepare('SELECT mass_time, name, kind FROM mass_schedule WHERE weekday = ? ORDER BY mass_time, id').bind(weekdayOf(d)),
    db.prepare('SELECT parish_name, writer_name FROM parish_settings WHERE id = 1'),
  ]);
  const j = journal.results[0] ?? null;
  const prev = await totalsBefore(db, d);
  const row = (r, extra = {}) => ({ time: r.mass_time, name: r.name, kind: r.kind, attendance: 0, confessions: 0, ...extra });
  return json({
    date: d,
    saved: Boolean(j),
    parishName: parish.results[0]?.parish_name ?? '',
    writerName: parish.results[0]?.writer_name ?? '',
    approvalSteps: await dailyApprovalSteps(db),
    // 전날 총원: 화면이 전날 총원 + 전입 − 전출을 바로 계산해 보여 준다
    households: { prev: prev.households, in: j?.households_in ?? 0, out: j?.households_out ?? 0, total: j?.households_total ?? null },
    members: { prev: prev.members, in: j?.members_in ?? 0, out: j?.members_out ?? 0, total: j?.members_total ?? null },
    masses: j
      ? masses.results.map((r) => row(r, { attendance: r.attendance, confessions: r.confessions }))
      : schedule.results.map((r) => row(r)),
    sacraments: Object.fromEntries(SACRAMENTS.map((k) => [k, j?.[k] ?? 0])),
    notes: j?.notes ?? '',
    updatedAt: j?.updated_at ?? null,
  });
}

function totalsInput(v, label) {
  return {
    in: count(v?.in, `${label} 전입`),
    out: count(v?.out, `${label} 전출`),
    total: v?.total == null || v.total === '' ? null : count(v.total, `${label} 현재 총원`, 10000000),
  };
}

export async function save({ request, env, actor }) {
  const db = env.DB;
  const body = await readJson(request);
  const d = parseDate(body?.date, '사목일지');
  const households = totalsInput(body?.households, '세대');
  const members = totalsInput(body?.members, '인원');
  const masses = array(body?.masses ?? [], '미사', { max: 50 }).map((m, i) => ({
    time: massTime(m?.time, `${i + 1}번째 미사 시간`),
    name: text(m?.name, `${i + 1}번째 미사 이름`, { max: 30, required: false }),
    kind: oneOf(m?.kind, MASS_KINDS, `${i + 1}번째 미사 구분`),
    attendance: count(m?.attendance, `${i + 1}번째 미사 참석 인원`, 1000000),
    confessions: count(m?.confessions, `${i + 1}번째 미사 고해성사`, 1000000),
  }));
  const sacraments = Object.fromEntries(SACRAMENTS.map((k) => [k, count(body?.sacraments?.[k], '성사 건수')]));
  const notes = typeof body?.notes === 'string' ? body.notes.replace(/\r\n/g, '\n').trim() : '';
  if (notes.length > 5000) throw bad('특이사항은 5,000자 이내로 입력하세요.');

  const now = new Date().toISOString();
  const cols = ['households_in', 'households_out', 'households_total', 'members_in', 'members_out', 'members_total', ...SACRAMENTS, 'notes'];
  const values = [households.in, households.out, households.total, members.in, members.out, members.total,
    ...SACRAMENTS.map((k) => sacraments[k]), notes];
  const existed = await db.prepare('SELECT 1 FROM journals WHERE journal_date = ?').bind(d).first();
  await db.batch([
    db.prepare(
      `INSERT INTO journals (journal_date, ${cols.join(', ')}, updated_at, updated_by)
       VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)
       ON CONFLICT (journal_date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(d, ...values, now, actor.email),
    db.prepare('DELETE FROM journal_masses WHERE journal_date = ?').bind(d),
    ...masses.map((m, i) => db.prepare(
      `INSERT INTO journal_masses (journal_date, seq, mass_time, name, kind, attendance, confessions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(d, i + 1, m.time, m.name, m.kind, m.attendance, m.confessions)),
    auditStatement(db, {
      actor: actor.email, entity: 'journals', entityId: d, action: existed ? 'UPDATE' : 'CREATE',
      after: { households, members, masses: masses.length, sacraments },
    }),
  ]);
  return json({ ok: true, updatedAt: now });
}

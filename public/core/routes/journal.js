// 사목일지
//   GET /api/journal?date=YYYY-MM-DD : 그날의 사목일지 (저장 전이면 요일별 기본 미사로 채운 빈 일지)
//   PUT /api/journal {date, households, members, masses, sacraments, documents, notes, photoCaptions} : 그날 사목일지를 통째로 저장
//   PUT /api/journal/photo {date, slot, image} : 사진 한 장 올리기 (image 가 null 이면 지우기). 고르는 즉시 저장된다
// 회계 부분은 화면이 /api/reports/daily 로 따로 불러온다 (마감한 날만 보여 준다).
// 총원: 직접 고친 값(households_total·members_total)이 없으면 전날 총원 + 전입 − 전출.
//       첫 날의 전날 총원은 설정의 시작 총원.
import { json, readJson } from '../lib/http.js';
import { auditStatement } from '../lib/db.js';
import { array, bad, date as parseDate, oneOf, text } from '../lib/validate.js';
import { addDays, isValidDate, todayKST } from '../../js/shared/dates.js';

export const MASS_KINDS = ['SUNDAY', 'WEEKDAY', 'WEDDING', 'FUNERAL', 'SPECIAL'];
export const DOC_DIRECTIONS = ['', 'IN', 'OUT']; // 공문서 구분: (비움) · 수신 · 발신
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

/**
 * 주일 사목일지의 주일미사 줄: 토요일 주일미사(저녁) 참석 인원과 토·일 주일헌금(봉헌권 포함, 수입 차감 전) 합계.
 * 주일의 미사 인원은 화면이 입력 중인 값으로 더한다. 주일헌금 과목은 설정 → 사목일지에서 고른다.
 */
async function sundaySummary(db, d) {
  if (weekdayOf(d) !== 0) return null;
  const sat = addDays(d, -1);
  const [att, setting] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(attendance), 0) AS n FROM journal_masses WHERE journal_date = ? AND kind = 'SUNDAY'`).bind(sat),
    db.prepare(`SELECT s.id, s.name FROM journal_settings j JOIN budget_subjects s ON s.id = j.offering_subject_id WHERE j.id = 1`),
  ]);
  const subject = setting.results[0] ?? null;
  const offering = subject ? await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM transactions
     WHERE status = 'POSTED' AND kind = 'NORMAL' AND direction = 'IN' AND subject_id = ? AND tx_date IN (?, ?)`
  ).bind(subject.id, sat, d).first('n') : 0;
  return { saturdayAttendance: att.results[0].n, offering, subjectName: subject?.name ?? null };
}

export async function get({ env, url }) {
  const db = env.DB;
  const d = url.searchParams.get('date') || todayKST();
  if (!isValidDate(d)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  const [journal, masses, documents, photos, schedule, parish] = await db.batch([
    db.prepare('SELECT * FROM journals WHERE journal_date = ?').bind(d),
    db.prepare('SELECT mass_time, name, kind, attendance, confessions FROM journal_masses WHERE journal_date = ? ORDER BY seq').bind(d),
    db.prepare('SELECT direction, doc_no, party, title FROM journal_documents WHERE journal_date = ? ORDER BY seq').bind(d),
    db.prepare('SELECT slot, image, caption FROM journal_photos WHERE journal_date = ? ORDER BY slot').bind(d),
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
    documents: documents.results.map((r) => ({ direction: r.direction, docNo: r.doc_no, party: r.party, title: r.title })),
    photos: photos.results.map((r) => ({ slot: r.slot, image: r.image, caption: r.caption })),
    notes: j?.notes ?? '',
    sunday: await sundaySummary(db, d),
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
  // 공문서: 모든 칸이 빈 줄은 버린다
  const documents = array(body?.documents ?? [], '공문서', { max: 50 }).map((x, i) => ({
    direction: oneOf(x?.direction ?? '', DOC_DIRECTIONS, `${i + 1}번째 공문서 구분`),
    docNo: text(x?.docNo, `${i + 1}번째 공문서 문서번호`, { max: 30, required: false }),
    party: text(x?.party, `${i + 1}번째 공문서 수신·발신처`, { max: 40, required: false }),
    title: text(x?.title, `${i + 1}번째 공문서 제목`, { max: 100, required: false }),
  })).filter((x) => x.direction || x.docNo || x.party || x.title);
  const captions = [1, 2].map((slot) => ({ slot, caption: text(body?.photoCaptions?.[slot], `${slot}번째 사진 설명`, { max: 60, required: false }) }));
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
    db.prepare('DELETE FROM journal_documents WHERE journal_date = ?').bind(d),
    ...documents.map((x, i) => db.prepare(
      'INSERT INTO journal_documents (journal_date, seq, direction, doc_no, party, title) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(d, i + 1, x.direction, x.docNo, x.party, x.title)),
    ...captions.map((c) => db.prepare('UPDATE journal_photos SET caption = ? WHERE journal_date = ? AND slot = ?').bind(c.caption, d, c.slot)),
    auditStatement(db, {
      actor: actor.email, entity: 'journals', entityId: d, action: existed ? 'UPDATE' : 'CREATE',
      after: { households, members, masses: masses.length, sacraments, documents: documents.length },
    }),
  ]);
  return json({ ok: true, updatedAt: now });
}

const MAX_IMAGE = 1500000; // data URL 글자 수 (화면이 약 0.3MB 로 줄여서 보낸다)

export async function savePhoto({ request, env, actor }) {
  const db = env.DB;
  const body = await readJson(request);
  const d = parseDate(body?.date, '사진');
  const slot = oneOf(body?.slot, [1, 2], '사진 자리');
  const image = body?.image ?? null;
  if (image !== null && (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,'))) throw bad('사진 형식이 올바르지 않습니다.', 'BAD_IMAGE');
  if (image && image.length > MAX_IMAGE) throw bad('사진이 너무 큽니다.', 'IMAGE_TOO_LARGE');
  const now = new Date().toISOString();
  await db.batch([
    image === null
      ? db.prepare('DELETE FROM journal_photos WHERE journal_date = ? AND slot = ?').bind(d, slot)
      : db.prepare(
        `INSERT INTO journal_photos (journal_date, slot, image, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (journal_date, slot) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).bind(d, slot, image, now, actor.email),
    auditStatement(db, { actor: actor.email, entity: 'journal_photos', entityId: `${d}#${slot}`, action: image === null ? 'DELETE' : 'UPDATE' }),
  ]);
  return json({ ok: true });
}

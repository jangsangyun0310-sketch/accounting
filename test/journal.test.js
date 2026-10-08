// 사목일지: 요일별 기본 미사, 저장·불러오기, 총원 자동 계산과 직접 고치기, 입력 검증,
// 일일결산 결재선(월말·연말과 따로), 백업·복구 (사목일지 표가 없던 예전 백업도 복구)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, worker } from './helpers.js';
import { sha256Hex } from '../public/core/lib/backup.js';

function setup(db = createDb()) {
  const env = { DB: d1Adapter(db), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  const api = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  return { db, api };
}

const SCHEDULE = [
  { weekday: 6, time: '18:00', name: '주일미사 (학생미사)', kind: 'SUNDAY' },
  { weekday: 0, time: '10:30', name: '교중미사', kind: 'SUNDAY' },
  { weekday: 0, time: '06:00', name: '아침미사', kind: 'SUNDAY' },
  { weekday: 1, time: '06:00', name: '평일미사', kind: 'WEEKDAY' },
];

test('저장 전 사목일지는 그 요일의 기본 미사(시간순)로 채워지고, 저장하면 저장한 내용이 나온다', async () => {
  const { api } = setup();
  assert.equal((await api('PUT', '/api/mass-schedule', { items: SCHEDULE })).status, 200);
  const s = (await api('GET', '/api/settings')).body;
  assert.equal(s.massSchedule.length, 4);

  const sun = (await api('GET', '/api/journal?date=2026-10-11')).body; // 주일
  assert.equal(sun.saved, false);
  assert.deepEqual(sun.masses.map((m) => [m.time, m.name]), [['06:00', '아침미사'], ['10:30', '교중미사']]);
  assert.deepEqual((await api('GET', '/api/journal?date=2026-10-14')).body.masses, []); // 수요일: 기본 미사 없음

  const r = await api('PUT', '/api/journal', {
    date: '2026-10-11',
    households: { in: 1, out: 0 }, members: { in: '3', out: '1' },
    masses: [
      { time: '06:00', name: '아침미사', kind: 'SUNDAY', attendance: '85', confessions: 3 },
      { time: '10:30', name: '교중미사', kind: 'SUNDAY', attendance: '1,312', confessions: '' },
      { time: '14:00', name: '혼배미사', kind: 'WEDDING', attendance: 120 },
    ],
    sacraments: { anointing: 1, funeral: 1, communion: '4' },
    notes: '  교중미사 후 사목회의\r\n성전 조명 교체  ',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const j = (await api('GET', '/api/journal?date=2026-10-11')).body;
  assert.equal(j.saved, true);
  assert.deepEqual(j.masses.map((m) => [m.kind, m.attendance, m.confessions]), [['SUNDAY', 85, 3], ['SUNDAY', 1312, 0], ['WEDDING', 120, 0]]);
  assert.deepEqual(j.sacraments, { baptism: 0, confirmation: 0, anointing: 1, marriage: 0, funeral: 1, communion: 4 });
  assert.equal(j.notes, '교중미사 후 사목회의\n성전 조명 교체');

  // 미사를 모두 지우고 저장하면 기본 미사로 되돌아가지 않고 빈 채로
  await api('PUT', '/api/journal', { date: '2026-10-11', masses: [] });
  assert.deepEqual((await api('GET', '/api/journal?date=2026-10-11')).body.masses, []);
});

test('총원: 시작 총원에서 하루씩 전입 − 전출, 직접 고친 날부터는 그 값을 기준으로', async () => {
  const { api } = setup();
  await api('PUT', '/api/journal-settings', { households: '520', members: 1480 });
  await api('PUT', '/api/journal', { date: '2026-10-05', households: { in: 1 }, members: { in: 3, out: 1 } });
  await api('PUT', '/api/journal', { date: '2026-10-07', members: { out: 2 } });

  const d6 = (await api('GET', '/api/journal?date=2026-10-06')).body; // 저장 안 한 날
  assert.deepEqual([d6.households.prev, d6.members.prev], [521, 1482]);
  const d8 = (await api('GET', '/api/journal?date=2026-10-08')).body;
  assert.deepEqual([d8.households.prev, d8.members.prev], [521, 1480]);

  // 10월 6일에 인원을 직접 1,500 으로 고침 → 이후 날짜는 1,500 에서 이어서
  await api('PUT', '/api/journal', { date: '2026-10-06', members: { in: 0, out: 0, total: '1,500' } });
  const after = (await api('GET', '/api/journal?date=2026-10-08')).body;
  assert.deepEqual([after.households.prev, after.members.prev], [521, 1498]);
  assert.equal((await api('GET', '/api/journal?date=2026-10-06')).body.members.total, 1500);

  // 앞날을 고치면 뒤 날짜 총원도 따라 바뀜 (자동인 날)
  await api('PUT', '/api/journal', { date: '2026-10-05', households: { in: 2 }, members: { in: 3, out: 1 } });
  assert.equal((await api('GET', '/api/journal?date=2026-10-08')).body.households.prev, 522);
  // 시작 총원 전 첫날
  assert.deepEqual((await api('GET', '/api/journal?date=2026-10-01')).body.members.prev, 1480);
});

test('입력 검증: 숫자·시간·구분·날짜', async () => {
  const { api } = setup();
  const put = (body) => api('PUT', '/api/journal', { date: '2026-10-11', ...body });
  assert.equal((await put({ members: { in: -1 } })).body.error.code, 'BAD_COUNT');
  assert.equal((await put({ sacraments: { baptism: '1.5' } })).body.error.code, 'BAD_COUNT');
  assert.equal((await put({ masses: [{ time: '25:00', kind: 'SUNDAY' }] })).body.error.code, 'BAD_TIME');
  assert.equal((await put({ masses: [{ time: '06:00', kind: 'OTHER' }] })).status, 400);
  assert.equal((await api('PUT', '/api/journal', { date: '2026-02-30' })).status, 400);
  assert.equal((await api('GET', '/api/journal?date=abc')).body.error.code, 'BAD_DATE');
  assert.equal((await api('PUT', '/api/journal', { date: '2026-10-11', notes: 'x'.repeat(5001) })).status, 400);
  assert.equal((await api('PUT', '/api/mass-schedule', { items: [{ weekday: 7, time: '06:00', kind: 'SUNDAY' }] })).status, 400);
  assert.equal((await api('PUT', '/api/mass-schedule', { items: [{ weekday: 0, time: '', kind: 'SUNDAY' }] })).status, 400);
});

test('결재선: 일일결산·사목일지는 따로 정할 수 있고, 정하지 않았으면 월말·연말 결재선을 쓴다', async () => {
  const { api } = setup();
  const main = ['기안', '재정부회장', '사목회장', '주임신부'];
  assert.deepEqual((await api('GET', '/api/journal?date=2026-10-02')).body.approvalSteps, main);
  assert.deepEqual((await api('GET', '/api/reports/daily?date=2026-10-02')).body.approvalSteps, main);

  // 따로 정하기 전에 마감한 날은 그때 결재선 그대로
  assert.equal((await api('POST', '/api/closings/2026-10-01/close', {})).status, 200);

  assert.equal((await api('PUT', '/api/approval-steps/daily', { titles: ['주임신부'] })).status, 200);
  assert.deepEqual((await api('GET', '/api/settings')).body.dailyApprovalSteps.map((s) => s.title), ['주임신부']);
  assert.deepEqual((await api('GET', '/api/journal?date=2026-10-02')).body.approvalSteps, ['주임신부']);
  assert.deepEqual((await api('GET', '/api/reports/daily?date=2026-10-02')).body.approvalSteps, ['주임신부']);
  assert.equal((await api('POST', '/api/closings/2026-10-02/close', {})).status, 200);
  assert.deepEqual((await api('GET', '/api/reports/daily?date=2026-10-02')).body.approvalSteps, ['주임신부']);
  assert.deepEqual((await api('GET', '/api/reports/daily?date=2026-10-01')).body.approvalSteps, main);
  // 월말·연말은 그대로 여러 사람
  assert.deepEqual((await api('GET', '/api/reports/period?type=month&month=2026-10')).body.approvalSteps, main);
});

test('사목일지는 백업에 들어가고 복구되며, 사목일지 표가 없던 예전 백업도 복구된다', async () => {
  const a = setup();
  await a.api('PUT', '/api/mass-schedule', { items: SCHEDULE });
  await a.api('PUT', '/api/journal-settings', { households: 520, members: 1480 });
  await a.api('PUT', '/api/approval-steps/daily', { titles: ['주임신부'] });
  await a.api('PUT', '/api/journal', { date: '2026-10-11', members: { in: 3 }, masses: [{ time: '06:00', name: '아침미사', kind: 'SUNDAY', attendance: 85 }], notes: '메모' });
  const backup = await (await worker.fetch(new Request('http://local/api/backup'), { DB: d1Adapter(a.db), AUTH_MODE: 'dev' })).json();
  assert.equal(backup.counts.journals, 1);
  assert.equal(backup.counts.journal_masses, 1);

  const b = setup(createDb({ seed: false }));
  const restored = await b.api('POST', '/api/restore', backup);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const j = (await b.api('GET', '/api/journal?date=2026-10-11')).body;
  assert.equal(j.masses[0].attendance, 85);
  assert.equal(j.notes, '메모');
  assert.equal(j.members.prev, 1480);
  assert.deepEqual(j.approvalSteps, ['주임신부']);
  assert.equal((await b.api('GET', '/api/settings')).body.massSchedule.length, 4);

  const old = structuredClone(backup);
  for (const t of ['daily_approval_steps', 'mass_schedule', 'journal_settings', 'journals', 'journal_masses']) {
    delete old.tables[t];
    delete old.counts[t];
  }
  old.checksum = await sha256Hex(JSON.stringify(old.tables));
  const c = setup(createDb({ seed: false }));
  assert.equal((await c.api('POST', '/api/restore', old)).status, 200);
  assert.equal((await c.api('GET', '/api/journal?date=2026-10-11')).body.saved, false);
});

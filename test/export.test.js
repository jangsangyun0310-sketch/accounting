// 인수인계용 전체 자료: 거래 · 월별 결산 · 과목 합계 · 통장 · 사목일지 · 개인별 납부 · 설정, 그리고 Excel 로 만들어진다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, worker } from './helpers.js';
import { handoverSheets } from '../public/js/handover.js';
import { daySheetName, journalMonthSheets } from '../public/js/journal-book.js';
import { buildXlsx } from '../public/js/shared/xlsx.js';

test('전체 자료를 한 번에 주고, 시트로 만들 수 있다', async () => {
  const env = { DB: d1Adapter(createDb()), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  const api = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const s = (await api('GET', '/api/settings')).body;
  const date = s.parish.startDate;
  const special = s.accounts.find((a) => a.fundCode === 'SPECIAL' && a.isActive);
  const income = s.subjects.find((x) => x.kind === 'INCOME' && x.isActive);
  await api('POST', '/api/transactions', { date, direction: 'IN', accountId: special.id, subjectId: income.id, amount: 50000, payer: '홍길동' });
  await api('PUT', '/api/journal', { date, masses: [{ time: '10:30', name: '교중미사', kind: 'SUNDAY', attendance: 300 }], notes: '메모' });

  const r = await api('GET', '/api/export/all');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.from, date);
  assert.ok(d.transactions.length >= 1);
  assert.ok(d.monthly.length >= 1);
  const last = d.monthly.at(-1);
  assert.equal(last.total.end, d.accounts.reduce((n, a) => n + a.balance, 0)); // 마지막 달 잔액 = 통장 잔액 합계
  assert.equal(d.journals[0].notes, '메모');
  assert.equal(d.masses[0].attendance, 300);
  assert.deepEqual(d.donors.map((x) => [x.payer, x.amount]), [['홍길동', 50000]]);

  const sheets = handoverSheets(d);
  assert.deepEqual(sheets.map((x) => x.name).filter((n) => !n.startsWith('과목별')),
    ['안내', '거래 내역', '월별 결산', '통장 · 현금', '사목일지', '개인별 납부', '설정']);
  assert.ok(buildXlsx(sheets).length > 1000);
});

// 아주 작은 JPEG (1×1, 흰 점) — 사진이 Excel 안에 들어가는지 본다
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('날짜별 사목일지: 그달 사목일지 · 거래가 있는 날만, 하루에 시트 한 장 (1쪽 / 2쪽, 사진)', async () => {
  const env = { DB: d1Adapter(createDb()), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  const api = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const s = (await api('GET', '/api/settings')).body;
  const date = s.parish.startDate;
  const month = date.slice(0, 7);
  const general = s.accounts.find((a) => a.fundCode === 'GENERAL' && a.isActive);
  const income = s.subjects.find((x) => x.kind === 'INCOME' && x.isActive);
  await api('PUT', '/api/journal', { date, masses: [{ time: '10:30', name: '교중미사', kind: 'SUNDAY', attendance: 300 }], notes: '첫날' });
  assert.equal((await api('PUT', '/api/journal/photo', { date, slot: 1, image: TINY_JPEG })).status, 200);
  const next = `${month}-${String(Number(date.slice(8)) + 1).padStart(2, '0')}`;
  await api('POST', '/api/transactions', { date: next, direction: 'IN', accountId: general.id, subjectId: income.id, amount: 70000 });
  assert.equal((await api('POST', `/api/closings/${date}/close`, {})).status, 200);

  assert.equal((await api('GET', '/api/export/journals?month=2026-13')).status, 400);
  const r = await api('GET', `/api/export/journals?month=${month}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.days.map((d) => d.date), [date, next]);
  assert.equal(r.body.days[0].journal.notes, '첫날');
  assert.equal(r.body.days[0].daily.status, 'CLOSED');
  assert.equal(r.body.days[1].daily.income.total, 70000);

  const sheets = journalMonthSheets(r.body);
  assert.deepEqual(sheets.map((x) => x.name), [daySheetName(date), daySheetName(next)]);
  assert.match(sheets[0].name, /^\d\d-\d\d\([일월화수목금토]\)$/);
  assert.equal(sheets[0].images.length, 1);
  assert.equal(sheets[0].breaks.length, 1); // 1쪽 / 2쪽
  const flat = (sh) => sh.rows.flat().map((c) => c?.v).filter((v) => v != null);
  assert.ok(flat(sheets[0]).includes('6. 회계'));
  assert.ok(flat(sheets[1]).includes('이 날짜는 일 마감 전이라 회계 내용이 없습니다.'));
  const bytes = buildXlsx(sheets);
  const text = new TextDecoder('latin1').decode(bytes);
  for (const part of ['xl/drawings/drawing1.xml', 'xl/media/image1.jpeg', 'xl/worksheets/_rels/sheet1.xml.rels']) assert.ok(text.includes(part), part);
  assert.match(text, /<rowBreaks count="1"/);
});

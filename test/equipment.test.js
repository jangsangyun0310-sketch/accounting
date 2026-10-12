// 비품대장: 거래와 함께 올리기, 올린 날만 고치기, 다음 날부터 잠금, 폐기 · 삭제(두 줄), 거래 수정 · 삭제 따라가기, 사진, 백업
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, worker } from './helpers.js';

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

async function base(api) {
  const s = (await api('GET', '/api/settings')).body;
  const account = s.accounts.find((a) => a.fundCode === 'GENERAL' && a.isActive);
  const subject = s.subjects.find((x) => x.name === '시설수선비');
  const other = s.subjects.find((x) => x.name === '관리운영비');
  await api('PUT', `/api/subjects/${subject.id}`, { kind: 'EXPENSE', name: subject.name, isActive: true, isEquipment: true });
  return { date: s.parish.startDate, account, subject, other };
}

const items = async (api) => (await api('GET', '/api/equipment')).body.items;
/** 올린 시각을 어제로 돌려 "다음 날" 을 흉내 낸다 (트리거를 잠시 끄고) */
function ageItems(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_equipment_bu_locked'").get().sql;
  db.exec('DROP TRIGGER trg_equipment_bu_locked');
  db.exec("UPDATE equipment SET created_at = '2020-01-01T00:00:00.000Z'");
  db.exec(sql);
}

test('비품 과목 지출에 비품을 함께 올리고, 다른 과목이면 올리지 않는다', async () => {
  const { api } = setup();
  const b = await base(api);
  assert.equal((await api('GET', '/api/settings')).body.subjects.find((x) => x.id === b.subject.id).isEquipment, true);
  const equipment = { name: '무선마이크', spec: '슈어 BLX24', quantity: 2, vendor: 'OO음향', location: '성전' };
  const r = await api('POST', '/api/transactions', { date: b.date, direction: 'OUT', accountId: b.account.id, subjectId: b.subject.id, amount: 1250000, memo: '마이크', equipment });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await api('POST', '/api/transactions', { date: b.date, direction: 'OUT', accountId: b.account.id, subjectId: b.other.id, amount: 5000, equipment: { name: '건전지' } });
  const list = await items(api);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].itemNo, list[0].name, list[0].quantity, list[0].price, list[0].purchaseDate, list[0].txId, list[0].editable],
    [`${b.date.slice(0, 4)}-001`, '무선마이크', 2, 1250000, b.date, r.body.id, true]);
  const day = (await api('GET', `/api/day?date=${b.date}`)).body;
  assert.equal(day.transactions.find((t) => t.id === r.body.id).equipmentNo, list[0].itemNo);
});

test('직접 올리기 · 올린 날은 고치기 · 다음 날부터 둘 곳 · 비고만 · 지우기는 막힘', async () => {
  const { api, db } = setup();
  const r = await api('POST', '/api/equipment', { name: '냉난방기', spec: 'LG 40평', quantity: 3, purchaseDate: '2019-06-01', price: '7,700,000', location: '성전' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.itemNo, '2019-001');
  const second = await api('POST', '/api/equipment', { name: '탁자', quantity: 6, purchaseDate: '2019-07-01', price: 0 });
  assert.equal(second.body.itemNo, '2019-002');
  // 올린 날: 품명 · 금액도 고칠 수 있다
  const fix = await api('PUT', `/api/equipment/${r.body.id}`, { name: '냉난방기(천장형)', spec: 'LG 40평', quantity: 3, purchaseDate: '2019-06-01', price: '7,500,000', location: '성전', note: '' });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.equal((await items(api)).find((x) => x.id === r.body.id).price, 7500000);

  ageItems(db);
  // 다음 날: 품명은 그대로, 둘 곳 · 비고만 바뀐다
  await api('PUT', `/api/equipment/${r.body.id}`, { name: '바꿔도', quantity: 9, purchaseDate: '2019-06-01', price: 1, location: '교육관', note: '옮김' });
  const it = (await items(api)).find((x) => x.id === r.body.id);
  assert.deepEqual([it.name, it.quantity, it.price, it.location, it.note, it.editable], ['냉난방기(천장형)', 3, 7500000, '교육관', '옮김', false]);
  assert.throws(() => db.prepare('UPDATE equipment SET price = 1 WHERE id = ?').run(r.body.id), /EQUIPMENT_LOCKED/);
  assert.throws(() => db.prepare('DELETE FROM equipment WHERE id = ?').run(r.body.id), /EQUIPMENT_NO_DELETE/);
});

test('폐기 · 삭제: 줄은 남고 더 바꿀 수 없다, 사유는 비워도 된다', async () => {
  const { api } = setup();
  const a = (await api('POST', '/api/equipment', { name: 'PC', quantity: 1, purchaseDate: '2018-02-10', price: 900000 })).body;
  const b = (await api('POST', '/api/equipment', { name: '복합기', quantity: 1, purchaseDate: '2026-09-03', price: 2030000 })).body;
  assert.equal((await api('POST', `/api/equipment/${a.id}/dispose`, { date: '2017-01-01' })).status, 400); // 구매일 전
  assert.equal((await api('POST', `/api/equipment/${a.id}/dispose`, { date: '2026-09-03', reason: '고장' })).status, 200);
  assert.equal((await api('POST', `/api/equipment/${b.id}/delete`, {})).status, 200);
  const list = await items(api);
  const pa = list.find((x) => x.id === a.id);
  const pb = list.find((x) => x.id === b.id);
  assert.deepEqual([pa.disposedAt, pa.disposeReason, pa.editable], ['2026-09-03', '고장', false]);
  assert.ok(pb.deletedAt);
  assert.equal((await api('PUT', `/api/equipment/${a.id}`, { location: 'x' })).status, 409);
  assert.equal((await api('POST', `/api/equipment/${b.id}/delete`, { reason: '또' })).status, 409);
  assert.equal((await api('POST', `/api/equipment/${b.id}/dispose`, { date: '2026-10-01' })).status, 409);
});

test('지출 거래를 고치거나 지우면 이어진 비품이 따라간다', async () => {
  const { api, db } = setup();
  const b = await base(api);
  const tx = (await api('POST', '/api/transactions', { date: b.date, direction: 'OUT', accountId: b.account.id, subjectId: b.subject.id, amount: 100000, equipment: { name: '의자', quantity: 4 } })).body;
  const body = { date: b.date, direction: 'OUT', accountId: b.account.id, subjectId: b.subject.id, amount: 120000 };
  // 올린 날: 금액이 그대로 바뀐다
  assert.equal((await api('PUT', `/api/transactions/${tx.id}`, body)).status, 200);
  let list = await items(api);
  assert.deepEqual(list.map((x) => [x.price, Boolean(x.deletedAt)]), [[120000, false]]);
  // 다음 날: 옛 줄은 두 줄, 같은 내용으로 새 줄
  ageItems(db);
  assert.equal((await api('PUT', `/api/transactions/${tx.id}`, { ...body, amount: 130000 })).status, 200);
  list = await items(api);
  assert.equal(list.length, 2);
  const live = list.find((x) => !x.deletedAt);
  assert.deepEqual([live.name, live.quantity, live.price, live.txId], ['의자', 4, 130000, tx.id]);
  // 적요만 고치면 그대로
  assert.equal((await api('PUT', `/api/transactions/${tx.id}`, { ...body, amount: 130000, memo: '의자 4개' })).status, 200);
  assert.equal((await items(api)).length, 2);
  // 거래 삭제: 살아 있는 비품도 두 줄, 연결은 끊김
  assert.equal((await api('DELETE', `/api/transactions/${tx.id}`)).status, 200);
  list = await items(api);
  assert.ok(list.every((x) => x.deletedAt && x.txId === null));
  assert.equal(list.find((x) => x.id === live.id).deleteReason, '지출 거래 삭제');
});

test('사진 붙이기 · 떼기 (4장까지), 백업에는 비품은 들어가고 사진은 빠진다', async () => {
  const { api } = setup();
  const it = (await api('POST', '/api/equipment', { name: '성작', quantity: 1, purchaseDate: '2025-12-20', price: 850000 })).body;
  const image = 'data:image/jpeg;base64,/9j/AAAA';
  for (let i = 0; i < 4; i++) assert.equal((await api('POST', `/api/equipment/${it.id}/photos`, { image })).status, 201);
  assert.equal((await api('POST', `/api/equipment/${it.id}/photos`, { image })).status, 400);
  assert.equal((await api('POST', `/api/equipment/${it.id}/photos`, { image: 'data:image/png;base64,AA' })).status, 400);
  const { photos } = (await api('GET', `/api/equipment/${it.id}/photos`)).body;
  assert.equal(photos.length, 4);
  assert.equal((await api('DELETE', `/api/equipment/photos/${photos[0].id}`)).status, 200);
  assert.equal((await items(api))[0].photoCount, 3);

  const backup = (await api('GET', '/api/backup')).body;
  assert.equal(backup.tables.equipment.length, 1);
  assert.equal('equipment_photos' in backup.tables, false);
  // 빈 장부에 복구하면 비품도 돌아온다
  const fresh = setup(createDb({ seed: false }));
  const r = await fresh.api('POST', '/api/restore', backup);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await items(fresh.api))[0].itemNo, '2025-001');
});

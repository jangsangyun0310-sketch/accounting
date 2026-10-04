import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, sumAmounts, formatWon, MoneyError, MAX_AMOUNT } from '../public/js/shared/money.js';
import { isValidDate, addDays, todayKST, formatKoreanDate } from '../public/js/shared/dates.js';

test('parseAmount: 정상 입력', () => {
  assert.equal(parseAmount('1,000'), 1000);
  assert.equal(parseAmount(' 30000000 '), 30000000);
  assert.equal(parseAmount(5000), 5000);
  assert.equal(parseAmount('0', { allowZero: true }), 0);
  assert.equal(parseAmount(String(MAX_AMOUNT)), MAX_AMOUNT);
});

test('parseAmount: 부동소수점·음수·지수·빈값 거부', () => {
  for (const bad of ['1000.5', '1e3', '-100', '', '   ', 'abc', '0', 1.5, NaN, Infinity, -1, null, undefined]) {
    assert.throws(() => parseAmount(bad), MoneyError, `입력 ${String(bad)}`);
  }
});

test('parseAmount: 최대값 초과 거부', () => {
  assert.throws(() => parseAmount(String(MAX_AMOUNT + 1)), MoneyError);
  assert.throws(() => parseAmount('99999999999999999999'), MoneyError);
});

test('sumAmounts: 정수 합산, 비정수 거부', () => {
  assert.equal(sumAmounts([30000000, 2000000, 1000000, 600000]), 33600000);
  assert.equal(sumAmounts([]), 0);
  assert.throws(() => sumAmounts([1, 0.1]), MoneyError);
  assert.throws(() => sumAmounts([Number.MAX_SAFE_INTEGER, 1]), MoneyError);
});

test('formatWon', () => {
  assert.equal(formatWon(0), '0');
  assert.equal(formatWon(1234567), '1,234,567');
  assert.equal(formatWon(-500000), '-500,000');
  assert.equal(formatWon(999), '999');
});

test('날짜 유틸', () => {
  assert.ok(isValidDate('2026-10-04'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('2026-1-4'));
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  // UTC 2026-10-03 15:30 = KST 2026-10-04 00:30
  assert.equal(todayKST(new Date('2026-10-03T15:30:00Z')), '2026-10-04');
  assert.equal(formatKoreanDate('2026-10-04'), '2026년 10월 4일(일)');
});

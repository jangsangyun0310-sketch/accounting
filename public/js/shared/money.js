// 금액 처리 공용 모듈 (브라우저·서버 공용)
// 모든 금액은 원 단위 정수(Number.isSafeInteger)로만 다룬다. 부동소수점 연산 금지.

export const MAX_AMOUNT = 1_000_000_000_000; // 1조 원

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * 사용자 입력을 원 단위 정수로 변환한다.
 * 허용: "1,000", "1000", 1000   거부: "1000.5", "1e3", "-100", "", 1.5, NaN
 * @param {string|number} input
 * @param {{ allowZero?: boolean, max?: number }} [opts]
 */
export function parseAmount(input, { allowZero = false, max = MAX_AMOUNT } = {}) {
  let text;
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new MoneyError('금액은 원 단위 정수만 입력할 수 있습니다.');
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim().replace(/,/g, '');
  } else {
    throw new MoneyError('금액을 입력하세요.');
  }
  if (text === '') throw new MoneyError('금액을 입력하세요.');
  if (!/^\d+$/.test(text)) throw new MoneyError('금액은 숫자만 입력할 수 있습니다. (소수점·음수 불가)');
  if (text.replace(/^0+(?=\d)/, '').length > String(max).length) {
    throw new MoneyError(`금액이 너무 큽니다. (최대 ${formatWon(max)}원)`);
  }
  const value = Number(text);
  if (!allowZero && value === 0) throw new MoneyError('금액은 0보다 커야 합니다.');
  if (value > max) throw new MoneyError(`금액이 너무 큽니다. (최대 ${formatWon(max)}원)`);
  return value;
}

/** 정수 금액 합산. 중간 결과까지 안전 정수 범위를 벗어나면 예외. */
export function sumAmounts(values) {
  let total = 0;
  for (const v of values) {
    assertInteger(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError('합계가 계산 가능한 범위를 벗어났습니다.');
  }
  return total;
}

export function assertInteger(v) {
  if (!Number.isSafeInteger(v)) throw new MoneyError(`정수가 아닌 금액이 발견되었습니다: ${v}`);
  return v;
}

/** 1234567 → "1,234,567", -500 → "-500". 로케일에 의존하지 않는다. */
export function formatWon(value) {
  assertInteger(value);
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

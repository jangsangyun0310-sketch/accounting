// 서버 입력 검증. 실패 시 사용자에게 보여줄 메시지를 담은 ApiError(400)를 던진다.
import { ApiError } from './http.js';
import { parseAmount, MoneyError } from '../../public/js/shared/money.js';
import { isValidDate } from '../../public/js/shared/dates.js';

export function bad(message, code = 'INVALID_INPUT') {
  return new ApiError(400, code, message);
}

/** 앞뒤 공백 제거, 연속 공백은 하나로 */
export function text(value, label, { max = 50, required = true } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw bad(`${label} 형식이 올바르지 않습니다.`);
  const v = value.trim().replace(/\s+/g, ' ');
  if (required && !v) throw bad(`${label} 입력이 필요합니다.`);
  if (v.length > max) throw bad(`${label}은(는) ${max}자 이내로 입력하세요.`);
  return v;
}

export function date(value, label) {
  if (!isValidDate(value)) throw bad(`${label} 날짜 형식이 올바르지 않습니다.`);
  return value;
}

export function amount(value, label, { allowZero = false } = {}) {
  try {
    return parseAmount(value, { allowZero });
  } catch (e) {
    if (e instanceof MoneyError) throw bad(`${label}: ${e.message}`, 'BAD_AMOUNT');
    throw e;
  }
}

export function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw bad(`${label} 값이 올바르지 않습니다.`);
  return value;
}

export function id(value, label = '번호') {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`${label}가 올바르지 않습니다.`);
  return n;
}

export function bool(value, label) {
  if (typeof value !== 'boolean') throw bad(`${label} 값이 올바르지 않습니다.`);
  return value;
}

export function array(value, label, { min = 0, max = 200 } = {}) {
  if (!Array.isArray(value)) throw bad(`${label} 형식이 올바르지 않습니다.`);
  if (value.length < min) throw bad(`${label}을(를) ${min}개 이상 입력하세요.`);
  if (value.length > max) throw bad(`${label}은(는) ${max}개까지 입력할 수 있습니다.`);
  return value;
}

/** 목록 안에서 같은 이름이 두 번 나오면 오류 */
export function noDuplicates(names, label) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) throw bad(`${label} '${n}'이(가) 중복되었습니다.`, 'DUPLICATE');
    seen.add(n);
  }
}

// ---- 도메인별 입력 형식 (최초 설정과 설정 화면이 같이 사용) ----

export const FUND_CODES = ['GENERAL', 'SPECIAL'];
export const SUBJECT_KINDS = ['INCOME', 'EXPENSE'];
export const MAX_APPROVAL_STEPS = 10;

export function parishInput(body) {
  return {
    parishName: text(body?.parishName, '성당명', { max: 40 }),
    startDate: date(body?.startDate, '운영 개시일'),
    writerName: text(body?.writerName, '작성자', { max: 20, required: false }),
  };
}

export function accountInput(body) {
  return {
    fundCode: oneOf(body?.fundCode, FUND_CODES, '회계 구분'),
    name: text(body?.name, '통장명', { max: 30 }),
    bankName: text(body?.bankName, '은행명', { max: 30, required: false }),
    accountNo: text(body?.accountNo, '계좌번호', { max: 40, required: false }),
    openingBalance: amount(body?.openingBalance ?? '', '초기잔액', { allowZero: true }),
  };
}

export function subjectInput(body) {
  return {
    kind: oneOf(body?.kind, SUBJECT_KINDS, '수입/지출 구분'),
    name: text(body?.name, '과목명', { max: 30 }),
  };
}

export function approvalTitles(value) {
  const titles = array(value, '결재 단계', { min: 1, max: MAX_APPROVAL_STEPS })
    .map((t, i) => text(t, `${i + 1}번째 결재 단계 명칭`, { max: 12 }));
  noDuplicates(titles, '결재 단계 명칭');
  return titles;
}

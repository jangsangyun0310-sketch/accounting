// 날짜 처리 공용 모듈 (브라우저·서버 공용)
// 회계 날짜는 항상 한국 시간 기준 'YYYY-MM-DD' 문자열로 다룬다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' 형식이면서 실제 존재하는 날짜인지 */
export function isValidDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 한국 시간 기준 오늘 날짜 */
export function todayKST(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 날짜 문자열에 일수를 더한다. addDays('2026-10-01', -1) → '2026-09-30' */
export function addDays(text, days) {
  if (!isValidDate(text)) throw new Error(`잘못된 날짜: ${text}`);
  const [y, m, d] = text.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '2026-10-04' → '2026년 10월 4일(일)' */
export function formatKoreanDate(text) {
  if (!isValidDate(text)) return text;
  const [y, m, d] = text.split('-').map(Number);
  const w = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일(${w})`;
}

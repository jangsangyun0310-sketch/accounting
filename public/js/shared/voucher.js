// 증빙번호 자동 제안: 직전 번호의 마지막 숫자 부분을 1 올린다 (자릿수 유지).
// 성당마다 번호 체계가 달라도 동작하도록 형식을 강제하지 않는다.
//   '2026-015' → '2026-016',  'A-9' → 'A-10',  '099' → '100',  '영수증' → ''
export function nextVoucher(prev) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(String(prev ?? '').trim());
  if (!m) return '';
  const [, head, digits, tail] = m;
  const next = String(BigInt(digits) + 1n).padStart(digits.length, '0');
  return `${head}${next}${tail}`;
}

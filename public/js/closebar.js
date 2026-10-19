// 마감 공용 (일 마감 화면 · 거래 입력 화면의 마감 줄): 마감 확인 창, 특별회계 요약(양업 사목일지에 붙여넣기), 복사
import { href } from './base.js';
import { api, esc } from './api.js';
import { toast, signedWon } from './ui.js';
import { formatWon, sumAmounts } from './shared/money.js';
import { formatKoreanDate } from './shared/dates.js';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 특별회계 요약 글 (마감한 날, 양업 사목일지에 붙여 넣기). 특별회계 통장이 없으면 '' */
export function specialSummary(day) {
  const special = day.accounts.filter((a) => a.fundCode === 'SPECIAL');
  if (!special.length) return '';
  const fundOf = new Map(day.accounts.map((a) => [a.id, a.fundCode]));
  const [y, m, d] = day.date.split('-').map(Number);
  const w = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const list = (key) => special.filter((a) => a[key] !== 0).map((a) => `${a.name} ${formatWon(a[key])}`).join(' / ') || '없음';
  // 이체는 출금 쪽 한 줄만 (특별회계 통장이 한쪽이라도 걸린 것)
  const transfers = day.transactions.filter((t) => t.kind === 'TRANSFER' && t.direction === 'OUT'
    && (t.fundCode === 'SPECIAL' || fundOf.get(t.counterpartAccountId) === 'SPECIAL'));
  return [
    `[특별회계] ${day.date}(${w})`,
    `수입 ${formatWon(sumAmounts(special.map((a) => a.income)))}원 · 지출 ${formatWon(sumAmounts(special.map((a) => a.expense)))}원`,
    `- 수입: ${list('income')}`,
    `- 지출: ${list('expense')}`,
    ...transfers.map((t) => `- 이체: ${t.accountName}에서 ${t.counterpartName}(으)로 ${formatWon(t.amount)}원`),
    '잔액',
    ...special.map((a) => `- ${a.name} ${formatWon(a.end)}`),
    `- 합계 ${formatWon(sumAmounts(special.map((a) => a.end)))}`,
  ].join('\n');
}

/** 글을 클립보드로 (안 되면 textarea 를 골라 복사) */
export async function copyText(text, box) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    box?.select();
    document.execCommand('copy');
  }
  toast('특별회계 요약을 복사했습니다. 양업 사목일지에 붙여 넣으세요.');
}

/** 마감 확인 창 (dlg: <dialog>). 마감하면 onDone() */
export async function openCloseDialog(dlg, date, onDone) {
  const [day, settings] = await Promise.all([api(`/api/day?date=${date}`), api('/api/settings')]);
  dlg.innerHTML = `
    <h3>${formatKoreanDate(date)} 마감</h3>
    <p>마감하면 이 날짜와 그 이전 날짜의 거래를 <b>입력·수정·삭제할 수 없습니다.</b><br>
      고쳐야 할 때는 마감취소를 먼저 하면 됩니다.</p>
    <table class="grid summary">
      <thead><tr><th>구분</th><th class="num">전일잔액</th><th class="num">수입</th><th class="num">지출</th>
        <th class="num">이체</th><th class="num">당일잔액</th></tr></thead>
      <tbody>${[...day.funds, { ...day.total, name: '합계' }].map((f) => `<tr>
        <td>${esc(f.name)}</td><td class="num">${formatWon(f.prev)}</td><td class="num">${formatWon(f.income)}</td>
        <td class="num">${formatWon(f.expense)}</td><td class="num">${signedWon(f.transferIn - f.transferOut)}</td>
        <td class="num"><b>${formatWon(f.end)}</b></td></tr>`).join('')}</tbody>
    </table>
    <label>결산서 작성자 <input data-writer maxlength="20" value="${esc(settings.parish.writerName)}"></label>
    <div class="dialog-foot">
      <button type="button" class="secondary" data-cancel>닫기</button>
      <button type="button" data-confirm-close>마감</button>
    </div>`;
  dlg.showModal();
  const ok = dlg.querySelector('[data-confirm-close]');
  ok.focus();
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      await api(`/api/closings/${date}/close`, { method: 'POST', body: { writerName: dlg.querySelector('[data-writer]').value } });
      dlg.close();
      toast(`${formatKoreanDate(date)} 마감했습니다.`);
      await onDone?.();
    } catch (err) {
      toast(err.message, 'error');
      ok.disabled = false;
    }
  });
}

/**
 * 거래 입력 화면의 마감 줄: 그날 마감 상태와 할 일
 *   미마감(마감할 차례) → [이 날짜 마감하기] · 앞날이 남았으면 → [그 날로 가기] · 마감함 → [요약 복사] [일일결산서 보기]
 * info: GET /api/closings/:date, day: GET /api/day
 */
export function closeBarHtml(info, day) {
  const date = info.date;
  const closed = info.closing?.status === 'CLOSED' || (info.lastClosed && date <= info.lastClosed);
  const label = `<b>${formatKoreanDate(date)}</b>`;
  if (closed) {
    const text = specialSummary(day);
    return `${label} <span class="pill closed">마감</span>
      <span class="bar-actions">${text ? '<button type="button" class="secondary small" data-bar-copy>요약 복사</button>' : ''}
      <a class="button secondary small" href="${href(`/report?type=daily&day=${date}`)}">일일결산서 보기</a></span>`;
  }
  if (info.canClose) {
    return `${label} <span class="pill open">미마감</span>
      <span class="bar-actions"><button type="button" class="small" data-bar-close="${date}">이 날짜 마감하기</button></span>`;
  }
  if (date > info.today) return `${label} <span class="muted">미래 날짜는 마감할 수 없습니다.</span>`;
  if (date < info.startDate || !info.nextRequired) return '';
  return `${label} <span class="pill open">미마감</span>
    <span class="muted">마감은 하루씩 순서대로 합니다. 먼저 ${formatKoreanDate(info.nextRequired)}을(를) 마감하세요.</span>
    <span class="bar-actions"><button type="button" class="secondary small" data-bar-goto="${info.nextRequired}">그 날로 가기</button></span>`;
}

// 거래 이력 창: 원본부터 최신 수정본까지 모든 버전과 감사 기록을 보여준다.
import { api, esc } from './api.js';
import { toast } from './ui.js';
import { formatWon } from './shared/money.js';
import { formatDateTimeKST } from './shared/dates.js';

const ACTION_LABEL = { CREATE: '입력', VOID: '취소' };

export function typeLabel(t) {
  if (t.kind === 'TRANSFER') return t.direction === 'OUT' ? '이체출금' : '이체입금';
  return t.direction === 'IN' ? '수입' : '지출';
}

export async function openHistory(id) {
  let data;
  try {
    data = await api(`/api/transactions/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  let dialog = document.getElementById('history-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'history-dialog';
    document.body.append(dialog);
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
    });
  }
  const rows = data.versions.map((v, i) => `
    <tr class="${v.status === 'VOIDED' ? 'voided' : ''} ${v.id === id ? 'selected' : ''}">
      <td>${i === 0 ? '원본' : `수정 ${i}`}<br><span class="muted">#${v.id}</span></td>
      <td>${v.status === 'POSTED' ? '<b>유효</b>' : '취소됨'}</td>
      <td>${esc(v.date)}</td>
      <td>${typeLabel(v)}</td>
      <td>${esc(v.accountName)}${v.kind === 'TRANSFER' ? ` ${v.direction === 'OUT' ? '→' : '←'} ${esc(v.counterpartName ?? '')}` : ''}</td>
      <td>${esc(v.subjectName ?? '')}</td>
      <td class="num">${formatWon(v.amount)}</td>
      <td>${esc(v.memo)}</td>
      <td>${esc(v.voucherNo)}</td>
      <td class="small">${esc(v.createdBy)}<br>${formatDateTimeKST(v.createdAt)}</td>
      <td class="small">${v.status === 'VOIDED'
        ? `${esc(v.voidReason)}<br><span class="muted">${esc(v.voidedBy)} ${formatDateTimeKST(v.voidedAt)}</span>` : ''}</td>
    </tr>`).join('');
  const audit = data.audit.map((a) => `
    <li>${formatDateTimeKST(a.at)} · ${esc(a.actor)} · #${a.transactionId} ${ACTION_LABEL[a.action] ?? esc(a.action)}
      ${a.action === 'VOID' && a.after?.void_reason ? `(${esc(a.after.void_reason)})` : ''}</li>`).join('');
  dialog.innerHTML = `
    <div class="dialog-head"><h3>거래 이력 #${id}</h3><button type="button" class="icon" data-close title="닫기">✕</button></div>
    <div class="scroll">
      <table class="grid">
        <thead><tr><th>버전</th><th>상태</th><th>날짜</th><th>구분</th><th>통장</th><th>과목</th>
          <th class="num">금액</th><th>적요</th><th>증빙</th><th>입력</th><th>취소 사유</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <h4>기록</h4>
    <ul class="audit">${audit || '<li class="muted">기록 없음</li>'}</ul>
    <div class="dialog-foot"><button type="button" data-close>닫기</button></div>`;
  dialog.showModal();
}

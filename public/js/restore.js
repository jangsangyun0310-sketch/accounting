// 최초 설정 화면의 "백업 파일로 복구하기"
// 파일 선택 → 서버에서 미리 검증(저장 안 함) → 요약 확인 → 복구
import { api, esc } from './api.js';
import { toast } from './ui.js';
import { formatDateTimeKST, formatKoreanDate } from './shared/dates.js';

const COUNT_LABEL = {
  accounts: '통장', budget_subjects: '예산과목', transactions: '거래', daily_closings: '마감 기록', audit_log: '변경 기록',
};

export function initRestore(box, { onRestored }) {
  box.innerHTML = `
    <summary>이전에 쓰던 자료가 있나요? <b>백업 파일로 복구하기</b></summary>
    <div class="restore-body">
      <p class="help">본당살림 [설정 → 백업]에서 내려받은 파일(.json)을 고르세요. 복구하면 최초 설정은 건너뜁니다.</p>
      <input type="file" id="restore-file" accept=".json,application/json">
      <div id="restore-summary"></div>
    </div>`;
  let backup = null;

  box.querySelector('#restore-file').addEventListener('change', async (e) => {
    const out = box.querySelector('#restore-summary');
    out.innerHTML = '';
    backup = null;
    const file = e.target.files[0];
    if (!file) return;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      out.innerHTML = '<p class="error">읽을 수 없는 파일입니다. 본당살림 백업 파일(.json)을 고르세요.</p>';
      return;
    }
    out.innerHTML = '<p class="muted">파일을 검사하는 중…</p>';
    try {
      const { summary: s } = await api('/api/restore?dryRun=1', { method: 'POST', body: backup });
      out.innerHTML = `
        <dl class="summary">
          <dt>성당</dt><dd>${esc(s.parishName)}</dd>
          <dt>백업 일시</dt><dd>${formatDateTimeKST(s.exportedAt)}</dd>
          <dt>거래 기간</dt><dd>${s.firstDate ? `${formatKoreanDate(s.firstDate)} ~ ${formatKoreanDate(s.lastDate)}` : '거래 없음'}</dd>
          <dt>마지막 마감일</dt><dd>${s.lastClosed ? formatKoreanDate(s.lastClosed) : '없음'}</dd>
          <dt>자료</dt><dd>${Object.entries(COUNT_LABEL).map(([k, label]) => `${label} ${s.counts[k]}건`).join(' · ')}</dd>
        </dl>
        <p class="in">✔ 파일 검사 통과 (손상·변조 없음, 마감 잔액 일치)</p>
        <button type="button" id="restore-run">이 자료로 복구하기</button>`;
      box.querySelector('#restore-run').addEventListener('click', run);
    } catch (err) {
      backup = null;
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });

  async function run(e) {
    if (!backup) return;
    if (!confirm('이 백업 파일의 자료로 복구합니다. 계속할까요?')) return;
    e.target.disabled = true;
    try {
      await api('/api/restore', { method: 'POST', body: backup });
      toast('복구했습니다.');
      onRestored();
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
    }
  }
}

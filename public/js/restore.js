// 최초 설정 화면의 "예전 장부 가져오기"
//   장부 파일(.bondang): 비밀번호로 이 브라우저 안에서 풀고 → 백업 자료로 만든 뒤 → 서버 장부에 복구
//   백업 파일(.json)   : 그대로 서버 장부에 복구
// 어느 쪽이든 서버에서 먼저 검사(저장 안 함) → 요약 확인 → 복구 (한 번에 전부 저장하거나 전혀 저장하지 않음)
import { api, esc } from './api.js';
import { toast } from './ui.js';
import { formatDateTimeKST, formatKoreanDate } from './shared/dates.js';

const COUNT_LABEL = {
  accounts: '통장', budget_subjects: '예산과목', transactions: '거래', daily_closings: '마감 기록', audit_log: '변경 기록',
};

/** 장부 파일(.bondang)을 비밀번호로 풀어 백업 자료(JSON)로. 비밀번호는 이 브라우저 밖으로 나가지 않는다 */
async function backupFromLedgerFile(file, password) {
  const { parseLedgerFile, unsealLedger } = await import('./local/ledger-file.js');
  const { deriveKeys } = await import('./local/crypto.js');
  const { openEngine } = await import('./local/engine.js');
  let parsed;
  try {
    parsed = parseLedgerFile(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('본당살림 장부 파일(.bondang)이 아니거나 손상된 파일입니다.');
  }
  const keys = await deriveKeys(password, parsed.header.kdf);
  const dbBytes = await unsealLedger(parsed.header, parsed.sealed, keys.encKey); // 비밀번호가 틀리면 오류
  const engine = await openEngine(dbBytes); // 저장하지 않는 임시 엔진 (파일은 바뀌지 않는다)
  try {
    const res = await engine.fetch('/api/backup');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || '장부 파일에서 자료를 꺼내지 못했습니다.');
    return data;
  } finally {
    engine.close();
  }
}

export function initRestore(box, { onRestored }) {
  box.open = true;
  box.innerHTML = `
    <summary>예전에 쓰던 장부가 있나요? <b>예전 장부 가져오기</b></summary>
    <div class="restore-body">
      <p class="help">예전 <b>장부 파일(.bondang)</b>이나 [설정 → 백업]에서 내려받은 <b>백업 파일(.json)</b>을 고르세요.
        가져오면 최초 설정은 건너뜁니다. 고른 파일은 바뀌지 않습니다.</p>
      <input type="file" id="restore-file" accept=".bondang,.json,application/json">
      <form id="restore-password" class="form-narrow" hidden>
        <label>장부 파일 비밀번호 <input type="password" id="restore-pw" autocomplete="off" required></label>
        <button type="submit">파일 열기</button>
        <p class="help">비밀번호는 이 컴퓨터에서 파일을 여는 데만 쓰고 서버로 보내지 않습니다.</p>
      </form>
      <div id="restore-summary"></div>
    </div>`;
  const out = box.querySelector('#restore-summary');
  const pwForm = box.querySelector('#restore-password');
  let file = null;
  let backup = null;

  box.querySelector('#restore-file').addEventListener('change', async (e) => {
    out.innerHTML = '';
    backup = null;
    pwForm.hidden = true;
    file = e.target.files[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.bondang')) {
      pwForm.hidden = false;
      pwForm.querySelector('#restore-pw').focus();
      return;
    }
    try {
      await check(JSON.parse(await file.text()));
    } catch (err) {
      out.innerHTML = `<p class="error">${err instanceof SyntaxError
        ? '읽을 수 없는 파일입니다. 장부 파일(.bondang)이나 백업 파일(.json)을 고르세요.' : esc(err.message)}</p>`;
    }
  });

  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = pwForm.querySelector('button');
    button.disabled = true;
    out.innerHTML = '<p class="muted">장부 파일을 여는 중… (몇 초 걸립니다)</p>';
    try {
      await check(await backupFromLedgerFile(file, pwForm.querySelector('#restore-pw').value));
      pwForm.hidden = true;
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    } finally {
      button.disabled = false;
      pwForm.querySelector('#restore-pw').value = '';
    }
  });

  /** 서버에서 미리 검사하고 요약을 보여 준다 */
  async function check(data) {
    out.innerHTML = '<p class="muted">자료를 검사하는 중…</p>';
    const { summary: s } = await api('/api/restore?dryRun=1', { method: 'POST', body: data });
    backup = data;
    out.innerHTML = `
      <dl class="summary">
        <dt>성당</dt><dd>${esc(s.parishName)}</dd>
        <dt>자료 시점</dt><dd>${formatDateTimeKST(s.exportedAt)}</dd>
        <dt>거래 기간</dt><dd>${s.firstDate ? `${formatKoreanDate(s.firstDate)} ~ ${formatKoreanDate(s.lastDate)}` : '거래 없음'}</dd>
        <dt>마지막 마감일</dt><dd>${s.lastClosed ? formatKoreanDate(s.lastClosed) : '없음'}</dd>
        <dt>자료</dt><dd>${Object.entries(COUNT_LABEL).map(([k, label]) => `${label} ${s.counts[k]}건`).join(' · ')}</dd>
      </dl>
      <p class="in">✔ 자료 검사 통과 (손상·변조 없음, 마감 잔액 일치)</p>
      <button type="button" id="restore-run">이 장부 가져오기</button>`;
    box.querySelector('#restore-run').addEventListener('click', run);
  }

  async function run(e) {
    if (!backup) return;
    if (!confirm('이 자료로 장부를 시작합니다. 계속할까요?')) return;
    e.target.disabled = true;
    try {
      await api('/api/restore', { method: 'POST', body: backup });
      toast('예전 장부를 가져왔습니다.');
      onRestored();
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
    }
  }
}

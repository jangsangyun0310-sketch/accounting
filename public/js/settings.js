// 설정 화면: 성당 정보 / 통장 / 예산과목 / 결재선
// 모든 변경은 즉시 서버에 저장되고, 저장 후 목록을 다시 불러온다.
import { api, esc } from './api.js';
import { initPage, bindAmountInput, attempt, approvalBoxHtml, FUND_LABEL, KIND_LABEL } from './ui.js';
import { formatWon } from './shared/money.js';
import { formatDateTimeKST } from './shared/dates.js';
import { backupStatusHtml, downloadBackup } from './backup.js';

const MAX_STEPS = 10;
const panel = document.getElementById('panel');
const tabs = document.getElementById('tabs');

let settings = null;
let tab = ['parish', 'accounts', 'subjects', 'approval', 'backup', 'password'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'parish';
let editing = null;       // 수정 중인 행: 'account:3', 'subject:7'
let approvalDraft = null; // 결재선 편집 중 값

async function reload() {
  settings = await api('/api/settings');
  render();
}

function render() {
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ parish: renderParish, accounts: renderAccounts, subjects: renderSubjects, approval: renderApproval, backup: renderBackup, password: renderPassword })[tab]();
  panel.querySelectorAll('input[name="openingBalance"]').forEach(bindAmountInput);
  panel.querySelector('[autofocus]')?.focus();
}

// ---------------------------------------------------------------- 성당 정보

function renderParish() {
  const p = settings.parish;
  const locked = settings.locks.startDate;
  panel.innerHTML = `
    <div class="form-grid" data-form="parish">
      <label>성당명 <input name="parishName" value="${esc(p.parishName)}" maxlength="40"></label>
      <label>운영 개시일 <input name="startDate" type="date" value="${esc(p.startDate)}" ${locked ? 'disabled' : ''}></label>
      <label>결산서 작성자 <input name="writerName" value="${esc(p.writerName)}" maxlength="20"></label>
    </div>
    ${locked ? '<p class="help">거래가 입력되어 있어 운영 개시일은 변경할 수 없습니다.</p>' : ''}
    <p class="help">결산서 작성자 이름은 거래·마감 기록의 처리자로도 남습니다. 사무장이 바뀌면 이름을 바꾸세요. (이전 기록은 그대로 유지)</p>
    <button type="button" data-action="parish-save">저장</button>`;
}

// ---------------------------------------------------------------- 통장

function renderAccounts() {
  const openingLocked = settings.locks.openingBalance;
  panel.innerHTML = `
    ${openingLocked ? '<p class="notice">마감된 날짜가 있어 초기잔액은 변경할 수 없습니다. 새 통장은 0원으로 시작하고, 돈은 거래나 이체로 넣으세요. (과거 결산서 보호)</p>' : ''}
    ${['GENERAL', 'SPECIAL'].map((fund) => {
      const list = settings.accounts.filter((a) => a.fundCode === fund);
      return `
      <h3>${FUND_LABEL[fund]}</h3>
      <table class="grid edit">
        <thead><tr><th class="order">순서</th><th>통장명</th><th>은행</th><th>계좌번호</th>
          <th class="num">초기잔액(원)</th><th class="status">상태</th><th class="actions"></th></tr></thead>
        <tbody>
          ${list.map((a, i) => (editing === `account:${a.id}` ? accountEditRow(a) : accountViewRow(a, i, list.length))).join('')
            || '<tr><td colspan="7" class="muted">등록된 통장이 없습니다.</td></tr>'}
        </tbody>
        <tfoot>
          <tr data-form="account-new" data-fund="${fund}">
            <td></td>
            <td><input name="name" maxlength="30" placeholder="새 통장명"></td>
            <td><input name="bankName" maxlength="30"></td>
            <td><input name="accountNo" maxlength="40"></td>
            <td><input name="openingBalance" placeholder="0" ${openingLocked ? 'disabled title="마감 후 새 통장은 0원으로 시작합니다"' : ''}></td>
            <td></td>
            <td><button type="button" data-action="account-add" data-fund="${fund}">추가</button></td>
          </tr>
        </tfoot>
      </table>`;
    }).join('')}
    <p class="help">거래가 있는 통장은 삭제할 수 없습니다. 더 이상 쓰지 않는 통장은 [수정]에서 "사용"을 해제하세요.</p>`;
}

function accountViewRow(a, i, count) {
  return `
    <tr class="${a.isActive ? '' : 'inactive'}">
      <td class="order">${orderButtons('account', a.id, i, count)}</td>
      <td>${esc(a.name)}</td><td>${esc(a.bankName)}</td><td>${esc(a.accountNo)}</td>
      <td class="num">${formatWon(a.openingBalance)}</td>
      <td class="status">${a.isActive ? '사용' : '<span class="muted">사용중지</span>'}</td>
      <td class="actions">
        <button type="button" class="secondary small" data-action="edit" data-key="account:${a.id}">수정</button>
        ${deleteControl(accountDeleteBlocker(a), `data-action="account-delete" data-id="${a.id}"`)}
      </td>
    </tr>`;
}

function accountEditRow(a) {
  const fundLocked = a.txCount > 0;
  return `
    <tr data-form="account-edit" data-id="${a.id}" class="editing">
      <td><select name="fundCode" ${fundLocked ? 'disabled title="거래가 있어 변경 불가"' : ''}>
        ${['GENERAL', 'SPECIAL'].map((f) => `<option value="${f}" ${f === a.fundCode ? 'selected' : ''}>${FUND_LABEL[f]}</option>`).join('')}
      </select></td>
      <td><input name="name" value="${esc(a.name)}" maxlength="30" autofocus></td>
      <td><input name="bankName" value="${esc(a.bankName)}" maxlength="30"></td>
      <td><input name="accountNo" value="${esc(a.accountNo)}" maxlength="40"></td>
      <td><input name="openingBalance" value="${formatWon(a.openingBalance)}" ${settings.locks.openingBalance ? 'disabled' : ''}></td>
      <td><label class="check"><input type="checkbox" name="isActive" ${a.isActive ? 'checked' : ''}> 사용</label></td>
      <td class="actions">
        <button type="button" class="small" data-action="account-save" data-id="${a.id}">저장</button>
        <button type="button" class="secondary small" data-action="cancel">취소</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------- 예산과목

function renderSubjects() {
  panel.innerHTML = `
    <div class="two-col">
    ${['INCOME', 'EXPENSE'].map((kind) => {
      const list = settings.subjects.filter((s) => s.kind === kind);
      return `
      <div>
        <h3>${KIND_LABEL[kind]} 과목</h3>
        <table class="grid edit">
          <thead><tr><th class="order">순서</th><th>과목명</th><th class="status">상태</th><th class="actions"></th></tr></thead>
          <tbody>
            ${list.map((s, i) => (editing === `subject:${s.id}` ? subjectEditRow(s) : subjectViewRow(s, i, list.length))).join('')
              || '<tr><td colspan="4" class="muted">등록된 과목이 없습니다.</td></tr>'}
          </tbody>
          <tfoot>
            <tr data-form="subject-new" data-kind="${kind}">
              <td></td>
              <td><input name="name" maxlength="30" placeholder="새 과목명"></td>
              <td></td>
              <td><button type="button" data-action="subject-add" data-kind="${kind}">추가</button></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
    }).join('')}
    </div>
    <p class="help">사용된 과목은 삭제할 수 없습니다. 더 이상 쓰지 않는 과목은 [수정]에서 "사용"을 해제하세요.</p>`;
}

function subjectViewRow(s, i, count) {
  return `
    <tr class="${s.isActive ? '' : 'inactive'}">
      <td class="order">${orderButtons('subject', s.id, i, count)}</td>
      <td>${esc(s.name)}</td>
      <td class="status">${s.isActive ? '사용' : '<span class="muted">사용중지</span>'}</td>
      <td class="actions">
        <button type="button" class="secondary small" data-action="edit" data-key="subject:${s.id}">수정</button>
        ${deleteControl(s.txCount > 0 ? '이 과목으로 입력된 거래가 있어 삭제할 수 없습니다. [수정]에서 "사용"을 해제하세요.' : null,
          `data-action="subject-delete" data-id="${s.id}"`)}
      </td>
    </tr>`;
}

function subjectEditRow(s) {
  return `
    <tr data-form="subject-edit" data-id="${s.id}" data-kind="${s.kind}" class="editing">
      <td></td>
      <td><input name="name" value="${esc(s.name)}" maxlength="30" autofocus></td>
      <td><label class="check"><input type="checkbox" name="isActive" ${s.isActive ? 'checked' : ''}> 사용</label></td>
      <td class="actions">
        <button type="button" class="small" data-action="subject-save" data-id="${s.id}">저장</button>
        <button type="button" class="secondary small" data-action="cancel">취소</button>
      </td>
    </tr>`;
}

/** 통장을 삭제할 수 없는 이유 (삭제 가능하면 null). 실제 차단은 DB 트리거와 같은 규칙 */
function accountDeleteBlocker(a) {
  if (a.txCount > 0) return '이 통장에 입력된 거래가 있어 삭제할 수 없습니다. [수정]에서 "사용"을 해제하세요.';
  if (settings.locks.openingBalance && a.openingBalance !== 0) {
    return '마감된 날짜가 있어 초기잔액이 있는 통장은 삭제할 수 없습니다. [수정]에서 "사용"을 해제하세요.';
  }
  return null;
}

/** 삭제 버튼, 또는 삭제할 수 없으면 이유를 담은 흐린 표시 */
function deleteControl(blocker, attrs) {
  return blocker
    ? `<span class="delete-blocked" title="${esc(blocker)}">삭제 불가</span>`
    : `<button type="button" class="danger small" ${attrs}>삭제</button>`;
}

function orderButtons(type, id, i, count) {
  return `<button type="button" class="icon" data-action="${type}-move" data-id="${id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="위로">▲</button>`
    + `<button type="button" class="icon" data-action="${type}-move" data-id="${id}" data-dir="1" ${i === count - 1 ? 'disabled' : ''} title="아래로">▼</button>`;
}

// ---------------------------------------------------------------- 결재선

function renderApproval() {
  approvalDraft ??= settings.approvalSteps.map((s) => s.title);
  const steps = approvalDraft;
  panel.innerHTML = `
    <label class="inline">결재 단계 수
      <select id="approval-count">${Array.from({ length: MAX_STEPS }, (_, i) =>
        `<option ${i + 1 === steps.length ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
    </label>
    <div class="form-grid" id="approval-titles">
      ${steps.map((t, i) => `<label>${i + 1}단계 <input data-i="${i}" value="${esc(t)}" maxlength="12"></label>`).join('')}
    </div>
    <h4>결산서 결재란 미리보기</h4>
    <div id="approval-preview">${approvalBoxHtml(steps.map((t) => t.trim() || '　'))}</div>
    <p class="help">이미 마감된 날짜의 결산서는 마감 당시 결재선으로 출력됩니다.</p>
    <button type="button" data-action="approval-save">저장</button>`;
}

panel.addEventListener('change', (e) => {
  if (e.target.id !== 'approval-count') return;
  const n = Number(e.target.value);
  approvalDraft = Array.from({ length: n }, (_, i) => approvalDraft[i] ?? '');
  render();
});

panel.addEventListener('input', (e) => {
  if (!e.target.closest('#approval-titles')) return;
  approvalDraft[e.target.dataset.i] = e.target.value;
  document.getElementById('approval-preview').innerHTML = approvalBoxHtml(approvalDraft.map((t) => t.trim() || '　'));
});

// ---------------------------------------------------------------- 백업

async function renderBackup() {
  panel.innerHTML = '<p class="muted">불러오는 중…</p>';
  let s;
  try {
    s = await api('/api/backup/status');
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (tab !== 'backup') return;
  const { html } = backupStatusHtml(s);
  panel.innerHTML = `
    <p>${html}</p>
    <button type="button" data-action="backup-download">백업 사본 저장하기</button>
    <div class="help">
      <p>지금 장부 파일의 <b>사본</b>을 고른 곳에 저장합니다. 사본도 <b>같은 비밀번호로 잠겨</b> 있습니다.
        <b>매주 한 번</b>, 그리고 월말에 저장하고, <b>USB나 OneDrive 처럼 이 컴퓨터 밖</b>에도 두세요.
        컴퓨터가 고장 나면 장부 파일도 함께 잃을 수 있습니다.</p>
      <p>되살릴 때는 시작 화면에서 <b>[장부 파일 열기]</b>로 백업 사본을 고르면 그대로 열립니다.</p>
    </div>
    ${s.history.length ? `
      <h4>최근 기록</h4>
      <ul class="audit">${s.history.map((h) => `<li>${formatDateTimeKST(h.at)} · ${esc(h.actor)} ·
        ${h.action === 'BACKUP' ? '백업' : '복구'}</li>`).join('')}</ul>` : ''}`;
}

// ---------------------------------------------------------------- 비밀번호

function renderPassword() {
  panel.innerHTML = `
    <form id="password-form" class="form-narrow" autocomplete="off">
      <p>장부 파일 전체가 새 비밀번호로 다시 잠깁니다. 바꾸면 예전 비밀번호로는 이 파일을 열 수 없습니다.
        (직원이 그만두었을 때 바꾸세요)</p>
      <label>지금 비밀번호 <input type="password" id="pw-current" required></label>
      <label>새 비밀번호 (8자 이상) <input type="password" id="pw-new" minlength="8" required></label>
      <label>새 비밀번호 확인 <input type="password" id="pw-new2" minlength="8" required></label>
      <label class="check"><input type="checkbox" id="pw-ack" required>
        새 비밀번호를 잊으면 누구도(개발자 포함) 자료를 되살릴 수 없다는 것을 이해했습니다.</label>
      <button type="submit" id="pw-save">비밀번호 바꾸기</button>
      <p class="help">이미 저장해 둔 백업 사본은 <b>예전 비밀번호</b>로 잠겨 있습니다. 바꾼 뒤에는 백업 사본을 새로 저장해 두세요.</p>
    </form>`;
  const $f = (id) => document.getElementById(id);
  $f('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($f('pw-new').value.length < 8) return toastError('새 비밀번호는 8자 이상으로 정하세요.');
    if ($f('pw-new').value !== $f('pw-new2').value) return toastError('새 비밀번호 확인이 다릅니다.');
    if (!$f('pw-ack').checked) return toastError('안내를 확인하고 체크해 주세요.');
    const button = $f('pw-save');
    button.disabled = true;
    button.textContent = '바꾸는 중…';
    await attempt(async () => {
      const { checkPassword, changePassword } = await import('./local/session.js');
      if (!(await checkPassword($f('pw-current').value))) throw new Error('지금 비밀번호가 맞지 않습니다.');
      await changePassword($f('pw-new').value);
      $f('password-form').reset();
    }, '비밀번호를 바꿨습니다.');
    button.disabled = false;
    button.textContent = '비밀번호 바꾸기';
  });
}

function toastError(message) {
  attempt(async () => { throw new Error(message); });
}

// ---------------------------------------------------------------- 동작

const field = (row, name) => row.querySelector(`[name="${name}"]`);

const actions = {
  'backup-download': async () => {
    if (await downloadBackup()) render();
  },

  'parish-save': async () => {
    const form = panel.querySelector('[data-form="parish"]');
    const body = {
      parishName: field(form, 'parishName').value,
      startDate: field(form, 'startDate').value,
      writerName: field(form, 'writerName').value,
    };
    if (await attempt(() => api('/api/settings/parish', { method: 'PUT', body }), '저장했습니다.')) await reload();
  },

  edit: async (btn) => { editing = btn.dataset.key; render(); },
  cancel: async () => { editing = null; render(); },

  'account-add': async (btn) => {
    const row = btn.closest('tr');
    const body = {
      fundCode: btn.dataset.fund,
      name: field(row, 'name').value,
      bankName: field(row, 'bankName').value,
      accountNo: field(row, 'accountNo').value,
      openingBalance: field(row, 'openingBalance').value || '0',
    };
    if (await attempt(() => api('/api/accounts', { method: 'POST', body }), '통장을 추가했습니다.')) {
      await reload();
      panel.querySelector(`[data-form="account-new"][data-fund="${btn.dataset.fund}"] input`)?.focus();
    }
  },
  'account-save': async (btn) => {
    const row = btn.closest('tr');
    const body = {
      fundCode: field(row, 'fundCode').value,
      name: field(row, 'name').value,
      bankName: field(row, 'bankName').value,
      accountNo: field(row, 'accountNo').value,
      openingBalance: field(row, 'openingBalance').value || '0',
      isActive: field(row, 'isActive').checked,
    };
    if (await attempt(() => api(`/api/accounts/${btn.dataset.id}`, { method: 'PUT', body }), '저장했습니다.')) {
      editing = null;
      await reload();
    }
  },
  'account-delete': async (btn) => {
    const a = settings.accounts.find((x) => x.id === Number(btn.dataset.id));
    if (!confirm(`'${a.name}' 통장을 삭제할까요?`)) return;
    if (await attempt(() => api(`/api/accounts/${a.id}`, { method: 'DELETE' }), '삭제했습니다.')) await reload();
  },
  'account-move': async (btn) => {
    const a = settings.accounts.find((x) => x.id === Number(btn.dataset.id));
    const ids = moved(settings.accounts.filter((x) => x.fundCode === a.fundCode), a.id, Number(btn.dataset.dir));
    if (await attempt(() => api('/api/accounts/reorder', { method: 'POST', body: { fundCode: a.fundCode, ids } }))) await reload();
  },

  'subject-add': async (btn) => {
    const row = btn.closest('tr');
    const body = { kind: btn.dataset.kind, name: field(row, 'name').value };
    if (await attempt(() => api('/api/subjects', { method: 'POST', body }), '과목을 추가했습니다.')) {
      await reload();
      panel.querySelector(`[data-form="subject-new"][data-kind="${btn.dataset.kind}"] input`)?.focus();
    }
  },
  'subject-save': async (btn) => {
    const row = btn.closest('tr');
    const body = { kind: row.dataset.kind, name: field(row, 'name').value, isActive: field(row, 'isActive').checked };
    if (await attempt(() => api(`/api/subjects/${btn.dataset.id}`, { method: 'PUT', body }), '저장했습니다.')) {
      editing = null;
      await reload();
    }
  },
  'subject-delete': async (btn) => {
    const s = settings.subjects.find((x) => x.id === Number(btn.dataset.id));
    if (!confirm(`'${s.name}' 과목을 삭제할까요?`)) return;
    if (await attempt(() => api(`/api/subjects/${s.id}`, { method: 'DELETE' }), '삭제했습니다.')) await reload();
  },
  'subject-move': async (btn) => {
    const s = settings.subjects.find((x) => x.id === Number(btn.dataset.id));
    const ids = moved(settings.subjects.filter((x) => x.kind === s.kind), s.id, Number(btn.dataset.dir));
    if (await attempt(() => api('/api/subjects/reorder', { method: 'POST', body: { kind: s.kind, ids } }))) await reload();
  },

  'approval-save': async () => {
    const body = { titles: approvalDraft };
    if (await attempt(() => api('/api/approval-steps', { method: 'PUT', body }), '결재선을 저장했습니다.')) {
      approvalDraft = null;
      await reload();
    }
  },
};

/** 목록에서 id 를 dir(-1 위, +1 아래) 만큼 옮긴 새 id 순서 */
function moved(list, id, dir) {
  const ids = list.map((x) => x.id);
  const i = ids.indexOf(id);
  [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  return ids;
}

let busy = false;
panel.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || busy) return;
  busy = true;
  btn.disabled = true;
  try {
    await actions[btn.dataset.action](btn);
  } finally {
    busy = false;
    if (btn.isConnected) btn.disabled = false;
  }
});

// Enter: 같은 줄의 다음 칸으로, 마지막 칸이면 그 줄의 저장/추가 버튼
panel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editing) { editing = null; render(); return; }
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  const form = e.target.closest('[data-form]') || e.target.closest('#approval-titles');
  if (!form) return;
  e.preventDefault();
  const inputs = [...form.querySelectorAll('input:not([disabled]):not([type="checkbox"]), select:not([disabled])')];
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) next.focus();
  else (form.querySelector('[data-action]') ?? panel.querySelector('[data-action$="-save"]'))?.click();
});

tabs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  editing = null;
  history.replaceState(null, '', `#${tab}`);
  render();
});


initPage('settings').then(async () => {
  await reload();
}).catch((err) => {
  panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
});

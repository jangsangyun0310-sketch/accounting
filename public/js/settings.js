// 설정 화면: 성당 정보 / 통장 / 예산과목 / 결재선 / 백업 / 함께 쓰는 사람 / 초기화·탈퇴(오른쪽 끝 빨간 탭)
// 모든 변경은 즉시 서버에 저장되고, 저장 후 목록을 다시 불러온다.
import { api, esc } from './api.js';
import { initPage, bindAmountInput, attempt, toast, approvalBoxHtml, FUND_LABEL, KIND_LABEL } from './ui.js';
import { formatWon } from './shared/money.js';
import { formatDateTimeKST } from './shared/dates.js';
import { backupStatusHtml, downloadBackup } from './backup.js';
import { currentAccount, logout } from './account.js';

const MAX_STEPS = 10;
const panel = document.getElementById('panel');
const tabs = document.getElementById('tabs');

let settings = null;
let tab = ['parish', 'accounts', 'subjects', 'approval', 'backup', 'members', 'account'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'parish';
let editing = null;       // 수정 중인 행: 'account:3', 'subject:7'
let approvalDraft = null; // 결재선 편집 중 값

async function reload() {
  settings = await api('/api/settings');
  render();
}

function render() {
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ parish: renderParish, accounts: renderAccounts, subjects: renderSubjects, approval: renderApproval, backup: renderBackup, members: renderMembers, account: renderAccount })[tab]();
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
    <button type="button" data-action="backup-download">백업 파일 내려받기</button>
    <div class="help">
      <p>장부는 본당살림 서버에 저장되어 있습니다. 그래도 만일에 대비해 <b>한 달에 한 번</b>쯤 장부 전체를 백업 파일(.json)로 내려받아
        <b>USB나 OneDrive</b>에 보관해 두세요.</p>
      <p>백업 파일에는 신자 이름과 금액이 들어 있으니 다른 사람에게 보내지 마세요.</p>
    </div>
    ${s.history.length ? `
      <h4>최근 기록</h4>
      <ul class="audit">${s.history.map((h) => `<li>${formatDateTimeKST(h.at)} · ${esc(h.actor)} ·
        ${h.action === 'BACKUP' ? '백업' : '복구'}</li>`).join('')}</ul>` : ''}`;
}

// ---------------------------------------------------------------- 함께 쓰는 사람

async function renderMembers() {
  panel.innerHTML = '<p class="muted">불러오는 중…</p>';
  let m;
  try {
    const res = await fetch('/account/members');
    m = await res.json();
    if (!res.ok) throw new Error(m?.error?.message || `불러오지 못했습니다 (${res.status})`);
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (tab !== 'members') return;
  const only = m.members.length <= 1;
  const rows = [
    ...m.members.map((u) => `<tr><td>${esc(u.email)}${u.email === m.me ? ' <span class="muted">(나)</span>' : ''}</td>
      <td>사용 중 <span class="muted small">· 마지막 로그인 ${formatDateTimeKST(u.lastLoginAt)}</span></td>
      <td class="actions">${only ? '' : `<button type="button" class="danger small" data-action="member-remove" data-email="${esc(u.email)}">빼기</button>`}</td></tr>`),
    ...m.invites.map((i) => `<tr><td>${esc(i.email)}</td><td><span class="pill open">로그인 전</span>
      <span class="muted small">· 그 계정으로 로그인하면 연결됩니다</span></td>
      <td class="actions"><button type="button" class="secondary small" data-action="member-remove" data-email="${esc(i.email)}">취소</button></td></tr>`),
  ];
  panel.innerHTML = `
    <p>이 성당 장부를 함께 쓰는 구글 계정입니다. 모두 같은 권한(입력·마감·결산·설정)을 가집니다.</p>
    <table class="grid">
      <thead><tr><th>구글 계정</th><th>상태</th><th class="actions"></th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <div class="form-grid" data-form="member" style="max-width:560px;grid-template-columns:1fr auto;align-items:end">
      <label>추가할 사람의 구글 이메일 <input name="email" type="email" placeholder="예) new.office@gmail.com" autocomplete="off"></label>
      <button type="button" data-action="member-add">추가</button>
    </div>
    <details class="help-box" open>
      <summary>사무장이 바뀌었을 때</summary>
      <ol>
        <li>전 사무장이 여기에 <b>새 사무장의 구글 이메일</b>을 추가합니다.</li>
        <li>새 사무장이 본당살림에 <b>그 구글 계정으로 로그인</b>합니다. 같은 컴퓨터라면 [로그아웃] 후 로그인 화면의 구글 계정 고르는 창에서 <b>"다른 계정 사용"</b>을 누릅니다.</li>
        <li>장부가 보이면 이 화면에서 <b>전 사무장을 [빼기]</b> 합니다. 빠진 계정은 바로 로그아웃됩니다.</li>
        <li>[성당 정보]의 <b>결산서 작성자</b> 이름을 바꿉니다.</li>
      </ol>
      <p class="help">💡 성당 업무 전용 구글 계정(예: 성당이름.office@gmail.com)으로 써 두면 인수인계가 더 쉽습니다.</p>
    </details>`;
}

// ---------------------------------------------------------------- 초기화·탈퇴 (장부 초기화 · 탈퇴)

async function renderAccount() {
  panel.innerHTML = '<p class="muted">불러오는 중…</p>';
  let account;
  let backup;
  try {
    [account, backup] = await Promise.all([currentAccount(), api('/api/backup/status')]);
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (tab !== 'account') return;
  const name = account.parish.name;
  panel.innerHTML = `
    <dl class="summary">
      <dt>로그인 계정</dt><dd>${esc(account.user.email)}</dd>
      <dt>성당</dt><dd>${esc(name)}</dd>
    </dl>

    <h3>장부 초기화</h3>
    <div class="danger-zone">
      <p>지금 장부의 <b>모든 거래·마감·통장·과목·설정</b>을 지우고 <b>최초 설정부터 다시</b> 시작합니다. 로그인 계정과 성당 등록은 그대로입니다.</p>
      <p>지운 장부는 되살릴 수 없습니다. 그래서 <b>먼저 백업 파일을 내려받아야</b> 초기화할 수 있습니다.<br>
        (나중에 필요하면 최초 설정 화면의 [예전 장부 가져오기]로 되돌릴 수 있습니다.)</p>
      <p>${backupStatusHtml(backup).html}</p>
      <p><button type="button" class="secondary" data-action="backup-download">① 백업 파일 내려받기</button></p>
      <label><span>② 확인을 위해 성당 이름 <b>${esc(name)}</b> 을(를) 그대로 적으세요</span> <input id="reset-name" autocomplete="off"></label>
      <p><button type="button" class="danger" data-action="ledger-reset">③ 장부 초기화</button></p>
    </div>

    <h3>탈퇴</h3>
    <div class="danger-zone">
      <p>이 성당의 <b>장부 전체</b>와 <b>성당 등록</b>, <b>로그인 정보</b>를 서버에서 모두 지웁니다. 지운 뒤에는 되살릴 수 없습니다.</p>
      <p>장부가 필요하면 먼저 [백업] 탭에서 백업 파일을 내려받아 두세요. 다시 가입하면 그 파일로 장부를 가져올 수 있습니다.</p>
      <p class="help">구글 계정의 "본당살림" 접근 권한은 구글 계정 관리 → 보안 → 타사 앱 연결에서 지울 수 있습니다.</p>
      <label><span>확인을 위해 성당 이름 <b>${esc(name)}</b> 을(를) 그대로 적으세요</span> <input id="withdraw-name" autocomplete="off"></label>
      <label class="check"><input type="checkbox" id="withdraw-ack"> 장부와 계정이 모두 지워지고 되살릴 수 없다는 것을 이해했습니다.</label>
      <p><button type="button" class="danger" data-action="withdraw">탈퇴하기</button></p>
    </div>`;
}

/** 계정 화면의 POST 요청. 오류는 메시지를 담은 Error 로 */
async function accountPost(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `처리하지 못했습니다 (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- 동작

const field = (row, name) => row.querySelector(`[name="${name}"]`);

const actions = {
  'backup-download': async () => {
    if (await downloadBackup()) render();
  },

  'member-add': async () => {
    const email = panel.querySelector('[data-form="member"] [name="email"]').value.trim();
    if (!email) return toast('추가할 사람의 구글 이메일을 적어 주세요.', 'error');
    let result;
    if (await attempt(async () => { result = await accountPost('/account/members', { email }); })) {
      toast(result.connected ? `${email} 계정을 연결했습니다.` : `${email} 을(를) 등록했습니다. 그 계정으로 로그인하면 연결됩니다.`);
      render();
    }
  },

  'member-remove': async (btn) => {
    const email = btn.dataset.email;
    const pending = btn.textContent.trim() === '취소';
    if (!confirm(pending ? `${email} 등록을 취소할까요?` : `${email} 계정을 이 성당에서 뺄까요? 그 계정은 바로 로그아웃되고 장부를 볼 수 없게 됩니다.`)) return;
    let result;
    if (await attempt(async () => { result = await accountPost('/account/members/remove', { email }); }, pending ? '등록을 취소했습니다.' : '뺐습니다.')) {
      if (result.self) logout(); // 나 자신을 뺐으면 로그인 화면으로
      else render();
    }
  },

  'ledger-reset': async () => {
    const parishName = document.getElementById('reset-name').value;
    if (!confirm('장부를 모두 지우고 최초 설정부터 다시 시작합니다. 계속할까요?')) return;
    if (await attempt(() => accountPost('/account/reset-ledger', { parishName }), '장부를 초기화했습니다.')) {
      location.href = '/setup';
    }
  },

  withdraw: async () => {
    if (!document.getElementById('withdraw-ack').checked) return toast('안내를 확인하고 체크해 주세요.', 'error');
    const parishName = document.getElementById('withdraw-name').value;
    if (!confirm('탈퇴하면 장부와 계정이 모두 지워집니다. 정말 탈퇴할까요?')) return;
    if (await attempt(() => accountPost('/account/withdraw', { parishName }))) {
      try { sessionStorage.clear(); } catch { /* 무시 */ }
      location.replace('/login?bye=1');
    }
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

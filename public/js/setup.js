// 최초 설정 마법사
// 입력 내용은 브라우저에 임시 저장되며, 마지막 "설정 완료" 때 한 번에 서버로 전송된다.
import { api, esc } from './api.js';
import { initPage, bindAmountInput, toast, approvalBoxHtml, FUND_LABEL } from './ui.js';
import { parseAmount, sumAmounts, formatWon } from './shared/money.js';
import { isValidDate, todayKST, formatKoreanDate } from './shared/dates.js';

const DRAFT_KEY = 'bondang.setupDraft.v1';
const STEPS = ['성당 정보', '일반회계 통장', '특별회계 통장', '예산과목', '결재선', '확인'];
const MAX_STEPS = 10;

// 예시 과목: 버튼을 눌렀을 때만 채워지는 제안값. 자유롭게 고치거나 지울 수 있다.
const SUBJECT_EXAMPLES = {
  INCOME: ['교무금', '주일헌금', '감사헌금', '미사예물', '후원금', '이자수입', '기타수입'],
  EXPENSE: ['인건비', '전례비', '사목활동비', '관리운영비', '시설수선비', '교구납부금', '사회복지비', '기타지출'],
};

const emptyAccount = () => ({ name: '', bankName: '', accountNo: '', openingBalance: '' });

let state = loadDraft() ?? {
  step: 0,
  parish: { parishName: '', startDate: todayKST(), writerName: '' },
  accounts: { GENERAL: [emptyAccount()], SPECIAL: [emptyAccount()] },
  subjects: { INCOME: [''], EXPENSE: [''] },
  approvalSteps: ['기안', ''],
};

const $ = (id) => document.getElementById(id);
const panel = $('panel');

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; }
}
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* 저장 불가 환경 */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 무시 */ }
}

// ---------------------------------------------------------------- 화면 그리기

function render() {
  document.getElementById('toast')?.classList.remove('show');
  $('steps').innerHTML = STEPS.map((s, i) =>
    `<li class="${i === state.step ? 'current' : i < state.step ? 'done' : ''}">${i + 1}. ${s}</li>`).join('');
  $('prev').hidden = state.step === 0;
  $('next').textContent = state.step === STEPS.length - 1 ? '설정 완료' : '다음';
  [renderParish, () => renderAccounts('GENERAL'), () => renderAccounts('SPECIAL'),
    renderSubjects, renderApproval, renderConfirm][state.step]();
  panel.querySelector('input, select')?.focus();
  saveDraft();
}

function renderParish() {
  const p = state.parish;
  panel.innerHTML = `
    <h3>성당 정보</h3>
    <div class="form-grid">
      <label>성당명 <input id="parishName" value="${esc(p.parishName)}" maxlength="40" placeholder="예) ○○성당"></label>
      <label>운영 개시일 <input id="startDate" type="date" value="${esc(p.startDate)}"></label>
      <label>결산서 작성자 <input id="writerName" value="${esc(p.writerName)}" maxlength="20" placeholder="예) 사무장 이름"></label>
    </div>
    <p class="help">운영 개시일은 각 통장 초기잔액의 기준일입니다. 이 날짜 이전으로는 거래를 입력할 수 없습니다.</p>`;
  for (const key of ['parishName', 'startDate', 'writerName']) {
    $(key).addEventListener('input', (e) => { p[key] = e.target.value; saveDraft(); });
  }
}

function renderAccounts(fund) {
  const rows = state.accounts[fund];
  panel.innerHTML = `
    <h3>${FUND_LABEL[fund]} 통장</h3>
    <table class="grid edit">
      <thead><tr><th>통장명</th><th>은행</th><th>계좌번호</th><th class="num">초기잔액(원)</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr data-i="${i}">
          <td><input data-f="name" value="${esc(r.name)}" maxlength="30" placeholder="예) 경상비"></td>
          <td><input data-f="bankName" value="${esc(r.bankName)}" maxlength="30"></td>
          <td><input data-f="accountNo" value="${esc(r.accountNo)}" maxlength="40"></td>
          <td><input data-f="openingBalance" value="${esc(r.openingBalance)}" placeholder="0"></td>
          <td><button type="button" class="icon" data-remove="${i}" title="행 삭제">✕</button></td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="3">합계</td><td class="num" id="sum"></td><td></td></tr></tfoot>
    </table>
    <button type="button" id="add" class="secondary">+ 통장 추가</button>
    <p class="help">마지막 칸에서 Enter 를 누르면 새 줄이 추가됩니다. ${fund === 'SPECIAL' ? '특별회계 통장이 없으면 비워 두세요.' : ''}</p>`;

  panel.querySelectorAll('input[data-f="openingBalance"]').forEach(bindAmountInput);
  const updateSum = () => { $('sum').textContent = safeSum(rows); };
  updateSum();

  panel.querySelector('tbody').addEventListener('input', (e) => {
    const i = e.target.closest('tr').dataset.i;
    rows[i][e.target.dataset.f] = e.target.value;
    updateSum();
    saveDraft();
  });
  panel.querySelector('tbody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...panel.querySelectorAll('tbody input')];
    const idx = inputs.indexOf(e.target);
    if (idx === inputs.length - 1) addRow();
    else inputs[idx + 1].focus();
  });
  panel.querySelector('tbody').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      rows.splice(Number(rm.dataset.remove), 1);
      if (rows.length === 0) rows.push(emptyAccount());
      render();
    }
  });
  $('add').addEventListener('click', addRow);

  function addRow() {
    rows.push(emptyAccount());
    render();
    const names = panel.querySelectorAll('input[data-f="name"]');
    names[names.length - 1].focus();
  }
}

function safeSum(rows) {
  try {
    return formatWon(sumAmounts(rows.map((r) => (r.openingBalance ? parseAmount(r.openingBalance, { allowZero: true }) : 0))));
  } catch {
    return '-';
  }
}

function renderSubjects() {
  panel.innerHTML = `
    <h3>예산과목</h3>
    <p class="help">거래를 입력할 때 고를 과목입니다. 교구 예산서의 과목명을 그대로 쓰는 것을 권장합니다.
      <button type="button" id="examples" class="link">예시 과목 넣기</button></p>
    <div class="two-col">
      ${['INCOME', 'EXPENSE'].map((kind) => `
        <div data-kind="${kind}">
          <h4>${kind === 'INCOME' ? '수입' : '지출'} 과목</h4>
          ${state.subjects[kind].map((name, i) => `
            <div class="list-row">
              <input data-i="${i}" value="${esc(name)}" maxlength="30">
              <button type="button" class="icon" data-remove="${i}" title="삭제">✕</button>
            </div>`).join('')}
          <button type="button" class="secondary" data-add>+ 추가</button>
        </div>`).join('')}
    </div>`;

  panel.querySelectorAll('[data-kind]').forEach((box) => {
    const list = state.subjects[box.dataset.kind];
    box.addEventListener('input', (e) => { list[e.target.dataset.i] = e.target.value; saveDraft(); });
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const inputs = [...box.querySelectorAll('input')];
      const idx = inputs.indexOf(e.target);
      if (idx === inputs.length - 1) addTo(box.dataset.kind);
      else inputs[idx + 1].focus();
    });
    box.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        list.splice(Number(rm.dataset.remove), 1);
        if (list.length === 0) list.push('');
        render();
      }
      if (e.target.closest('[data-add]')) addTo(box.dataset.kind);
    });
  });

  $('examples').addEventListener('click', () => {
    for (const kind of ['INCOME', 'EXPENSE']) {
      const current = state.subjects[kind].map((s) => s.trim()).filter(Boolean);
      state.subjects[kind] = [...current, ...SUBJECT_EXAMPLES[kind].filter((s) => !current.includes(s))];
    }
    render();
  });

  function addTo(kind) {
    state.subjects[kind].push('');
    render();
    const inputs = panel.querySelectorAll(`[data-kind="${kind}"] input`);
    inputs[inputs.length - 1].focus();
  }
}

function renderApproval() {
  const steps = state.approvalSteps;
  panel.innerHTML = `
    <h3>결재선</h3>
    <label class="inline">결재 단계 수
      <select id="count">${Array.from({ length: MAX_STEPS }, (_, i) =>
        `<option ${i + 1 === steps.length ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
    </label>
    <div class="form-grid" id="titles">
      ${steps.map((t, i) => `<label>${i + 1}단계 <input data-i="${i}" value="${esc(t)}" maxlength="12"></label>`).join('')}
    </div>
    <h4>결산서 결재란 미리보기</h4>
    <div id="preview">${approvalBoxHtml(steps.map((t) => t.trim() || '　'))}</div>
    <p class="help">왼쪽부터 순서대로 결재란에 인쇄됩니다. 예) 기안 → 재정부회장 → 사목회장 → 주임신부</p>`;

  $('count').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    state.approvalSteps = Array.from({ length: n }, (_, i) => steps[i] ?? '');
    render();
  });
  $('titles').addEventListener('input', (e) => {
    steps[e.target.dataset.i] = e.target.value;
    $('preview').innerHTML = approvalBoxHtml(steps.map((t) => t.trim() || '　'));
    saveDraft();
  });
}

function renderConfirm() {
  let payload;
  try {
    payload = buildPayload();
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    $('next').disabled = true;
    return;
  }
  $('next').disabled = false;
  const { parish, accounts, subjects, approvalSteps } = payload;
  const fundTable = (fund) => {
    const list = accounts.filter((a) => a.fundCode === fund);
    if (!list.length) return `<p class="muted">${FUND_LABEL[fund]} 통장 없음</p>`;
    const total = sumAmounts(list.map((a) => parseAmount(a.openingBalance, { allowZero: true })));
    return `<table class="grid"><thead><tr><th>${FUND_LABEL[fund]} 통장</th><th>은행</th><th>계좌번호</th>
      <th class="num">초기잔액</th></tr></thead><tbody>
      ${list.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.bankName)}</td><td>${esc(a.accountNo)}</td>
        <td class="num">${formatWon(parseAmount(a.openingBalance, { allowZero: true }))}</td></tr>`).join('')}
      <tr class="subtotal"><td colspan="3">소계</td><td class="num">${formatWon(total)}</td></tr></tbody></table>`;
  };
  panel.innerHTML = `
    <h3>입력 내용 확인</h3>
    <dl class="summary">
      <dt>성당명</dt><dd>${esc(parish.parishName)}</dd>
      <dt>운영 개시일</dt><dd>${formatKoreanDate(parish.startDate)}</dd>
      <dt>작성자</dt><dd>${esc(parish.writerName) || '<span class="muted">(없음)</span>'}</dd>
    </dl>
    ${fundTable('GENERAL')}
    ${fundTable('SPECIAL')}
    <p><b>수입 과목</b> ${subjects.filter((s) => s.kind === 'INCOME').map((s) => esc(s.name)).join(', ')}</p>
    <p><b>지출 과목</b> ${subjects.filter((s) => s.kind === 'EXPENSE').map((s) => esc(s.name)).join(', ')}</p>
    <h4>결재란</h4>
    ${approvalBoxHtml(approvalSteps)}
    <p class="help">"설정 완료"를 누르면 저장됩니다. 저장 후에도 설정 화면에서 수정할 수 있습니다.
      (단, 거래가 생기면 운영 개시일을, 마감이 생기면 초기잔액을 바꿀 수 없습니다.)</p>`;
}

// ---------------------------------------------------------------- 검증·전송

/** 화면 입력을 서버 전송 형식으로 변환. 문제가 있으면 해당 단계 이름과 함께 오류 */
function buildPayload() {
  const p = state.parish;
  const parish = { parishName: p.parishName.trim(), startDate: p.startDate, writerName: p.writerName.trim() };
  if (!parish.parishName) throw stepError(0, '성당명을 입력하세요.');
  if (!isValidDate(parish.startDate)) throw stepError(0, '운영 개시일을 입력하세요.');

  const accounts = [];
  for (const [fund, stepNo] of [['GENERAL', 1], ['SPECIAL', 2]]) {
    for (const r of state.accounts[fund]) {
      const blank = !r.name.trim() && !r.bankName.trim() && !r.accountNo.trim() && !r.openingBalance.trim();
      if (blank) continue;
      if (!r.name.trim()) throw stepError(stepNo, '통장명이 비어 있는 줄이 있습니다.');
      try {
        parseAmount(r.openingBalance || '0', { allowZero: true });
      } catch (e) {
        throw stepError(stepNo, `${r.name}: ${e.message}`);
      }
      accounts.push({
        fundCode: fund, name: r.name.trim(), bankName: r.bankName.trim(),
        accountNo: r.accountNo.trim(), openingBalance: r.openingBalance || '0',
      });
    }
  }
  if (!accounts.length) throw stepError(1, '통장을 1개 이상 입력하세요.');
  const dupAccount = findDuplicate(accounts.map((a) => a.name));
  if (dupAccount) throw stepError(1, `통장명 '${dupAccount}'이(가) 중복되었습니다.`);

  const subjects = [];
  for (const kind of ['INCOME', 'EXPENSE']) {
    const names = state.subjects[kind].map((s) => s.trim()).filter(Boolean);
    const label = kind === 'INCOME' ? '수입' : '지출';
    if (!names.length) throw stepError(3, `${label} 과목을 1개 이상 입력하세요.`);
    const dup = findDuplicate(names);
    if (dup) throw stepError(3, `${label} 과목 '${dup}'이(가) 중복되었습니다.`);
    subjects.push(...names.map((name) => ({ kind, name })));
  }

  const approvalSteps = state.approvalSteps.map((t) => t.trim());
  if (approvalSteps.some((t) => !t)) throw stepError(4, '결재 단계 명칭을 모두 입력하세요.');
  const dupStep = findDuplicate(approvalSteps);
  if (dupStep) throw stepError(4, `결재 단계 '${dupStep}'이(가) 중복되었습니다.`);

  return { parish, accounts, subjects, approvalSteps };
}

function findDuplicate(list) {
  const seen = new Set();
  for (const v of list) {
    const key = v.replace(/\s+/g, ' ');
    if (seen.has(key)) return v;
    seen.add(key);
  }
  return null;
}

function stepError(step, message) {
  const err = new Error(`[${STEPS[step]}] ${message}`);
  err.step = step;
  return err;
}

/** 현재 단계 입력만 검사 (다음 단계로 넘어가기 전) */
function validateCurrentStep() {
  try {
    buildPayload();
  } catch (err) {
    if (err.step <= state.step) {
      toast(err.message, 'error');
      return false;
    }
  }
  return true;
}

$('prev').addEventListener('click', () => {
  state.step = Math.max(0, state.step - 1);
  $('next').disabled = false;
  render();
});

$('next').addEventListener('click', async () => {
  if (state.step < STEPS.length - 1) {
    if (!validateCurrentStep()) return;
    state.step += 1;
    render();
    return;
  }
  const btn = $('next');
  btn.disabled = true;
  try {
    await api('/api/setup', { method: 'POST', body: buildPayload() });
    clearDraft();
    location.replace('/');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

// Enter 로 다음 칸 이동 (성당 정보·결재선 단계)
panel.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.defaultPrevented || e.target.tagName !== 'INPUT') return;
  if (e.target.closest('tbody, [data-kind]')) return; // 표·목록은 자체 처리
  e.preventDefault();
  const inputs = [...panel.querySelectorAll('input, select')];
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) next.focus();
  else $('next').click();
});

initPage('setup', { requireSetup: false }).then(({ settings }) => {
  if (settings.setupCompleted) {
    clearDraft();
    location.replace('/settings');
    return;
  }
  render();
}).catch((err) => {
  panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
});

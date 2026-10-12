// 거래 입력 화면: 수입·지출·이체 입력, 수정, 삭제, 하루 현황
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, bindAmountInput, toast, signedWon, closeBarHtml, closeDay, FUND_LABEL } from './ui.js';
import { formatWon, parseAmount, sumAmounts } from './shared/money.js';
import { addDays, formatKoreanDate, isValidDate, todayKST } from './shared/dates.js';

const PREF_KEY = 'bondang.entryPrefs.v1';
const $ = (id) => document.getElementById(id);

let settings = null;
let day = null;
let kind = 'IN';        // 'IN' 수입 | 'OUT' 지출 | 'TRANSFER' 이체
let editing = null;     // 수정 중인 거래 (목록의 행 객체)
let beforeEdit = null;  // 수정 시작 전 입력칸 상태 (수정이 끝나면 되돌림)
let saving = false;
let prefs = loadPrefs();

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) ?? {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 저장 불가 환경 */ }
}

// ---------------------------------------------------------------- 선택 목록

function accountOptions(selectedId) {
  return ['GENERAL', 'SPECIAL'].map((fund) => {
    const list = settings.accounts.filter((a) => a.fundCode === fund && (a.isActive || a.id === selectedId));
    if (!list.length) return '';
    // 사무실 현금은 색으로 구분
    return `<optgroup label="${FUND_LABEL[fund]}">${list.map((a) =>
      `<option value="${a.id}" ${a.isCash ? 'class="cash-opt"' : ''}>${esc(a.name)}${a.isCash && !a.name.includes('현금') ? ' (현금)' : ''}${a.isActive ? '' : ' (사용중지)'}</option>`).join('')}</optgroup>`;
  }).join('');
}

function subjectOptions(subjectKind, selectedId) {
  return settings.subjects
    .filter((s) => s.kind === subjectKind && (s.isActive || s.id === selectedId))
    .map((s) => `<option value="${s.id}">${esc(s.name)}${s.isActive ? '' : ' (사용중지)'}</option>`).join('');
}

function setSelect(select, html, value) {
  select.innerHTML = html;
  if (value != null && select.querySelector(`option[value="${value}"]`)) select.value = String(value);
}

/**
 * 납부자 칸: 특별회계 통장의 수입일 때만 (교무금·봉헌권 등 일반회계는 양업시스템에서 관리).
 * 개인별 납부(연말정산 준비)에 쓰인다.
 */
function updatePayerField() {
  const account = settings.accounts.find((a) => a.id === Number($('account').value));
  const show = kind === 'IN' && account?.fundCode === 'SPECIAL';
  $('payer-field').hidden = !show;
  if (!show) $('payer').value = '';
}

/** 차감(−) 칸: 수입에서 "차감 허용" 과목(봉헌권 등)을 골랐을 때만 */
function updateDeductField() {
  const subject = settings.subjects.find((s) => s.id === Number($('subject').value));
  const show = kind === 'IN' && Boolean(subject?.allowDeduction);
  $('deduct-field').hidden = !show;
  if (!show) $('deduct').checked = false;
}

/**
 * 비품대장에도 올리기: 비품 과목(설정에서 표시한 지출 과목)으로 지출할 때만.
 * 고치는 거래가 이미 비품으로 올라가 있으면 그 관리번호만 보여 준다.
 */
function updateEquipmentField() {
  const subject = settings.subjects.find((s) => s.id === Number($('subject').value));
  const linkedNo = editing?.equipmentNo ?? null;
  $('eq-entry').hidden = !(kind === 'OUT' && (subject?.isEquipment || linkedNo));
  $('eq-new').hidden = Boolean(linkedNo);
  $('eq-linked').hidden = !linkedNo;
  if (linkedNo) {
    $('eq-linked').innerHTML = `📦 이 지출로 올린 비품: <a href="${href(`/equipment?no=${encodeURIComponent(linkedNo)}`)}">${esc(linkedNo)}</a>
      <span class="muted small">(금액 · 날짜를 고치면 비품대장도 따라 바뀝니다)</span>`;
  }
  $('eq-fields').hidden = !$('eq-on').checked;
}

function resetEquipmentFields() {
  $('eq-on').checked = true;
  for (const id of ['eq-name', 'eq-spec', 'eq-location']) $(id).value = '';
  $('eq-qty').value = '1';
  $('eq-fields').hidden = false;
}

/** 전에 적은 납부자 이름 (자동 완성) */
async function loadPayers() {
  const { payers } = await api('/api/payers');
  $('payer-list').innerHTML = payers.map((p) => `<option value="${esc(p)}">`).join('');
}

/** 구분 전환: 해당 구분에 맞는 입력칸과 마지막으로 쓴 통장·과목을 보여준다 */
function setKind(next, values = prefs[next] ?? {}) {
  kind = next;
  document.querySelectorAll('.kind-toggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.kind === kind);
    b.setAttribute('aria-checked', String(b.dataset.kind === kind));
  });
  $('entry').dataset.kind = kind;
  if (kind === 'TRANSFER') {
    setSelect($('from-account'), accountOptions(values.fromAccountId), values.fromAccountId);
    setSelect($('to-account'), accountOptions(values.toAccountId), values.toAccountId);
    // 처음 쓸 때 두 칸이 같은 통장이면 받는 곳을 다른 통장으로
    if ($('to-account').value === $('from-account').value) {
      const other = [...$('to-account').options].find((o) => o.value !== $('from-account').value);
      if (other) $('to-account').value = other.value;
    }
  } else {
    setSelect($('account'), accountOptions(values.accountId), values.accountId);
    setSelect($('subject'), subjectOptions(kind === 'IN' ? 'INCOME' : 'EXPENSE', values.subjectId), values.subjectId);
  }
  updatePayerField();
  updateDeductField();
  updateEquipmentField();
}

// ---------------------------------------------------------------- 하루 현황

async function loadDay() {
  const date = $('date').value;
  if (!isValidDate(date)) return;
  const [next, info] = await Promise.all([api(`/api/day?date=${date}`), api(`/api/closings/${date}`)]);
  if (next.date !== $('date').value) return; // 그 사이 날짜가 바뀜
  day = next;
  // 거래 내역 아래: 입력을 마쳤으면 여기서 바로 마감
  $('close-bar').innerHTML = closeBarHtml(info);
  $('date-label').textContent = formatKoreanDate(date);
  $('summary-date').textContent = formatKoreanDate(date);
  renderLock();
  renderSummary();
  renderList();
}

function renderLock() {
  const locked = day.locked;
  $('lock-banner').hidden = !locked;
  $('lock-link').href = href(`/closing?date=${day.date}`);
  $('report-link').href = href(`/journal?date=${day.date}`);
  $('fields').querySelectorAll('input, select, button').forEach((el) => { el.disabled = locked; });
  document.querySelectorAll('.kind-toggle button').forEach((b) => { b.disabled = locked || isKindLocked(b.dataset.kind); });
}

/** 수정 중에는 이체 ↔ 수입·지출 전환 불가 */
function isKindLocked(k) {
  if (!editing) return false;
  return (editing.type === 'TRANSFER') !== (k === 'TRANSFER');
}

function renderSummary() {
  const row = (label, r, cls = '') => `
    <tr class="${cls}"><td>${label}</td>
      <td class="num">${formatWon(r.prev)}</td>
      <td class="num in">${formatWon(r.income)}</td>
      <td class="num out">${formatWon(r.expense)}</td>
      <td class="num">${signedWon(r.transferIn - r.transferOut)}</td>
      <td class="num"><b>${formatWon(r.end)}</b></td></tr>`;
  $('summary').innerHTML = `
    <table class="grid summary">
      <thead><tr><th>구분</th><th class="num">전일잔액</th><th class="num">수입</th><th class="num">지출</th>
        <th class="num">이체</th><th class="num">당일잔액</th></tr></thead>
      <tbody>
        ${day.funds.map((f) => row(esc(f.name), f)).join('')}
        ${row('합계', day.total, 'total')}
      </tbody>
    </table>
    <details>
      <summary>통장별 보기</summary>
      <table class="grid summary">
        <thead><tr><th>통장</th><th class="num">전일잔액</th><th class="num">수입</th><th class="num">지출</th>
          <th class="num">이체</th><th class="num">당일잔액</th></tr></thead>
        <tbody>${day.accounts.map((a) => row(`${esc(a.name)} <span class="muted">${FUND_LABEL[a.fundCode]}</span>`, a)).join('')}</tbody>
      </table>
    </details>`;
}

/** 이체 한 쌍은 목록에서 한 줄로 합쳐 보여준다 */
function mergedRows(txs) {
  const rows = [];
  const seen = new Set();
  for (const t of txs) {
    // 수입 차감은 수입 줄로 (금액은 − 로 보임)
    if (t.kind !== 'TRANSFER') { rows.push({ ...t, type: t.deduction ? 'IN' : t.direction }); continue; }
    if (seen.has(t.transferGroup)) continue;
    seen.add(t.transferGroup);
    const pair = txs.filter((x) => x.transferGroup === t.transferGroup);
    const out = pair.find((x) => x.direction === 'OUT') ?? t;
    const inn = pair.find((x) => x.direction === 'IN');
    rows.push({
      ...out,
      type: 'TRANSFER',
      fromAccountId: out.accountId,
      fromName: out.accountName,
      fromFund: out.fundCode,
      toAccountId: inn?.accountId ?? out.counterpartAccountId,
      toName: inn?.accountName ?? out.counterpartName,
      toFund: inn?.fundCode,
    });
  }
  return rows;
}

function renderList() {
  const rows = mergedRows(day.transactions);
  const sum = (type) => sumAmounts(rows.filter((r) => r.type === type).map((r) => (r.deduction ? -r.amount : r.amount)));
  if (!rows.length) {
    $('list').innerHTML = '<p class="muted">거래가 없습니다.</p>';
    return;
  }
  $('list').innerHTML = `
    <table class="grid tx-list">
      <thead><tr><th class="no">No</th><th>구분</th><th>회계</th><th>통장</th><th>과목</th><th>적요</th>
        <th class="num">수입</th><th class="num">지출</th><th class="num">이체</th><th class="actions"></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
      <tfoot><tr class="total"><td colspan="6">합계 (${rows.length}건)</td>
        <td class="num">${formatWon(sum('IN'))}</td><td class="num">${formatWon(sum('OUT'))}</td>
        <td class="num">${formatWon(sum('TRANSFER'))}</td><td></td></tr></tfoot>
    </table>`;
}

function rowHtml(r, index) {
  const isTransfer = r.type === 'TRANSFER';
  const badge = r.deduction ? '<span class="badge deduct">수입차감</span>'
    : { IN: '<span class="badge in">수입</span>', OUT: '<span class="badge out">지출</span>', TRANSFER: '<span class="badge transfer">이체</span>' }[r.type];
  const fund = isTransfer
    ? (r.fromFund === r.toFund ? FUND_LABEL[r.fromFund] : `${FUND_LABEL[r.fromFund]}→${FUND_LABEL[r.toFund] ?? ''}`)
    : FUND_LABEL[r.fundCode];
  const editingNow = editing && editing.id === r.id;
  return `
    <tr class="${editingNow ? 'editing' : ''}">
      <td class="no">${index + 1}</td>
      <td>${badge}</td>
      <td class="small">${fund}</td>
      <td>${isTransfer ? `${esc(r.fromName)} → ${esc(r.toName ?? '')}` : esc(r.accountName)}</td>
      <td>${esc(r.subjectName ?? '')}</td>
      <td>${r.payer ? `<span class="payer-name" title="납부자">${esc(r.payer)}</span>` : ''}${esc(r.memo)}${r.equipmentNo
        ? ` <a class="small" href="${href(`/equipment?no=${encodeURIComponent(r.equipmentNo)}`)}" title="비품대장에 올라간 비품">📦${esc(r.equipmentNo)}</a>` : ''}</td>
      <td class="num ${r.deduction ? 'minus' : ''}">${r.type === 'IN' ? formatWon(r.deduction ? -r.amount : r.amount) : ''}</td>
      <td class="num">${r.type === 'OUT' ? formatWon(r.amount) : ''}</td>
      <td class="num">${isTransfer ? formatWon(r.amount) : ''}</td>
      <td class="actions">${day.locked ? '' : `
        <button type="button" class="secondary small" data-edit="${r.id}">수정</button>
        <button type="button" class="danger small" data-delete="${r.id}">삭제</button>`}</td>
    </tr>`;
}

// ---------------------------------------------------------------- 입력·저장

function visibleFields() {
  return [...$('fields').querySelectorAll('input, select, button')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function resetForNext() {
  $('amount').value = '';
  $('memo').value = '';
  $('payer').value = '';
  $('deduct').checked = false;
  resetEquipmentFields();
  $('amount').focus();
}

async function save() {
  if (saving || !day || day.locked) return;
  const body = {
    date: $('date').value,
    amount: $('amount').value,
    memo: $('memo').value,
    // 증빙번호 칸은 없앴다. 예전에 적은 번호는 고쳐 저장해도 그대로 둔다
    voucherNo: editing?.voucherNo ?? '',
  };
  try {
    parseAmount(body.amount);
  } catch (err) {
    toast(err.message, 'error');
    $('amount').focus();
    return;
  }
  let pref;
  if (kind === 'TRANSFER') {
    body.fromAccountId = Number($('from-account').value);
    body.toAccountId = Number($('to-account').value);
    if (body.fromAccountId === body.toAccountId) {
      toast('보내는 곳과 받는 곳이 같은 통장입니다.', 'error');
      $('to-account').focus();
      return;
    }
    pref = { fromAccountId: body.fromAccountId, toAccountId: body.toAccountId };
  } else {
    body.direction = kind === 'IN' && $('deduct').checked ? 'OUT' : kind; // 수입 차감은 통장에서 빠지는 쪽
    body.accountId = Number($('account').value);
    body.subjectId = Number($('subject').value);
    if (!$('payer-field').hidden && body.direction === 'IN') body.payer = $('payer').value;
    if (!$('eq-entry').hidden && !$('eq-new').hidden && $('eq-on').checked) {
      const name = $('eq-name').value.trim() || body.memo.trim();
      if (!name) {
        toast('비품 품명을 적어 주세요. (비우면 적요가 품명이 됩니다)', 'error');
        $('eq-name').focus();
        return;
      }
      body.equipment = { name, spec: $('eq-spec').value, quantity: $('eq-qty').value, location: $('eq-location').value };
    }
    if (!body.accountId || !body.subjectId) {
      toast('통장과 예산과목을 선택하세요.', 'error');
      return;
    }
    pref = { accountId: body.accountId, subjectId: body.subjectId };
  }
  saving = true;
  $('save').disabled = true;
  try {
    if (editing) {
      await api(`/api/transactions/${editing.id}`, { method: 'PUT', body });
      toast('수정했습니다.');
      const restore = beforeEdit;
      endEdit(false);
      setKind(restore.kind);
      resetForNext();
    } else {
      await api(kind === 'TRANSFER' ? '/api/transfers' : '/api/transactions', { method: 'POST', body });
      toast('저장했습니다.');
      prefs[kind] = pref; // 수정이 아닌 새 입력만 다음 입력의 기본값으로 기억
      savePrefs();
      resetForNext();
    }
    await loadDay();
    if (body.payer) loadPayers().catch(() => {});
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    saving = false;
    $('save').disabled = !!day?.locked;
  }
}

function startEdit(row) {
  if (!editing) beforeEdit = { kind };
  editing = row;
  setKind(row.type, row.type === 'TRANSFER'
    ? { fromAccountId: row.fromAccountId, toAccountId: row.toAccountId }
    : { accountId: row.accountId, subjectId: row.subjectId });
  $('amount').value = formatWon(row.amount);
  $('memo').value = row.memo;
  $('payer').value = row.payer ?? '';
  $('deduct').checked = Boolean(row.deduction);
  resetEquipmentFields();
  $('eq-on').checked = false; // 고칠 때는 꺼 둔다 (예전에 일부러 안 올린 지출일 수 있음)
  updateEquipmentField();
  $('edit-label').textContent = `#${row.id} ${{ IN: '수입', OUT: '지출', TRANSFER: '이체' }[row.type]} 거래를`;
  $('edit-banner').hidden = false;
  $('entry').classList.add('editing');
  renderLock();
  renderList();
  $('amount').focus();
  $('amount').select();
}

function endEdit(restore = true) {
  editing = null;
  $('edit-banner').hidden = true;
  $('entry').classList.remove('editing');
  if (restore) {
    setKind(beforeEdit?.kind ?? kind);
    $('amount').value = '';
    $('memo').value = '';
    $('payer').value = '';
    resetEquipmentFields();
    updateEquipmentField();
    renderLock();
    renderList();
  }
  beforeEdit = null;
}

async function deleteRow(row) {
  const what = row.type === 'TRANSFER'
    ? `이체 ${row.fromName} → ${row.toName} ${formatWon(row.amount)}원`
    : `${row.accountName} ${formatWon(row.amount)}원 (${row.memo || row.subjectName})`;
  if (!confirm(`${what}

이 거래를 삭제할까요?`)) return;
  try {
    await api(`/api/transactions/${row.id}`, { method: 'DELETE' });
    toast('삭제했습니다.');
    if (editing?.id === row.id) endEdit();
    await loadDay();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- 이벤트

function changeDate(next) {
  if (!isValidDate(next)) return;
  $('date').value = next;
  try { sessionStorage.setItem('bondang.entryDate', next); } catch { /* 무시 */ }
  loadDay().catch((err) => toast(err.message, 'error'));
}

$('date').addEventListener('change', () => changeDate($('date').value));
$('account').addEventListener('change', updatePayerField);
$('close-bar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-close-day]');
  if (b && await closeDay(b.dataset.closeDay)) await loadDay();
});
$('subject').addEventListener('change', () => { updateDeductField(); updateEquipmentField(); });
$('eq-on').addEventListener('change', updateEquipmentField);
$('prev-day').addEventListener('click', () => changeDate(addDays($('date').value, -1)));
$('next-day').addEventListener('click', () => changeDate(addDays($('date').value, 1)));
$('today').addEventListener('click', () => changeDate(todayKST()));

document.querySelector('.kind-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b || b.disabled) return;
  setKind(b.dataset.kind);
  visibleFields()[0]?.focus();
});

$('save').addEventListener('click', save);
$('cancel-edit').addEventListener('click', () => endEdit());

// Enter: 다음 칸, 마지막 칸(또는 저장 버튼)에서 저장
$('fields').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const fields = visibleFields();
  const idx = fields.indexOf(e.target);
  const next = fields[idx + 1];
  if (!next || next === $('save') || e.target === $('save')) save();
  else next.focus();
});

document.addEventListener('keydown', (e) => {
  const keyKind = { F2: 'IN', F3: 'OUT', F4: 'TRANSFER' }[e.key];
  if (keyKind) {
    e.preventDefault();
    if (!day?.locked && !isKindLocked(keyKind)) {
      setKind(keyKind);
      visibleFields()[0]?.focus();
    }
  }
  if (e.key === 'Escape' && editing && !document.querySelector('dialog[open]')) endEdit();
});

$('list').addEventListener('click', (e) => {
  const find = (id) => mergedRows(day.transactions).find((r) => r.id === Number(id));
  const ed = e.target.closest('[data-edit]');
  if (ed) startEdit(find(ed.dataset.edit));
  const del = e.target.closest('[data-delete]');
  if (del) deleteRow(find(del.dataset.delete));
});

// ---------------------------------------------------------------- 시작

initPage('entry').then(async (ctx) => {
  settings = ctx.settings;
  bindAmountInput($('amount'));
  let start = todayKST();
  try { start = sessionStorage.getItem('bondang.entryDate') || start; } catch { /* 무시 */ }
  const param = new URLSearchParams(location.search).get('date');
  if (isValidDate(param)) start = param;
  $('date').value = start;
  $('date').min = settings.parish.startDate;
  setKind('IN');
  loadPayers().catch(() => {});
  await loadDay();
  visibleFields()[0]?.focus();
}).catch((err) => {
  $('list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});

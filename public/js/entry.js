// 거래 입력 화면: 수입·지출·이체 입력, 수정, 삭제 + 통장 가계부 (통장마다 한 달 내역과 잔액)
// 통장 가계부 화면(/book, 특별회계 첫 화면)도 이 코드를 쓴다: 입력 칸 없이 가계부만, [수정]은 거래 입력 화면에서 연다.
// 과목은 고르지 않는다 (통장이 과목 역할). 수입은 봉헌자를 꼭 적는다 (연말정산 때 이름으로 모음).
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, bindAmountInput, toast } from './ui.js';
import { formatWon, parseAmount } from './shared/money.js';
import { addDays, formatKoreanDate, isValidDate, monthStart, todayKST } from './shared/dates.js';

const PREF_KEY = 'bondang.entryPrefs.v2';
const $ = (id) => document.getElementById(id);
const BOOK_ONLY = !$('entry'); // 통장 가계부 화면

let settings = null;
let day = null;         // 입력 날짜의 하루 현황 (잠김 여부)
let lastClosed = null;  // 마지막 마감일 (이 날까지는 고칠 수 없음)
let kind = 'IN';        // 'IN' 수입 | 'OUT' 지출 | 'TRANSFER' 이체
let editing = null;     // 수정 중인 거래 (가계부의 행 객체)
let beforeEdit = null;  // 수정 시작 전 구분 (수정이 끝나면 되돌림)
let saving = false;
let prefs = loadPrefs();
let bookAccountId = null;
let bookMonth = null;   // 'YYYY-MM'
let book = null;        // 가계부 조회 결과
let bookSeq = 0;

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) ?? {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 저장 불가 환경 */ }
}

// ---------------------------------------------------------------- 선택 목록

const usable = (selectedId) => settings.accounts.filter((a) => a.isActive || a.id === selectedId);

function accountOptions(selectedId) {
  return usable(selectedId).map((a) =>
    `<option value="${a.id}">${esc(a.name)}${a.isActive ? '' : ' (사용중지)'}</option>`).join('');
}

function setSelect(select, html, value) {
  select.innerHTML = html;
  if (value != null && select.querySelector(`option[value="${value}"]`)) select.value = String(value);
}

/** 봉헌자 칸: 특별회계 통장의 수입일 때 (꼭 적어야 저장됨) */
function updatePayerField() {
  const account = settings.accounts.find((a) => a.id === Number($('account').value));
  const show = kind === 'IN' && account?.fundCode === 'SPECIAL';
  $('payer-field').hidden = !show;
  if (!show) $('payer').value = '';
}

/** 전에 적은 봉헌자 이름 (자동 완성) */
async function loadPayers() {
  const { payers } = await api('/api/payers');
  $('payer-list').innerHTML = payers.map((p) => `<option value="${esc(p)}">`).join('');
}

/** 구분 전환: 해당 구분에 맞는 입력칸과 마지막으로 쓴 통장을 보여준다 */
function setKind(next, values = prefs[next] ?? {}) {
  kind = next;
  document.querySelectorAll('.kind-toggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.kind === kind);
    b.setAttribute('aria-checked', String(b.dataset.kind === kind));
  });
  $('entry').dataset.kind = kind;
  if (kind === 'TRANSFER') {
    setSelect($('from-account'), accountOptions(values.fromAccountId), values.fromAccountId ?? bookAccountId);
    setSelect($('to-account'), accountOptions(values.toAccountId), values.toAccountId);
    // 두 칸이 같은 통장이면 받는 곳을 다른 통장으로
    if ($('to-account').value === $('from-account').value) {
      const other = [...$('to-account').options].find((o) => o.value !== $('from-account').value);
      if (other) $('to-account').value = other.value;
    }
  } else {
    setSelect($('account'), accountOptions(values.accountId), values.accountId ?? bookAccountId);
  }
  updatePayerField();
}

// ---------------------------------------------------------------- 입력 날짜

async function loadDay() {
  const date = $('date').value;
  if (!isValidDate(date)) return;
  const [next, info] = await Promise.all([api(`/api/day?date=${date}`), api(`/api/closings/${date}`)]);
  if (next.date !== $('date').value) return; // 그 사이 날짜가 바뀜
  day = next;
  lastClosed = info.lastClosed ?? null;
  $('date-label').textContent = formatKoreanDate(date);
  renderLock();
  if (date.slice(0, 7) !== bookMonth) {
    bookMonth = date.slice(0, 7);
    await loadBook();
  } else {
    renderBook();
  }
}

function renderLock() {
  const locked = day.locked;
  $('lock-banner').hidden = !locked;
  $('lock-link').href = href(`/closing?date=${day.date}`);
  $('fields').querySelectorAll('input, select, button').forEach((el) => { el.disabled = locked; });
  document.querySelectorAll('.kind-toggle button').forEach((b) => { b.disabled = locked || isKindLocked(b.dataset.kind); });
}

/** 수정 중에는 이체 ↔ 수입·지출 전환 불가 */
function isKindLocked(k) {
  if (!editing) return false;
  return (editing.type === 'TRANSFER') !== (k === 'TRANSFER');
}

// ---------------------------------------------------------------- 통장 가계부

const monthEnd = (ym) => addDays(`${addDays(`${ym}-01`, 31).slice(0, 7)}-01`, -1);

async function loadBook() {
  if (!bookAccountId) return;
  const seq = ++bookSeq;
  const r = await api(`/api/transactions?from=${bookMonth}-01&to=${monthEnd(bookMonth)}&accountId=${bookAccountId}`);
  if (seq !== bookSeq) return; // 늦게 온 예전 결과는 버린다
  book = r;
  renderBook();
}

function renderTabs() {
  $('book-tabs').innerHTML = usable(bookAccountId).map((a) =>
    `<button type="button" role="tab" data-book="${a.id}" class="${a.id === bookAccountId ? 'active' : ''}"
      aria-selected="${a.id === bookAccountId}">${esc(a.name)}</button>`).join('');
}

/** 가계부 한 줄 (이체는 상대 통장을 화살표로) */
function bookRow(t) {
  if (t.kind === 'TRANSFER') {
    const out = t.direction === 'OUT';
    return {
      ...t,
      type: 'TRANSFER',
      fromAccountId: out ? t.accountId : t.counterpartAccountId,
      toAccountId: out ? t.counterpartAccountId : t.accountId,
      fromName: out ? t.accountName : t.counterpartName,
      toName: out ? t.counterpartName : t.accountName,
      what: `이체 ${out ? '→' : '←'} ${t.counterpartName ?? ''}`,
    };
  }
  return { ...t, type: t.direction, what: '' };
}

function renderBook() {
  renderTabs();
  const [y, m] = bookMonth.split('-').map(Number);
  const account = settings.accounts.find((a) => a.id === bookAccountId);
  $('book-month').textContent = `${account ? `${account.name} · ` : ''}${y}년 ${m}월`;
  if (!book) { $('book').innerHTML = '<p class="muted">불러오는 중…</p>'; return; }
  const rows = book.rows.filter((t) => t.status === 'POSTED').map(bookRow);
  const md = (d) => `${d.slice(5, 7)}.${d.slice(8, 10)}`;
  const inSum = book.totals.income + book.totals.transferIn;
  const outSum = book.totals.expense + book.totals.transferOut;
  const end = rows.length ? rows[rows.length - 1].balanceAfter : book.openingBalance;
  $('book').innerHTML = `
    <table class="grid tx-list book">
      <thead><tr><th class="date">날짜</th><th>내용</th><th>봉헌자</th><th class="num">수입</th><th class="num">지출</th>
        <th class="num">잔액</th><th class="actions"></th></tr></thead>
      <tbody>
        <tr class="carry"><td class="date">${md(`${bookMonth}-01`)}</td><td>전월이월</td><td></td><td></td><td></td>
          <td class="num">${formatWon(book.openingBalance)}</td><td></td></tr>
        ${rows.map((r) => {
          const editable = !(lastClosed && r.date <= lastClosed);
          const isIn = r.direction === 'IN';
          return `<tr class="${editing && editing.id === r.id ? 'editing' : ''} ${!BOOK_ONLY && r.date === $('date').value ? 'today-row' : ''}">
            <td class="date">${md(r.date)}</td>
            <td>${r.what ? `<span class="xfer">${esc(r.what)}</span> ` : ''}${esc(r.memo)}</td>
            <td>${esc(r.payer)}</td>
            <td class="num in">${isIn ? formatWon(r.amount) : ''}</td>
            <td class="num out">${isIn ? '' : formatWon(r.amount)}</td>
            <td class="num">${r.balanceAfter == null ? '' : formatWon(r.balanceAfter)}</td>
            <td class="actions">${editable ? `
              <button type="button" class="secondary small" data-edit="${r.id}">수정</button>
              <button type="button" class="danger small" data-delete="${r.id}">삭제</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot><tr class="total"><td></td><td>이 달 합계 (${rows.length}건)</td><td></td>
        <td class="num">${formatWon(inSum)}</td><td class="num">${formatWon(outSum)}</td>
        <td class="num">${formatWon(end)}</td><td></td></tr></tfoot>
    </table>
    ${book.truncated ? '<p class="error">거래가 너무 많아 일부만 보입니다.</p>' : ''}`;
}

function selectBook(accountId) {
  if (!accountId || accountId === bookAccountId) return;
  bookAccountId = accountId;
  book = null;
  renderBook();
  loadBook().catch((err) => toast(err.message, 'error'));
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
  visibleFields()[0]?.focus();
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
      toast('보내는 통장과 받는 통장이 같습니다.', 'error');
      $('to-account').focus();
      return;
    }
    pref = { fromAccountId: body.fromAccountId, toAccountId: body.toAccountId };
  } else {
    body.direction = kind;
    body.accountId = Number($('account').value);
    if (!body.accountId) {
      toast('통장을 선택하세요.', 'error');
      return;
    }
    if (!$('payer-field').hidden) {
      body.payer = $('payer').value.trim();
      if (!body.payer) {
        toast('수입은 봉헌자 이름을 꼭 적어야 합니다.', 'error');
        $('payer').focus();
        return;
      }
    }
    pref = { accountId: body.accountId };
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
    } else {
      await api(kind === 'TRANSFER' ? '/api/transfers' : '/api/transactions', { method: 'POST', body });
      toast('저장했습니다.');
      prefs[kind] = pref; // 수정이 아닌 새 입력만 다음 입력의 기본값으로 기억
      savePrefs();
    }
    resetForNext();
    // 저장한 통장의 가계부를 보여 준다
    const shown = kind === 'TRANSFER' ? body.fromAccountId : body.accountId;
    if (shown !== bookAccountId) { bookAccountId = shown; book = null; }
    await loadDay();
    await loadBook();
    if (body.payer) loadPayers().catch(() => {});
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    saving = false;
    $('save').disabled = !!day?.locked;
  }
}

async function startEdit(row) {
  // 다른 날짜의 거래면 입력 날짜를 그 날로 옮긴다
  if (row.date !== $('date').value) {
    $('date').value = row.date;
    await loadDay();
  }
  if (!editing) beforeEdit = { kind };
  editing = row;
  setKind(row.type, row.type === 'TRANSFER'
    ? { fromAccountId: row.fromAccountId, toAccountId: row.toAccountId }
    : { accountId: row.accountId });
  $('amount').value = formatWon(row.amount);
  $('memo').value = row.memo;
  $('payer').value = row.payer ?? '';
  $('edit-label').textContent = `${row.date.slice(5).replace('-', '.')} ${{ IN: '수입', OUT: '지출', TRANSFER: '이체' }[row.type]} 거래를`;
  $('edit-banner').hidden = false;
  $('entry').classList.add('editing');
  renderLock();
  renderBook();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    renderLock();
    renderBook();
  }
  beforeEdit = null;
}

async function deleteRow(row) {
  const what = row.type === 'TRANSFER'
    ? `이체 ${row.fromName} → ${row.toName} ${formatWon(row.amount)}원`
    : `${row.accountName} ${formatWon(row.amount)}원${row.memo ? ` (${row.memo})` : ''}`;
  if (!confirm(`${row.date} ${what}

이 거래를 삭제할까요?`)) return;
  try {
    await api(`/api/transactions/${row.id}`, { method: 'DELETE' });
    toast('삭제했습니다.');
    if (editing?.id === row.id) endEdit();
    await loadBook();
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

const run = (p) => p.catch((err) => toast(err.message, 'error'));

if (!BOOK_ONLY) {
$('date').addEventListener('change', () => changeDate($('date').value));
$('account').addEventListener('change', () => {
  updatePayerField();
  selectBook(Number($('account').value));
});
$('from-account').addEventListener('change', () => selectBook(Number($('from-account').value)));
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
}

// 통장 고르기: 가계부가 바뀌고, 수입·지출 입력 통장도 따라간다
$('book-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-book]');
  if (!b) return;
  const id = Number(b.dataset.book);
  if (!BOOK_ONLY && !editing && kind !== 'TRANSFER' && $('account').querySelector(`option[value="${id}"]`)) {
    $('account').value = String(id);
    updatePayerField();
  }
  selectBook(id);
});
const shiftMonth = (dir) => {
  bookMonth = addDays(`${bookMonth}-01`, dir > 0 ? 31 : -1).slice(0, 7);
  book = null;
  renderBook();
  run(loadBook());
};
$('book-prev').addEventListener('click', () => shiftMonth(-1));
$('book-next').addEventListener('click', () => shiftMonth(1));

$('book').addEventListener('click', (e) => {
  const find = (id) => book.rows.map(bookRow).find((r) => r.id === Number(id));
  const ed = e.target.closest('[data-edit]');
  if (ed && BOOK_ONLY) {
    const r = find(ed.dataset.edit);
    location.href = href(`/entry?date=${r.date}&account=${bookAccountId}&edit=${r.id}`);
    return;
  }
  if (ed) run(startEdit(find(ed.dataset.edit)));
  const del = e.target.closest('[data-delete]');
  if (del) deleteRow(find(del.dataset.delete));
});

// ---------------------------------------------------------------- 시작

/** 통장 가계부 화면: 마지막에 쓴 통장(또는 첫 통장)의 이번 달 */
async function startBook() {
  const p = new URLSearchParams(location.search);
  const want = Number(p.get('account')) || prefs.IN?.accountId;
  bookAccountId = (usable(null).find((a) => a.id === want) ?? usable(null)[0])?.id ?? null;
  bookMonth = /^\d{4}-\d{2}$/.test(p.get('month') ?? '') ? p.get('month') : todayKST().slice(0, 7);
  if (!bookAccountId) {
    $('book').innerHTML = `<p class="muted">등록된 통장이 없습니다. <a href="${href('/settings?s=acct#accounts')}">통장 등록</a></p>`;
    return;
  }
  [lastClosed] = await Promise.all([api(`/api/closings/${todayKST()}`).then((r) => r.lastClosed ?? null), loadBook()]);
  renderBook();
}

initPage(BOOK_ONLY ? 'book' : 'entry').then(async (ctx) => {
  settings = ctx.settings;
  if (BOOK_ONLY) return startBook();
  bindAmountInput($('amount'));
  let start = todayKST();
  try { start = sessionStorage.getItem('bondang.entryDate') || start; } catch { /* 무시 */ }
  const param = new URLSearchParams(location.search).get('date');
  if (isValidDate(param)) start = param;
  $('date').value = start;
  $('date').min = settings.parish.startDate;
  const first = usable(null)[0];
  const p = new URLSearchParams(location.search);
  bookAccountId = (usable(null).find((a) => a.id === (Number(p.get('account')) || prefs.IN?.accountId)) ?? first)?.id ?? null;
  if (p.get('account')) prefs.IN = { accountId: bookAccountId }; // 가계부에서 [수정]으로 왔으면 그 통장
  setKind('IN');
  bookAccountId = Number($('account').value) || bookAccountId;
  if (!bookAccountId) $('book').innerHTML = `<p class="muted">등록된 통장이 없습니다. <a href="${href('/settings?s=acct#accounts')}">통장 등록</a></p>`;
  loadPayers().catch(() => {});
  await loadDay();
  // 통장 가계부에서 [수정]을 눌러 왔으면 그 거래를 바로 연다
  const editRow = book?.rows.map(bookRow).find((r) => r.id === Number(p.get('edit')));
  if (p.has('edit')) history.replaceState(null, '', location.pathname); // 새로고침하면 그냥 입력 화면
  if (editRow) return startEdit(editRow);
  visibleFields()[0]?.focus();
}).catch((err) => {
  $('book').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});

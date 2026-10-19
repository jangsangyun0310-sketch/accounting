// 화면 공용 부품: 상단 메뉴, 금액 입력칸, 알림, 결재란 미리보기
import { href } from './base.js';
import { api, esc } from './api.js';
import { formatWon } from './shared/money.js';
import { currentAccount, logout } from './account.js';
import { APPROVAL_DOC_LABEL } from './shared/approval-docs.js';

// 위 메뉴: 큰 묶음(회계 · 사목일지 · 재산관리 · 설정)을 누르면 첫 화면이 열리고, 아래 줄에 그 묶음의 작은 메뉴가 보인다.
// icon: 휴대폰 화면 아래 메뉴 바에서만 보이는 그림 (휴대폰 아래 바: 홈 · 회계 · 사목일지 · 재산관리)
const ICON = {
  home: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  acct: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  journal: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M12 6v6M9.5 8.5h5"/></svg>',
  property: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
};
// items: [주소, 이름, 화면 key]. 묶음마다 아래 줄 끝에 ⚙ 설정 (그 기능에 필요한 설정만)
// 본당살림은 특별회계만 (일반회계 · 사목일지는 양업). 사목일지 화면은 메뉴에서 뺐다
const GROUPS = [
  { key: 'acct', label: '특별회계', home: '/', items: [['/entry', '거래 입력', 'entry'], ['/closing', '일 마감', 'closing'], ['/ledger', '거래 조회', 'ledger'], ['/report', '결산서', 'report']] },
  { key: 'property', label: '재산관리', items: [['/equipment', '비품대장', 'equipment']] },
];
/**
 * 설정 항목 묶음 (settings.js 가 주소의 ?s=묶음#항목 으로 화면을 고른다).
 * '' = 오른쪽 위 [⚙ 설정]: 성당 전체에 관한 것만.
 */
export const SETTINGS_SCOPES = {
  acct: [['accounts', '통장'], ['approval-main', '결산서 결재란']],
  '': [['parish', '성당 정보'], ['backup', '백업'], ['members', '함께 사용'], ['account', '초기화 · 탈퇴']],
};
// 예전 주소(#approval 등)도 맞는 묶음으로
const OLD_TABS = { approval: 'approval-main' };
/** 지금 주소 → { scope, tab } */
export function settingsPlace() {
  let tab = location.hash.slice(1);
  tab = OLD_TABS[tab] ?? tab;
  let scope = new URLSearchParams(location.search).get('s') ?? '';
  if (!(scope in SETTINGS_SCOPES)) scope = '';
  if (!SETTINGS_SCOPES[scope].some(([k]) => k === tab)) {
    const owner = Object.keys(SETTINGS_SCOPES).find((sc) => SETTINGS_SCOPES[sc].some(([k]) => k === tab));
    if (owner != null && !new URLSearchParams(location.search).has('s')) scope = owner;
    else tab = SETTINGS_SCOPES[scope][0][0];
  }
  return { scope, tab };
}

/** 지금 화면이 속한 묶음 (설정 화면이면 ?s= 묶음, 오른쪽 위 설정이면 null) */
function groupOf(active) {
  if (active === 'settings') return GROUPS.find((g) => g.key === settingsPlace().scope) ?? null;
  if (active === 'home') return GROUPS.find((g) => g.home === '/'); // [특별회계] = 홈 화면 (통장별 잔액)
  return GROUPS.find((x) => x.items.some(([, , key]) => key === active)) ?? null;
}

/** 위 메뉴 아래 줄: [주소, 이름, 지금 화면인지, 위험 표시, 모양] 목록 */
function subItems(active) {
  const g = groupOf(active);
  if (!g) {
    if (active !== 'settings') return [];
    const { tab } = settingsPlace(); // 오른쪽 위 [⚙ 설정]: 성당 전체 설정 항목
    return SETTINGS_SCOPES[''].map(([k, label]) => [`/settings#${k}`, label, k === tab, k === 'account']);
  }
  return [
    // 묶음 이름과 같은 메뉴(사목일지 → 사목일지)는 위 메뉴와 겹치니 아래 줄에서 뺀다
    ...g.items.filter(([, label]) => label !== g.label).map(([path, label, key]) => [path, label, key === active, false]),
    // 메뉴 바로 뒤에 버튼 모양으로 (설정할 것이 있는 묶음만)
    ...(SETTINGS_SCOPES[g.key] ? [[`/settings?s=${g.key}`, `⚙ ${g.label} 설정`, active === 'settings', false, 'setting']] : []),
  ];
}

// [도움말]은 업무 메뉴와 떨어진 오른쪽(로그아웃 옆)에 두고, 지금 보고 있는 화면의 설명으로 바로 연다
const HELP_SECTION = { home: 'start', setup: 'start', entry: 'entry', ledger: 'ledger', closing: 'closing', journal: 'journal', equipment: 'equipment', report: 'report', settings: 'settings' };

/**
 * 페이지 공통 초기화: 사용자·설정을 불러오고 상단 메뉴를 그린다.
 * 최초 설정이 안 되어 있으면 설정 마법사로 이동한다.
 */
export async function initPage(active, { requireSetup = true } = {}) {
  const account = await currentAccount(); // 로그인이 풀렸으면 여기서 로그인 화면으로 간다
  const [me, settings] = await Promise.all([api('/api/me'), api('/api/settings')]);
  if (requireSetup && !settings.setupCompleted) {
    location.replace(href('/setup'));
    return new Promise(() => {}); // 이동 중에는 이후 코드 실행 안 함
  }
  const bar = document.getElementById('topbar');
  if (bar) {
    bar.classList.add('topbar');
    // 성당 이름·작성자 이름은 화면 캡처에 나오지 않도록 상단 막대에 표시하지 않는다
    // 메뉴 줄은 모든 화면에서 같은 폭 (넓은 화면 기준) — 메뉴를 옮겨 다녀도 로고 · 메뉴 위치가 그대로
    const width = 'wide';
    const ready = settings.setupCompleted;
    const group = groupOf(active);
    const sub = ready ? subItems(active) : [];
    const subHtml = () => sub.map(([path, label, on, danger, cls = '']) =>
      `<a href="${href(path)}" class="${on ? 'active' : ''}${danger ? ' danger' : ''} ${cls}">${label}</a>`).join('');
    bar.classList.toggle('has-sub', sub.length > 0);
    bar.innerHTML = `<div class="topbar-inner${width ? ` ${width}` : ''}">
      <a href="${href('/')}" class="brand"><img src="/img/logo.png" alt="본당살림" width="171" height="48"></a>
      <nav>${ready ? `<a href="${href('/')}" class="nav-home ${active === 'home' ? 'active' : ''}"><span class="ni">${ICON.home}</span><span class="nl">홈</span></a>`
        + GROUPS.map((g) => `<a href="${href(g.home ?? g.items[0][0])}" class="${g === group ? 'active' : ''}"><span class="ni">${ICON[g.key]}</span><span class="nl">${g.label}</span></a>`).join('') : ''}</nav>
      ${ready ? `<a href="${href('/settings')}" class="settings-link ${active === 'settings' && !group ? 'active' : ''}" title="성당 정보 · 백업 · 함께 사용">⚙ 성당 설정</a>` : ''}
      <span class="m-break" aria-hidden="true"></span>
      <button type="button" class="share-btn" id="share-btn" title="다른 성당에 본당살림 알려주기">공유하기</button>
      <span class="account"><a class="help-link ${active === 'help' ? 'active' : ''}" href="${href(HELP_SECTION[active] ? `/help#${HELP_SECTION[active]}` : '/help')}">도움말</a>
        <button type="button" class="secondary small" id="logout-btn"
        title="${esc(account.user.email)} 계정으로 로그인되어 있습니다">로그아웃</button></span></div>
      ${sub.length ? `<div class="subnav"><div class="subnav-inner topbar-inner${width ? ` ${width}` : ''}">${subHtml()}</div></div>` : ''}`;
    // 설정: 아래 줄에서 항목을 고르면 주소의 #항목 이 바뀐다 → 고른 항목 표시
    if (active === 'settings') {
      addEventListener('hashchange', () => {
        const inner = bar.querySelector('.subnav-inner');
        if (inner) { sub.splice(0, sub.length, ...subItems('settings')); inner.innerHTML = subHtml(); }
      });
    }
    bar.querySelector('#share-btn')?.addEventListener('click', openShareDialog);
    bar.querySelector('#logout-btn')?.addEventListener('click', logout);
    document.body.classList.toggle('has-bottom-nav', Boolean(settings.setupCompleted));
  }
  // 입력자 · 처리자: 내 로그인 메일은 결산서 작성자 이름으로 보여 준다 (기록은 메일 그대로)
  myEmail = account.user.email;
  myName = settings.parish?.writerName?.trim() || '';
  return { me, settings, account };
}

let myEmail = '';
let myName = '';
/** 기록된 입력자(메일 또는 예전 기록의 이름) → 화면에 보일 이름. 내 메일이면 작성자 이름 */
export const personName = (who) => (who && myName && who === myEmail ? myName : who ?? '');

// 다른 성당에 보낼 링크: 사이트 주소만 보낸다. 장부는 성당마다 따로라 우리 자료는 전혀 가지 않는다.
function openShareDialog() {
  const link = `${location.origin}/`;
  let dlg = document.getElementById('share-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'share-dialog';
    document.body.append(dlg);
    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
      if (e.target.closest('[data-copy]')) {
        try {
          await navigator.clipboard.writeText(link);
          toast('링크를 복사했습니다. 카카오톡이나 문자에 붙여 넣으세요.');
        } catch {
          toast('복사하지 못했습니다. 링크를 직접 선택해 복사하세요.', 'error');
        }
      }
    });
  }
  dlg.innerHTML = `
    <h3>🔗 다른 성당에 본당살림 알려주기</h3>
    <p>아래 링크를 다른 성당 사무장님께 보내 주세요.</p>
    <div class="copy-row big"><input readonly value="${esc(link)}"><button type="button" data-copy>링크 복사</button></div>
    <ul class="start-points">
      <li>링크를 열고 <b>Google 계정으로 로그인</b>한 뒤 성당 이름을 등록하면 됩니다.</li>
      <li>장부는 성당마다 따로 만들어집니다. <b>우리 성당 자료는 전혀 전달되지 않습니다.</b></li>
    </ul>
    <div class="dialog-foot"><button type="button" class="secondary" data-close>닫기</button></div>`;
  dlg.showModal();
}

/**
 * 금액 입력칸: 숫자만 받고 입력 중 천 단위 쉼표를 붙인다. 커서 위치는 유지한다.
 */
export function bindAmountInput(input) {
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('autocomplete', 'off');
  input.classList.add('amount');
  const reformat = () => {
    const caret = input.selectionStart ?? input.value.length;
    const digitsRight = input.value.slice(caret).replace(/\D/g, '').length;
    const digits = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
    input.value = digits ? formatWon(Number(digits)) : '';
    // 오른쪽에 있던 숫자 개수를 기준으로 커서 복원
    let pos = input.value.length;
    for (let seen = 0; pos > 0 && seen < digitsRight; pos--) {
      if (/\d/.test(input.value[pos - 1])) seen++;
    }
    input.setSelectionRange(pos, pos);
  };
  input.addEventListener('input', reformat);
  if (input.value) reformat();
}

/** 화면 아래 잠깐 나타나는 알림 */
export function toast(message, type = 'ok') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  box.textContent = message;
  box.className = `show ${type}`;
  clearTimeout(box._timer);
  box._timer = setTimeout(() => { box.className = ''; }, type === 'error' ? 5000 : 2500);
}

/** 오류를 알림으로 보여주는 래퍼. 성공하면 true */
export async function attempt(fn, successMessage) {
  try {
    await fn();
    if (successMessage) toast(successMessage);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

/** 결재란 (화면 미리보기와 결산서 공용). 결재 칸은 명칭 길이와 관계없이 모두 같은 너비 */
export function approvalBoxHtml(titles) {
  if (!titles.length) return '<p class="muted">결재란 없음</p>';
  return `<table class="approval-box" style="--steps:${titles.length}">
    <colgroup><col class="vertical">${titles.map(() => '<col class="step">').join('')}</colgroup>
    <tr><th rowspan="2" class="vertical">결<br>재</th>
    ${titles.map((t) => `<th>${esc(t)}</th>`).join('')}</tr>
    <tr>${titles.map(() => '<td></td>').join('')}</tr></table>`;
}

/** 결재 단계 수 고르기: 없음(결재란 빼기) · 1 ~ 10단계 */
export const approvalCountOptions = (count) => Array.from({ length: 11 }, (_, i) =>
  `<option value="${i}" ${i === count ? 'selected' : ''}>${i ? `${i}단계` : '없음 (결재란 빼기)'}</option>`).join('');

/**
 * [결재란 고치기] · [＋ 결재란 넣기]: 그 서류의 결재란을 그 자리에서 바꾼다. doc = APPROVAL_DOC_LABEL 의 열쇠.
 * fixed: 이미 마감해 결재란이 정해진 일일결산 (바꾸면 다음 마감부터). 저장하면 새 직함 목록, 그냥 닫으면 null.
 */
export async function editApproval(doc, { fixed = false } = {}) {
  const s = await api('/api/settings');
  let titles = [...(s.approvals[doc] ?? [])];
  if (!titles.length) titles = ['']; // [＋ 결재란 넣기]: 한 칸부터
  const label = APPROVAL_DOC_LABEL[doc];
  const dlg = document.createElement('dialog');
  dlg.className = 'approval-dialog';
  document.body.append(dlg);
  const draw = () => {
    dlg.innerHTML = `
      <div class="dialog-head"><h3>결재란 고치기 <span class="muted small">${label}</span></h3></div>
      <label class="inline">결재 단계 수 <select class="ad-count">${approvalCountOptions(titles.length)}</select></label>
      <div class="form-grid ad-titles">${titles.map((t, i) => `<label>${i + 1}단계 <input data-i="${i}" value="${esc(t)}" maxlength="12"></label>`).join('')}</div>
      <div class="ad-preview">${approvalBoxHtml(titles.map((t) => t.trim() || '　'))}</div>
      <p class="help">왼쪽부터 순서대로 인쇄됩니다. <b>없음</b>을 고르면 ${label}에서 결재란이 빠집니다.
        ${fixed ? '<br>이 날은 이미 마감해서 <b>마감할 때의 결재란</b>으로 인쇄됩니다. 여기서 바꾸면 <b>다음에 마감하는 날부터</b> 들어갑니다.' : ''}</p>
      <div class="dialog-foot"><button type="button" class="secondary" data-close>닫기</button><button type="button" data-save>저장</button></div>`;
  };
  draw();
  dlg.showModal();
  dlg.querySelector('input')?.focus();
  return new Promise((resolve) => {
    let result = null;
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('change', (e) => {
      if (!e.target.classList.contains('ad-count')) return;
      titles = Array.from({ length: Number(e.target.value) }, (_, i) => titles[i] ?? '');
      draw();
    });
    dlg.addEventListener('input', (e) => {
      if (e.target.dataset.i == null) return;
      titles[e.target.dataset.i] = e.target.value;
      dlg.querySelector('.ad-preview').innerHTML = approvalBoxHtml(titles.map((t) => t.trim() || '　'));
    });
    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
      if (!e.target.closest('[data-save]')) return;
      try {
        await api(`/api/approvals/${doc}`, { method: 'PUT', body: { titles } });
        result = titles.map((t) => t.trim());
        toast(titles.length ? `${label} 결재란을 저장했습니다.` : `${label}에서 결재란을 뺐습니다.`);
        dlg.close();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/** 이체 순액처럼 부호가 의미 있는 금액: +1,000 / -1,000 / 0 */
export const signedWon = (n) => (n > 0 ? `+${formatWon(n)}` : formatWon(n));

/** 거래 구분 이름 (통장 기준: 이체는 들어온 쪽/나간 쪽 구분) */
export function typeLabel(t) {
  if (t.kind === 'TRANSFER') return t.direction === 'OUT' ? '이체출금' : '이체입금';
  if (t.deduction) return '수입차감';
  return t.direction === 'IN' ? '수입' : '지출';
}

export const FUND_LABEL = { GENERAL: '일반회계', SPECIAL: '특별회계' };
export const KIND_LABEL = { INCOME: '수입', EXPENSE: '지출' };

// ---------------------------------------------------------------- 마감 전 안내 (거래 입력 · 사목일지)

/**
 * 마감 전 한 줄 안내: info = GET /api/closings/:date 응답. 마감은 [일 마감] 화면에서만 한다.
 * 마감했거나 마감할 날이 아니면(미래 · 개시일 전) 빈 글자.
 */
export function closeNoticeHtml(info) {
  const d = info.date;
  if (info.closing?.status === 'CLOSED' || (info.lastClosed && d <= info.lastClosed) || d > info.today || d < info.startDate) return '';
  const first = !info.canClose && info.nextRequired && info.nextRequired < d ? info.nextRequired : null; // 앞 날짜가 먼저
  return `<p class="close-note no-print"><b>${formatDay(d)}</b> · 마감 전입니다${first ? ` (마감은 하루씩 순서대로 — ${formatDay(first)}부터)` : ''}
    <a href="${href(`/closing?date=${first ?? d}`)}">일 마감 →</a></p>`;
}

const formatDay = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;

// ---------------------------------------------------------------- 결재란 + [결재란 고치기] (사목일지 · 결산서)

/**
 * 서류의 결재란 칸 (모든 서류 같은 모양 · 같은 자리: 제목 오른쪽). 인쇄에는 나오지 않는 버튼 포함.
 * 결재란을 뺀 서류는 [＋ 결재란 넣기] 버튼만 남는다 (인쇄에는 아무것도 없음).
 * fixed: 마감한 날의 일일결산 — 마감할 때의 결재란을 그대로 보여 주고, 고치면 다음 마감부터.
 */
export function approvalAreaHtml(titles, doc, { fixed = false } = {}) {
  const attrs = `data-approval-kind="${doc}"${fixed ? ' data-approval-fixed="1"' : ''}`;
  if (!titles.length) {
    return `<div class="r-approval empty no-print" ${attrs}>
      <button type="button" class="secondary small approval-edit" data-approval-edit="${doc}">＋ 결재란 넣기</button></div>`;
  }
  return `<div class="r-approval" ${attrs}><div class="ab">${approvalBoxHtml(titles)}</div>
    <button type="button" class="secondary small approval-edit no-print" data-approval-edit="${doc}">결재란 고치기</button></div>`;
}

/** 서류 머리 (제목 + 결재란). 결재 칸이 5칸 이상이면 결재란을 제목 아래로 내린다 */
export const reportHeadHtml = (titleHtml, titles, doc, opts) => `
  <div class="r-head ${titles.length > 4 ? 'stacked' : ''}">
    <div class="r-title">${titleHtml}</div>
    ${approvalAreaHtml(titles, doc, opts)}
  </div>`;

// [결재란 고치기]를 누르면 창에서 고치고, 화면의 결재란을 바로 바꾼다 (마감한 날의 일일결산은 그대로)
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-approval-edit]');
  if (!b) return;
  const doc = b.dataset.approvalEdit;
  const fixed = Boolean(b.closest('[data-approval-fixed]'));
  const titles = await editApproval(doc, { fixed });
  if (!titles) return;
  document.querySelectorAll(`[data-approval-kind="${doc}"]:not([data-approval-fixed])`).forEach((el) => {
    el.closest('.r-head')?.classList.toggle('stacked', titles.length > 4);
    el.outerHTML = approvalAreaHtml(titles, doc);
  });
  document.dispatchEvent(new CustomEvent('approval-changed', { detail: { doc, titles } }));
});

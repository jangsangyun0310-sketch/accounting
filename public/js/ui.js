// 화면 공용 부품: 상단 메뉴, 금액 입력칸, 알림, 결재란 미리보기
import { href } from './base.js';
import { api, esc } from './api.js';
import { formatWon } from './shared/money.js';
import { currentAccount, logout } from './account.js';

// icon: 휴대폰 화면 아래 메뉴 바에서만 보이는 그림
const NAV = [
  { href: '/', label: '홈', key: 'home', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>' },
  { href: '/entry', label: '거래 입력', key: 'entry', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/></svg>' },
  { href: '/ledger', label: '거래 조회', key: 'ledger', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>' },
  { href: '/closing', label: '일 마감', key: 'closing', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/></svg>' },
  { href: '/report', label: '결산', key: 'report', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h7"/></svg>' },
];

// [도움말]은 업무 메뉴와 떨어진 오른쪽(로그아웃 옆)에 두고, 지금 보고 있는 화면의 설명으로 바로 연다
const HELP_SECTION = { home: 'start', setup: 'start', entry: 'entry', ledger: 'ledger', closing: 'closing', report: 'report', settings: 'settings' };

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
    // 메뉴 줄의 왼쪽·오른쪽 끝을 본문 상자 줄에 맞춘다 (본문과 같은 폭)
    // (결산 화면도 다른 화면과 같은 폭: A4 폭에 맞추면 메뉴가 두 줄이 된다)
    const width = ['wide', 'narrow'].find((w) => document.querySelector('main.container')?.classList.contains(w));
    bar.innerHTML = `<div class="topbar-inner${width ? ` ${width}` : ''}">
      <a href="${href('/')}" class="brand"><img src="/img/logo.png" alt="본당살림" width="171" height="48"></a>
      ${settings.setupCompleted
        ? `<a href="${href('/settings')}" class="settings-link ${active === 'settings' ? 'active' : ''}">⚙ 설정</a>` : ''}
      <nav>${settings.setupCompleted ? NAV.map((n) =>
        `<a href="${href(n.href)}" class="${n.key === active ? 'active' : ''}"><span class="ni">${n.icon}</span><span class="nl">${n.label}</span></a>`).join('') : ''}</nav>
      <button type="button" class="more-btn" id="more-btn" aria-expanded="false" aria-label="메뉴 더 보기">⋯</button>
      <span class="account"><a class="help-link ${active === 'help' ? 'active' : ''}" href="${href(HELP_SECTION[active] ? `/help#${HELP_SECTION[active]}` : '/help')}">도움말</a>
        <button type="button" class="secondary small" id="logout-btn"
        title="${esc(account.user.email)} 계정으로 로그인되어 있습니다">로그아웃</button></span>
      <button type="button" class="share-btn" id="share-btn" title="다른 성당에 본당살림 알려주기">공유하기</button></div>`;
    bar.querySelector('#share-btn')?.addEventListener('click', openShareDialog);
    bar.querySelector('#logout-btn')?.addEventListener('click', logout);
    // 휴대폰: [⋯]를 누르면 로그아웃·공유하기가 펼쳐진다
    bar.querySelector('#more-btn')?.addEventListener('click', (e) => {
      const open = bar.classList.toggle('menu-open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    document.body.classList.toggle('has-bottom-nav', Boolean(settings.setupCompleted));
  }
  return { me, settings, account };
}

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
  if (!titles.length) return '<p class="muted">결재 단계가 없습니다.</p>';
  return `<table class="approval-box" style="--steps:${titles.length}">
    <colgroup><col class="vertical">${titles.map(() => '<col class="step">').join('')}</colgroup>
    <tr><th rowspan="2" class="vertical">결<br>재</th>
    ${titles.map((t) => `<th>${esc(t)}</th>`).join('')}</tr>
    <tr>${titles.map(() => '<td></td>').join('')}</tr></table>`;
}

/** 이체 순액처럼 부호가 의미 있는 금액: +1,000 / -1,000 / 0 */
export const signedWon = (n) => (n > 0 ? `+${formatWon(n)}` : formatWon(n));

/** 거래 구분 이름 (통장 기준: 이체는 들어온 쪽/나간 쪽 구분) */
export function typeLabel(t) {
  if (t.kind === 'TRANSFER') return t.direction === 'OUT' ? '이체출금' : '이체입금';
  return t.direction === 'IN' ? '수입' : '지출';
}

export const FUND_LABEL = { GENERAL: '일반회계', SPECIAL: '특별회계' };
export const KIND_LABEL = { INCOME: '수입', EXPENSE: '지출' };

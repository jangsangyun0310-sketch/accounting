// 화면 공용 부품: 상단 메뉴, 금액 입력칸, 알림, 결재란 미리보기
import { api, esc } from './api.js';
import { formatWon } from './shared/money.js';

const NAV = [
  { href: '/', label: '홈', key: 'home' },
  { href: '/entry', label: '거래 입력', key: 'entry' },
  { href: '/ledger', label: '거래 조회', key: 'ledger' },
  { href: '/closing', label: '일 마감', key: 'closing' },
  { href: '/report', label: '결산서', key: 'report' },
  { href: '/settings', label: '설정', key: 'settings' },
];

/**
 * 페이지 공통 초기화: 사용자·설정을 불러오고 상단 메뉴를 그린다.
 * 최초 설정이 안 되어 있으면 설정 마법사로 이동한다.
 */
export async function initPage(active, { requireSetup = true } = {}) {
  const [me, settings] = await Promise.all([api('/api/me'), api('/api/settings')]);
  if (requireSetup && !settings.setupCompleted) {
    location.replace('/setup');
    return new Promise(() => {}); // 이동 중에는 이후 코드 실행 안 함
  }
  const bar = document.getElementById('topbar');
  if (bar) {
    bar.classList.add('topbar');
    bar.innerHTML = `
      <h1>본당살림</h1>
      <span class="parish">${esc(settings.parish?.parishName ?? '')}</span>
      <nav>${settings.setupCompleted ? NAV.map((n) =>
        `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`).join('') : ''}</nav>
      <span class="user">${esc(me.email)}</span>`;
  }
  return { me, settings };
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

/** 결재란 미리보기 (결산서와 같은 모양) */
export function approvalBoxHtml(titles) {
  if (!titles.length) return '<p class="muted">결재 단계가 없습니다.</p>';
  return `<table class="approval-box"><tr><th rowspan="2" class="vertical">결<br>재</th>
    ${titles.map((t) => `<th>${esc(t)}</th>`).join('')}</tr>
    <tr>${titles.map(() => '<td></td>').join('')}</tr></table>`;
}

/** 이체 순액처럼 부호가 의미 있는 금액: +1,000 / -1,000 / 0 */
export const signedWon = (n) => (n > 0 ? `+${formatWon(n)}` : formatWon(n));

export const FUND_LABEL = { GENERAL: '일반회계', SPECIAL: '특별회계' };
export const KIND_LABEL = { INCOME: '수입', EXPENSE: '지출' };

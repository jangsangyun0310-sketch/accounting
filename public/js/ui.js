// 화면 공용 부품: 상단 메뉴, 금액 입력칸, 알림, 결재란 미리보기
import { api, esc } from './api.js';
import { formatWon } from './shared/money.js';

const NAV = [
  { href: '/', label: '홈', key: 'home' },
  { href: '/entry', label: '거래 입력', key: 'entry' },
  { href: '/ledger', label: '거래 조회', key: 'ledger' },
  { href: '/closing', label: '일 마감', key: 'closing' },
  { href: '/report', label: '결산', key: 'report' },
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
    // 성당 이름·작성자 이름은 화면 캡처에 나오지 않도록 상단 막대에 표시하지 않는다
    bar.innerHTML = `
      <a href="/" class="brand"><img src="/img/logo.png" alt="본당살림" width="171" height="48"></a>
      ${settings.setupCompleted
        ? `<a href="/settings" class="settings-link ${active === 'settings' ? 'active' : ''}">⚙ 설정</a>` : ''}
      <nav>${settings.setupCompleted ? NAV.map((n) =>
        `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`).join('') : ''}</nav>
      <button type="button" class="share-btn" id="share-btn">🔗 공유하기</button>`;
    bar.querySelector('#share-btn').addEventListener('click', openShareDialog);
  }
  return { me, settings };
}

// 다른 성당에 알려줄 설치 안내 주소. 이 주소로 설치하면 빈 프로그램(틀)만 설치되고 우리 자료는 전혀 가지 않는다.
const SHARE_GUIDE_URL = 'https://github.com/jangsangyun0310-sketch/accounting#우리-성당에-설치하기';
const SHARE_DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/jangsangyun0310-sketch/accounting';

function openShareDialog() {
  let dlg = document.getElementById('share-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'share-dialog';
    document.body.append(dlg);
    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        try {
          await navigator.clipboard.writeText(copy.dataset.copy);
          toast('주소를 복사했습니다. 카카오톡이나 문자에 붙여 넣으세요.');
        } catch {
          toast('복사하지 못했습니다. 주소를 직접 선택해 복사하세요.', 'error');
        }
      }
    });
  }
  dlg.innerHTML = `
    <h3>🔗 다른 성당에 본당살림 공유하기</h3>
    <p>아래 주소를 다른 성당 사무장님께 보내 주세요.<br>
      그 주소로 설치하면 <b>빈 프로그램(틀)만</b> 새로 만들어집니다.
      <b>우리 성당의 통장·거래·금액·이름은 전혀 전달되지 않습니다.</b></p>
    <label>설치 안내 주소 (권장)
      <div class="copy-row"><input readonly value="${esc(SHARE_GUIDE_URL)}">
        <button type="button" data-copy="${esc(SHARE_GUIDE_URL)}">복사</button></div>
    </label>
    <p class="help">설치 순서(버튼 클릭 → 이름 정하기 → 최초 설정)가 함께 안내된 페이지입니다.</p>
    <label>바로 설치 주소
      <div class="copy-row"><input readonly value="${esc(SHARE_DEPLOY_URL)}">
        <button type="button" class="secondary" data-copy="${esc(SHARE_DEPLOY_URL)}">복사</button></div>
    </label>
    <p class="help">받는 성당은 무료 Cloudflare 계정만 있으면 됩니다. 각 성당의 자료는 각자의 계정에만 저장됩니다.</p>
    <div class="dialog-foot"><button type="button" data-close>닫기</button></div>`;
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

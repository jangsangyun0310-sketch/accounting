// 도움말: 차례(지금 보는 부분 표시), 단어 찾기
import { initPage } from './ui.js';

initPage('help', { requireSetup: false });

const sections = [...document.querySelectorAll('#help section[id]')];
const tocLinks = new Map([...document.querySelectorAll('#toc a')].map((a) => [a.hash.slice(1), a]));

// 화면에 보이는 부분을 차례에 표시: 메뉴 줄 바로 아래(위에서 140px)를 지나간 마지막 항목
let pinned = null; // 차례를 눌러 부드럽게 움직이는 동안은 누른 항목을 그대로 표시
const mark = (id) => { for (const [key, a] of tocLinks) a.classList.toggle('on', key === id); };
function update() {
  if (pinned) return;
  const shown = sections.filter((s) => !s.hidden);
  const current = shown.filter((s) => s.getBoundingClientRect().top <= 140).at(-1) ?? shown[0];
  if (current) mark(current.id);
}
let ticking = false;
addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; update(); });
}, { passive: true });
// 부드러운 이동이 끝나면(스크롤이 멈추면) 다시 따라가기
addEventListener('scrollend', () => { pinned = null; update(); });
update();

/** 그 항목으로 부드럽게 가서 잠깐 반짝인다 */
function go(id) {
  const target = document.getElementById(id);
  if (!target || target.hidden) return;
  mark(id);
  pinned = id;
  setTimeout(() => { pinned = null; }, 1500); // scrollend 가 없는 브라우저 대비
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  target.classList.remove('flash');
  void target.offsetWidth; // 애니메이션을 처음부터 다시
  target.classList.add('flash');
}
document.getElementById('toc').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  history.replaceState(null, '', a.hash);
  go(a.hash.slice(1));
});
// 본문 안의 링크(예: "마감취소" → 4. 일 마감)도 같은 방식으로
document.getElementById('help').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  history.replaceState(null, '', a.hash);
  go(a.hash.slice(1));
});
// 다른 화면의 [도움말]로 들어온 경우 (예: /help#closing)
if (location.hash) requestAnimationFrame(() => go(location.hash.slice(1)));

// 단어 찾기: 모든 단어가 들어 있는 부분만 보인다
const q = document.getElementById('help-q');
const clear = document.getElementById('help-clear');
const result = document.getElementById('help-result');

function search() {
  const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const s of sections) {
    const text = `${s.textContent} ${s.dataset.keywords ?? ''}`.toLowerCase();
    const match = words.every((w) => text.includes(w));
    s.hidden = !match;
    tocLinks.get(s.id)?.classList.toggle('dim', !match);
    if (match) shown++;
    // 자주 묻는 질문은 맞는 질문만 펼친다
    for (const d of s.querySelectorAll('details')) {
      d.open = words.length > 0 && words.every((w) => d.textContent.toLowerCase().includes(w));
    }
  }
  clear.hidden = !words.length;
  result.hidden = !words.length;
  result.textContent = shown ? `"${q.value.trim()}" — ${shown}곳에서 찾았습니다.` : `"${q.value.trim()}" 이(가) 들어간 설명이 없습니다. 다른 단어로 찾아보세요.`;
}
q.addEventListener('input', search);
clear.addEventListener('click', () => { q.value = ''; search(); q.focus(); });

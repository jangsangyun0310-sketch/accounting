// 도움말: 차례(지금 보는 부분 표시), 단어 찾기
import { initPage } from './ui.js';

initPage('help', { requireSetup: false });

const sections = [...document.querySelectorAll('#help section[id]')];
const tocLinks = new Map([...document.querySelectorAll('#toc a')].map((a) => [a.hash.slice(1), a]));

// 화면에 보이는 부분을 차례에 표시
const visible = new Set();
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
  const current = sections.find((s) => visible.has(s.id));
  for (const [id, a] of tocLinks) a.classList.toggle('on', id === current?.id);
}, { rootMargin: '-90px 0px -55% 0px' });
sections.forEach((s) => observer.observe(s));

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

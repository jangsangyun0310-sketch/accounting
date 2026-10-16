// 비품대장 화면: 목록 · 찾기 · 올리기 · 고치기(올린 날만, 그 뒤엔 둘 곳 · 비고) · 폐기 · 삭제(두 줄) · 사진 · Excel · 인쇄
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, bindAmountInput, toast } from './ui.js';
import { formatWon } from './shared/money.js';
import { todayKST } from './shared/dates.js';
import { downloadXlsx } from './excel.js';
import { shrinkPhoto } from './photo.js';

const $ = (id) => document.getElementById(id);
const dlg = $('eq-dialog');
let settings = null;
let items = [];
let current = null; // 창에 열린 비품 (새로 올리기면 null)

const SHOW_KEY = 'equipment-show';
try { $('show').value = localStorage.getItem(SHOW_KEY) || 'live'; } catch { /* 기억 못 해도 괜찮다 */ }

const isLive = (x) => !x.deletedAt && !x.disposedAt;

async function load() {
  items = (await api('/api/equipment')).items;
  render();
}

function visible() {
  const q = $('q').value.trim();
  return items.filter((x) => ($('show').value === 'all' || isLive(x))
    && (!q || [x.name, x.spec, x.location, x.vendor, x.itemNo, x.note].some((v) => v.includes(q))));
}

/** 비고 칸: 폐기 · 삭제 사연을 앞에 */
function noteText(x) {
  if (x.deletedAt) return `삭제 ${x.deletedAt}${x.deleteReason ? ` · ${x.deleteReason}` : ''}${x.note ? ` / ${x.note}` : ''}`;
  if (x.disposedAt) return `${x.disposeReason || '폐기'}${x.note ? ` / ${x.note}` : ''}`;
  return x.note;
}

function render() {
  const rows = visible();
  const live = items.filter(isLive);
  $('totals').innerHTML = `사용 중 <b>${live.length}건</b> · 구매금액 합계 <b>${formatWon(live.reduce((n, x) => n + x.price, 0))}</b>원`
    + (items.length > live.length ? ` <span class="muted">(폐기 · 삭제 ${items.length - live.length}건 제외)</span>` : '');
  if (!rows.length) {
    $('list').innerHTML = `<p class="muted">${items.length ? '조건에 맞는 비품이 없습니다.' : '아직 올린 비품이 없습니다. [＋ 비품 추가]를 눌러 적어 넣으세요.'}</p>`;
    return;
  }
  $('list').innerHTML = `
    <table class="grid eq-list">
      <thead><tr><th>관리번호</th><th>품명</th><th>규격·모델</th><th class="num">수량</th><th>구매일자</th>
        <th class="num">구매금액</th><th>구매처</th><th>둘 곳</th><th>폐기일자</th><th>비고</th></tr></thead>
      <tbody>${rows.map((x) => `
        <tr data-id="${x.id}" class="${x.deletedAt ? 'deleted' : x.disposedAt ? 'disposed' : ''}" tabindex="0">
          <td>${esc(x.itemNo)}</td>
          <td>${esc(x.name)}${x.photoCount ? ` <span class="muted small no-print" title="사진 ${x.photoCount}장">📷${x.photoCount}</span>` : ''}</td>
          <td>${esc(x.spec)}</td>
          <td class="num">${formatWon(x.quantity)}</td>
          <td>${esc(x.purchaseDate)}</td>
          <td class="num">${formatWon(x.price)}</td>
          <td>${esc(x.vendor)}</td>
          <td>${esc(x.location)}</td>
          <td>${esc(x.disposedAt ?? '')}</td>
          <td class="note">${esc(noteText(x))}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

// ---------------------------------------------------------------- 창

const field = (name, label, value, { locked = false, attrs = '' } = {}) =>
  `<label>${label} <input name="${name}" value="${esc(value ?? '')}" ${locked ? 'disabled' : ''} ${attrs}></label>`;

function openDialog(x) {
  current = x;
  const adding = !x;
  const frozen = x && !isLive(x);
  const allOpen = adding || x.editable;
  const fromTx = x?.txId != null;
  const lockedNote = x && isLive(x) && !x.editable;
  dlg.innerHTML = `
    <div class="dialog-head"><h3>${adding ? '비품 추가' : `${esc(x.name)} <span class="muted small">${esc(x.itemNo)}</span>`}</h3>
      <button type="button" class="secondary small" data-close>닫기</button></div>
    ${x?.deletedAt ? `<p class="eq-state deleted">삭제한 줄입니다 (${esc(x.deletedAt)}${x.deleteReason ? ` · ${esc(x.deleteReason)}` : ''})</p>` : ''}
    ${x?.disposedAt ? `<p class="eq-state">폐기했습니다 (${esc(x.disposedAt)}${x.disposeReason ? ` · ${esc(x.disposeReason)}` : ''})</p>` : ''}
    <form id="eq-form" class="eq-form" autocomplete="off">
      ${field('name', '품명 *', x?.name, { locked: !allOpen || frozen, attrs: 'maxlength="50"' })}
      ${field('spec', '규격·모델', x?.spec, { locked: !allOpen || frozen, attrs: 'maxlength="60"' })}
      ${field('quantity', '수량', x?.quantity ?? 1, { locked: !allOpen || frozen, attrs: 'inputmode="numeric" maxlength="6"' })}
      ${field('purchaseDate', '구매일자 *', x?.purchaseDate ?? todayKST(), { locked: !allOpen || frozen || fromTx, attrs: 'type="date"' })}
      ${field('price', '구매금액(원)', x ? formatWon(x.price) : '', { locked: !allOpen || frozen || fromTx })}
      ${field('vendor', '구매처', x?.vendor, { locked: !allOpen || frozen, attrs: 'maxlength="40"' })}
      ${field('location', '둘 곳', x?.location, { locked: frozen, attrs: 'maxlength="40" placeholder="예) 성전, 사무실"' })}
      <label class="wide">비고 <input name="note" value="${esc(x?.note ?? '')}" maxlength="200" ${frozen ? 'disabled' : ''} placeholder="예) 봉헌자, A/S 기간"></label>
    </form>
    ${lockedNote ? '<p class="help">🔒 올린 다음 날부터는 둘 곳 · 비고만 바꿀 수 있습니다. 잘못 올렸으면 [삭제]하고 다시 올리세요.</p>' : ''}
    ${fromTx ? `<p class="help">↗ <a href="${href(`/entry?date=${x.purchaseDate}`)}">${esc(x.purchaseDate)} 지출 거래</a>에서 올라왔습니다. 구매일자 · 금액은 거래를 고치면 따라 바뀝니다.</p>` : ''}
    ${adding ? '' : `<div class="eq-photos"><b class="small">사진</b> <span id="eq-photo-list" class="eq-photo-list"><span class="muted small">불러오는 중…</span></span></div>`}
    <div class="eq-dispose" id="eq-dispose" hidden>
      <label>폐기일자 <input type="date" name="disposeDate" value="${todayKST()}"></label>
      <label>사유 <input name="disposeReason" maxlength="100" placeholder="예) 고장, 기증, 매각 (비워도 됨)"></label>
      <button type="button" data-act="dispose-ok">폐기하기</button>
    </div>
    <div class="dialog-foot eq-foot">
      ${x && isLive(x) ? `<button type="button" class="secondary" data-act="dispose">폐기…</button>
        <button type="button" class="danger" data-act="delete">삭제</button>` : ''}
      <span class="spacer"></span>
      ${frozen ? '' : `<button type="button" data-act="save">${adding ? '올리기' : '저장'}</button>`}
    </div>`;
  bindAmountInput(dlg.querySelector('[name="price"]'));
  dlg.showModal();
  if (!adding) loadPhotos(x);
  if (adding) dlg.querySelector('[name="name"]').focus();
}

async function loadPhotos(x) {
  const box = $('eq-photo-list');
  try {
    const { photos } = await api(`/api/equipment/${x.id}/photos`);
    if (current?.id !== x.id) return;
    box.innerHTML = photos.map((p) => `
      <span class="eq-photo"><a href="${p.image}" target="_blank" rel="noopener"><img src="${p.image}" alt="비품 사진"></a>
        <button type="button" class="secondary small" data-photo-del="${p.id}" title="이 사진 떼기">✕</button></span>`).join('')
      + (photos.length < 4 ? '<button type="button" class="secondary small" data-act="photo-add">＋ 사진 붙이기</button>' : '')
      + (photos.length ? '' : ' <span class="muted small">물건 · 영수증 사진 (4장까지)</span>');
  } catch (err) {
    box.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}

function formBody() {
  const v = (n) => dlg.querySelector(`[name="${n}"]`).value;
  return { name: v('name'), spec: v('spec'), quantity: v('quantity'), purchaseDate: v('purchaseDate'), price: v('price'),
    vendor: v('vendor'), location: v('location'), note: v('note') };
}

async function act(name, btn) {
  const x = current;
  try {
    if (name === 'save') {
      if (x) await api(`/api/equipment/${x.id}`, { method: 'PUT', body: formBody() });
      else await api('/api/equipment', { method: 'POST', body: formBody() });
      toast(x ? '저장했습니다.' : '비품대장에 올렸습니다.');
      dlg.close();
    } else if (name === 'dispose') {
      $('eq-dispose').hidden = false;
      dlg.querySelector('[name="disposeReason"]').focus();
      return;
    } else if (name === 'dispose-ok') {
      const date = dlg.querySelector('[name="disposeDate"]').value;
      if (!confirm(`'${x.name}'을(를) ${date} 폐기할까요?\n폐기하면 되돌릴 수 없습니다. (대장에는 폐기일자와 함께 남습니다)`)) return;
      await api(`/api/equipment/${x.id}/dispose`, { method: 'POST', body: { date, reason: dlg.querySelector('[name="disposeReason"]').value } });
      toast('폐기했습니다.');
      dlg.close();
    } else if (name === 'delete') {
      const reason = prompt(`'${x.name}' 줄을 삭제할까요?\n대장에는 빨간 두 줄로 남습니다. 사유를 적어 주세요 (비워도 됨).`, '');
      if (reason === null) return;
      await api(`/api/equipment/${x.id}/delete`, { method: 'POST', body: { reason } });
      toast('삭제했습니다.');
      dlg.close();
    } else if (name === 'photo-add') {
      photoInput.click();
      return;
    }
    await load();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

const photoInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
document.body.append(photoInput);
photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
  if (!file || !current) return;
  try {
    await api(`/api/equipment/${current.id}/photos`, { method: 'POST', body: { image: await shrinkPhoto(file) } });
    await loadPhotos(current);
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

dlg.addEventListener('click', async (e) => {
  if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
  const del = e.target.closest('[data-photo-del]');
  if (del) {
    if (!confirm('이 사진을 뗄까요?')) return;
    try {
      await api(`/api/equipment/photos/${del.dataset.photoDel}`, { method: 'DELETE' });
      await loadPhotos(current);
      load();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  const b = e.target.closest('[data-act]');
  if (b) { b.disabled = true; await act(b.dataset.act, b); }
});
dlg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.target.closest('#eq-form')) { e.preventDefault(); act('save'); }
});
dlg.addEventListener('close', () => { current = null; });

// ---------------------------------------------------------------- 목록 · Excel · 인쇄

$('list').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDialog(items.find((x) => x.id === Number(tr.dataset.id)));
});
$('list').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && e.key === 'Enter') openDialog(items.find((x) => x.id === Number(tr.dataset.id)));
});
$('add').addEventListener('click', () => openDialog(null));
$('q').addEventListener('input', render);
$('show').addEventListener('change', () => {
  try { localStorage.setItem(SHOW_KEY, $('show').value); } catch { /* 기억 못 해도 괜찮다 */ }
  render();
});

$('excel').addEventListener('click', () => {
  const rows = visible();
  if (!rows.length) { toast('내려받을 비품이 없습니다.', 'error'); return; }
  const th = { bold: true, fill: 'EEF1F5', border: true, h: 'center' };
  const td = (x) => (x.deletedAt ? { border: true, color: 'C62828', strike: true } : x.disposedAt ? { border: true, color: '888888' } : { border: true });
  const head = ['관리번호', '품명', '규격·모델', '수량', '구매일자', '구매금액', '구매처', '둘 곳', '폐기일자', '비고'];
  const live = rows.filter(isLive);
  downloadXlsx(`비품대장 ${settings.parish.parishName} ${todayKST()}.xlsx`, [{
    name: '비품대장',
    widths: [11, 22, 22, 7, 12, 14, 16, 16, 12, 34],
    rows: [
      [{ v: `비품대장 — ${settings.parish.parishName}`, st: { bold: true, size: 14 } }],
      [{ v: `${todayKST()} 현재 · 사용 중 ${live.length}건 · 구매금액 합계 ${formatWon(live.reduce((n, x) => n + x.price, 0))}원` }],
      [],
      head.map((v) => ({ v, st: th })),
      ...rows.map((x) => [x.itemNo, x.name, x.spec, x.quantity, x.purchaseDate, x.price, x.vendor, x.location, x.disposedAt ?? '', noteText(x)]
        .map((v) => ({ v, st: td(x) }))),
    ],
  }]);
});

$('print').addEventListener('click', () => {
  $('print-title').textContent = `비품대장 — ${settings.parish.parishName} (${todayKST()} 현재)`;
  window.print();
});

initPage('equipment').then(async (ctx) => {
  settings = ctx.settings;
  await load();
  // 거래 입력의 비품 번호를 누르고 오면 그 비품을 바로 연다
  const no = new URLSearchParams(location.search).get('no');
  const hit = no && items.find((x) => x.itemNo === no);
  if (hit) {
    if (!isLive(hit)) $('show').value = 'all';
    render();
    openDialog(hit);
  }
}).catch((err) => {
  $('list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});

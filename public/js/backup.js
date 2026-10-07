// 백업 내려받기·백업 상태 (설정 화면과 홈 화면이 같이 사용)
import { apiFetch, esc } from './api.js';
import { toast } from './ui.js';
import { formatDateTimeKST } from './shared/dates.js';

/** 백업: 서버의 장부 전체를 백업 파일(.json)로 내려받는다 (서버가 백업 기록을 남김). 받았으면 true */
export async function downloadBackup() {
  try {
    const res = await apiFetch('/api/backup');
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || `백업 파일을 만들지 못했습니다 (${res.status})`);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
    const fileName = encoded ? decodeURIComponent(encoded) : '본당살림-백업.json';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await res.blob());
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    toast(`백업 파일을 내려받았습니다: ${fileName}`);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

/** 마지막 백업 이후 지난 날 수 (백업 없으면 null) */
export function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

/** 백업 상태 한 줄 요약 HTML. 백업이 필요하면 needed = true */
export function backupStatusHtml(s) {
  const days = daysSince(s.lastBackupAt);
  const needed = days == null || (days >= 7 && s.changesSince > 0);
  const text = days == null
    ? '아직 백업한 적이 없습니다.'
    : `마지막 백업: ${formatDateTimeKST(s.lastBackupAt)} (${days === 0 ? '오늘' : `${days}일 전`})`
      + (s.changesSince ? ` · 이후 변경 ${s.changesSince}건` : ' · 이후 변경 없음');
  return { needed, html: `<span class="${needed ? 'error' : ''}">${esc(text)}</span>` };
}

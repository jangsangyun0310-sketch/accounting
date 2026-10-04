// 백업 내려받기·백업 상태 (설정 화면과 홈 화면이 같이 사용)
import { api, esc } from './api.js';
import { toast } from './ui.js';
import { formatDateTimeKST, todayKST } from './shared/dates.js';

/** 백업 파일을 받아 PC 에 저장. 성공하면 true */
export async function downloadBackup() {
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || `백업 실패 (${res.status})`);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
    const fileName = encoded ? decodeURIComponent(encoded) : `bondang-backup-${todayKST()}.json`;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`백업 파일을 저장했습니다: ${fileName}`);
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

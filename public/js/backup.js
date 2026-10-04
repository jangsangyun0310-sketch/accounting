// 백업 내려받기·백업 상태 (설정 화면과 홈 화면이 같이 사용)
import { api, esc } from './api.js';
import { toast } from './ui.js';
import { formatDateTimeKST } from './shared/dates.js';

/** 백업: 장부 파일 사본(같은 비밀번호로 잠김)을 고른 곳에 저장하고 백업 기록을 남긴다. 저장했으면 true */
export async function downloadBackup() {
  try {
    const { saveBackupCopy } = await import('./local/session.js');
    const settings = await api('/api/settings');
    const fileName = await saveBackupCopy(settings.parish?.parishName);
    if (!fileName) return false; // 저장 창에서 취소
    await api('/api/backup/log', { method: 'POST', body: { fileName } });
    toast(`백업 사본을 저장했습니다: ${fileName}`);
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

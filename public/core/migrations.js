// 적용 순서대로의 마이그레이션 파일 목록 (public/migrations/).
// 브라우저 엔진이 이 목록을 보고 아직 적용하지 않은 것만 적용한다. 새 마이그레이션을 추가하면 여기에도 추가한다.
// (테스트가 폴더 내용과 이 목록이 같은지 확인한다)
export const MIGRATIONS = [
  '0001_init.sql',
  '0002_integrity_triggers.sql',
  '0003_setup_lock.sql',
  '0004_transactions_integrity.sql',
  '0005_closing_guards.sql',
  '0006_backup_restore.sql',
  '0007_delete_instead_of_void.sql',
  '0009_close_every_day.sql', // (0008 은 예전 서버 보관함용 — 장부에는 적용하지 않음)
  '0010_budgets.sql',
];

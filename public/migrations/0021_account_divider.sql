-- 결산서 통장 표에서 이 통장 아래에 굵은 실선 (2026-10-27): 통장을 몇 묶음으로 나눠 보이게. 성당마다 설정에서 고른다
ALTER TABLE accounts ADD COLUMN divider_after INTEGER NOT NULL DEFAULT 0 CHECK (divider_after IN (0, 1));

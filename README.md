# 본당살림

성당 사무실용 본당 회계·결산 관리 프로그램입니다. 여러 통장의 수입·지출과 잔액을 통합 관리하고 일일 결산서를 출력합니다.

- 화면: HTML / CSS / JavaScript (빌드 과정 없음)
- 서버: Cloudflare Workers (정적 파일 + `/api/*`)
- 데이터: Cloudflare D1
- 로그인: 기본은 로그인 없음, 선택적으로 Cloudflare Access

## 우리 성당에 설치하기

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jangsangyun0310-sketch/accounting)

Cloudflare 계정(무료)만 있으면 됩니다. 성당마다 프로그램과 데이터베이스가 따로 만들어지므로 다른 성당과 데이터가 섞이지 않습니다.

### 1. 배포

1. 위 **Deploy to Cloudflare** 버튼을 누르고 Cloudflare 에 로그인합니다.
2. GitHub 계정을 연결하고, 프로젝트 이름(예: `bondang-ourparish`)을 정한 뒤 **배포**를 누릅니다.
   - 데이터베이스(D1)는 자동으로 만들어지고 표 구조도 자동으로 적용됩니다.
3. 완료되면 `https://프로젝트이름.계정이름.workers.dev` 주소가 생깁니다.

### 2. 최초 설정

주소로 접속하면 **최초 설정** 화면이 열립니다.
성당명, 통장과 초기잔액, 예산과목, 결재선을 입력하면 바로 사용할 수 있습니다.

- 기본 설정은 **로그인 없이** 사용하는 방식입니다. 주소를 아는 사람은 누구나 접속할 수 있으므로 주소는 성당 사무실 안에서만 공유하세요.
- 검색엔진(구글 등)에는 노출되지 않도록 설정되어 있습니다.
- 입력·수정·마감 기록의 처리자는 최초 설정에서 입력한 **결산서 작성자** 이름으로 남습니다 (비어 있으면 "사무실").

### (선택) 로그인 켜기 — Cloudflare Access

허용한 이메일을 가진 사람만 쓰게 하고, 처리자를 이메일로 기록하고 싶을 때 사용합니다. (무료, 50명까지)

1. Cloudflare 대시보드 → **Workers & Pages** → 내 프로젝트 → **Access** 탭 → Zero Trust 설정(Free 요금제) 후 Access 켜기
2. 허용할 사용자 이메일을 정책(Policy)에 추가
3. 내 프로젝트 → **Settings** → **Variables and Secrets**
   - 변수 `AUTH_MODE` 를 `access` 로 변경
   - Secret 추가: `ACCESS_TEAM_DOMAIN` (예: `https://ourparish.cloudflareaccess.com`), `ACCESS_AUD` (Access 화면의 AUD 값)

## 폴더 구조

```
public/            화면 (정적 파일)
  js/shared/       브라우저·서버 공용 모듈 (금액, 날짜)
src/               Worker 코드 (/api/*)
  lib/             인증, DB, 응답 공용 처리
  routes/          API 기능별 처리
migrations/        D1 스키마 (순서대로 적용)
seed/              개발용 초기 데이터 (용머리성당)
test/              자동 테스트
```

## 개발 환경

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run db:migrate:local   # 로컬 D1 에 스키마 적용
npm run db:seed:local      # 개발용 초기값 입력 (처음 한 번)
npm run dev                # http://localhost:8787 (로그인 없이 dev@local 사용자로 실행)
npm test                   # 금액 처리·DB 무결성 테스트
```

로컬 데이터를 처음부터 다시 만들려면 `.wrangler/state` 폴더를 지우고 위 명령을 다시 실행합니다.

## 화면

| 주소 | 내용 |
|---|---|
| `/setup` | 최초 설정 마법사 (설정 전에는 모든 화면이 이곳으로 이동) |
| `/` | 홈: 통장별 잔액, 결재선 |
| `/entry` | 거래 입력: 수입·지출·이체 입력, 수정(취소 후 재입력), 취소, 하루 현황 |
| `/ledger` | 거래 조회: 기간·통장·과목·구분·검색어, 통장 선택 시 거래별 잔액 |
| `/closing` | 일 마감: 마감 달력, 마감·마감취소(사유 필수), 마감 시점 스냅샷 검증, 기록 |
| `/report` | 일일 결산서: A4 미리보기·인쇄 (미마감 날은 "가결산" 표시, 마감된 날은 마감 당시 결재선·작성자) |
| `/settings` | 설정: 성당 정보, 통장, 예산과목, 결재선 |

빈 DB 로 최초 설정 화면을 시험하려면 `npm run db:seed:local` 을 건너뛰면 됩니다.

## 회계 데이터 원칙

- 금액은 원 단위 정수만 저장합니다 (DB `CHECK` 로 강제).
- 잔액은 저장하지 않습니다. `초기잔액 + 확정(POSTED) 거래 합계`로 계산합니다.
- 거래는 수정·삭제하지 않습니다. 수정은 "원본 취소 + 새 거래", 삭제는 "취소(사유 필수)"로 처리합니다.
- 통장 간 이체는 출금·입금 두 거래가 한 쌍입니다. 한쪽을 취소하면 DB 트리거가 반대쪽도 함께 취소합니다.
- 하루 현황은 `전일잔액 + 수입 − 지출 ± 이체 = 당일잔액` 을 통장·회계·전체 단위로 매번 검증합니다.
- 마감된 날짜(마지막 마감일 이하)의 거래는 DB 트리거가 변경을 막습니다.
- 마감은 날짜순으로만, 마감취소는 마지막 마감일부터 역순으로만 가능합니다.
- 마감·마감취소 이력과 감사 로그는 추가만 가능합니다.
- 마감 시 결재선과 통장별 잔액을 같은 SQL 문 안에서 스냅샷으로 저장합니다. 이후 조회 때 현재 계산 잔액과 비교해 불일치를 알립니다.
- 마감된 날짜가 있으면 새 통장은 초기잔액 0원으로만 만들 수 있고, 초기잔액이 있는 통장은 삭제할 수 없습니다.

## 배포 (개발자용)

```bash
npx wrangler login
npm run deploy     # Worker 배포(첫 배포 때 D1 자동 생성) → D1 스키마 적용
```

- `wrangler.jsonc` 에는 `database_id` 를 넣지 않습니다. 배포 계정에서 `database_name` 으로 찾거나 새로 만듭니다.
- (Access 사용 시) Access 값은 설정 파일이 아니라 비밀값으로 등록합니다 (배포해도 유지).
  ```bash
  npx wrangler secret put ACCESS_TEAM_DOMAIN
  npx wrangler secret put ACCESS_AUD
  ```
- GitHub `main` 에 올릴 때 자동 배포하려면: 대시보드 → 프로젝트 → **Settings** → **Build** → 저장소 연결,
  배포 명령(Deploy command)을 `npm run deploy` 로 지정합니다.
- `AUTH_MODE`: `open`(기본, 로그인 없음) / `access`(Cloudflare Access). `access` 일 때는 Access 토큰(JWT)의 서명·대상(AUD)·만료를
  API 가 직접 검증하므로 Access 를 거치지 않은 주소로 접근해도 데이터를 읽거나 쓸 수 없습니다.
- 변경 요청은 `application/json` 만 받으므로 다른 사이트에서 몰래 보내는 요청(CSRF)은 막힙니다.

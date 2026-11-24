# 세법 근거 에이전트

국세법령정보시스템(taxlaw.nts.go.kr)과 대법원 사법정보공개포털 판례(portal.scourt.go.kr)**만** 검색·열람하고, 읽은 자료를 근거로 결론을 내리는 Windows용 세무 리서치 프로그램입니다.

## 작동 방식
- Claude가 질문을 쟁점으로 나누고 아래 4개 도구만 사용합니다. 다른 사이트에는 접근할 수 없습니다.
  | 도구 | 하는 일 |
  |---|---|
  | `taxlaw_search` | 국세법령정보시스템 통합검색 (법령·해석례·심판례·집행기준) |
  | `taxlaw_read` | 해석례·심판례·집행기준 본문 열람 (키워드 발췌 가능) |
  | `scourt_search` | 대법원·하급심 공개 판례 검색 (검색어 / 사건번호 / 참조조문 / 선고일) |
  | `scourt_read` | 판례 전문 열람 |
- 두 사이트는 프로그램 안의 숨겨진 브라우저 창에서 열고, 페이지 이동도 두 주소로만 제한됩니다.
- 학습된 지식은 검색어를 정하는 데만 쓰도록 지시되어 있고, 답변에는 문서번호·사건번호·URL이 붙은 근거 목록이 들어갑니다.
- 요청은 한 번에 하나씩, 0.8초 이상 간격을 두고 보내 사이트에 부담을 주지 않습니다.

## 준비물
- Anthropic API 키 (console.anthropic.com) — 첫 실행 때 설정 창에 입력합니다. 키는 Windows 암호화(DPAPI)로 저장됩니다.
- 모델 기본값은 `claude-sonnet-5-5`이며 설정에서 Opus/Haiku로 바꿀 수 있습니다. 질문 하나에 검색·열람을 10~30회 하므로 토큰을 꽤 씁니다(화면 오른쪽 위에 누적 토큰 표시).

## 실행 / 빌드
```bash
npm install
npm start          # 개발 실행
npm run dist       # Windows 설치파일(dist/*.exe) 생성
```
GitHub에 올리면 `.github/workflows/build.yml`이 Windows 설치파일을 빌드합니다(Actions 탭에서 수동 실행 또는 `v*` 태그 푸시).

## 알아둘 점
- 두 사이트의 화면 구조나 내부 주소가 바뀌면 `src/sources.js`를 고쳐야 합니다. 2026.11.24. 기준으로 확인한 사항:
  - 국세법령 검색: `/is/USEISA001M.do?schVcb=검색어&searchType=totalSearch`. 결과 제목을 누르면 상세 주소(`/qt/USEQTA002P.do?ntstDcmId=…` 등)가 열립니다.
  - 판례 검색: `POST /pgp/pgp1011/selectJdcpctSrchRsltLst.on` (JSON), 판례 전문: `/pgp/main.on?w2xPath=PGP1011M04&jisCntntsSrno=…`
- 국세법령 통합검색은 분류별 상위 몇 건만 보여 줍니다. 원하는 문서가 안 보이면 에이전트가 검색어를 바꿔 다시 찾습니다.
- "나의 사건검색"(사건 진행 조회)은 자동입력방지문자가 있어 넣지 않았습니다.
- 결과는 리서치 보조용입니다. 최종 판단 전에 근거 링크를 직접 열어 확인하세요.

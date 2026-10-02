# 근거 기반 자료 검증기 v1 (무료형)

뉴스 기사, 블로그 글, SNS 글 등에서 핵심 주장 문장을 추려 관련 근거를 검색하고, 기존 팩트체크 자료가 있으면 그 판정을 함께 보여주는 Cloudflare Workers 프로젝트입니다.

## 핵심 원칙
- OpenAI API를 사용하지 않습니다.
- 자동으로 '100% 진짜/100% 가짜'라고 단정하지 않습니다.
- 기존 팩트체크 판정과 웹 검색 결과를 분리합니다.
- 검색 결과 제목/요약문을 증거 자체로 취급하지 않도록 주의 문구를 표시합니다.
- Google Fact Check Tools API를 선택적으로 연결할 수 있습니다.

## 무료 구성
Cloudflare Workers Free에서 실행할 수 있도록 외부 라이브러리 없이 순수 HTML/CSS/JS로 구성했습니다.
Google Fact Check Tools API는 선택 기능이며, 사용하려면 Google의 API key를 `GOOGLE_FACTCHECK_API_KEY`라는 Cloudflare secret으로 등록해야 합니다.

## Cloudflare 배포
1. 이 폴더를 GitHub 저장소에 올립니다.
2. Cloudflare Dashboard → Workers & Pages → Create → Import from Git.
3. 프로젝트를 선택합니다.
4. `wrangler.toml`을 인식시키고 배포합니다.

## Google Fact Check API 연결(선택)
1. Google Cloud에서 Fact Check Tools API를 활성화합니다.
2. API key를 만듭니다.
3. Cloudflare Worker의 Settings → Variables/Secrets에서 이름 `GOOGLE_FACTCHECK_API_KEY`로 Secret을 등록합니다.
4. 다시 배포합니다.

API key가 없어도 웹 검색 기반 기능은 동작하도록 설계했습니다.

## 현재 한계
- 사이트가 크롤링을 막으면 URL에서 본문을 가져오지 못할 수 있습니다.
- 웹 검색 결과가 충분하지 않으면 판정을 보류합니다.
- 문맥, 풍자, 숫자의 기준 시점, 인과관계 등은 자동 판정이 어렵습니다.
- 따라서 학교 과제나 연구에서는 반드시 원 출처를 직접 열어 확인하는 방식으로 사용하는 것이 좋습니다.

## 시작 화면 사용법
처음 접속하면 세 가지 검증 방법이 카드로 표시됩니다.
1. 자료 주소로 검증: URL 입력
2. 본문을 붙여넣어 검증: 본문 입력
3. 특정 문장만 검증: 주장 한 문장 입력

방법을 선택한 뒤에는 해당 입력칸만 표시됩니다. 언제든 `검증 방법 다시 선택`으로 처음 화면으로 돌아갈 수 있습니다.

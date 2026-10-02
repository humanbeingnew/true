# 근거 기반 자료 검증기 v1.1 (무료형)

웹페이지 URL, 본문, 특정 주장 문장을 입력하고 관련 팩트체크 자료와 웹 검색 결과를 함께 확인하는 Cloudflare Workers 프로젝트입니다.

## 이번 오류 수정
- URL 원문 직접 읽기가 실패해도 서버 전체가 HTTP 500으로 끝나지 않도록 수정했습니다.
- 직접 읽기가 막힌 사이트는 Jina Reader를 보조 원문 읽기로 시도합니다.
- 특정 문장만 검증하는 3번 방법에서 발생하던 입력 검증 버그를 수정했습니다.
- 서버 예외가 발생해도 사용자에게 통제된 JSON 응답을 반환하도록 수정했습니다.
- `/api/health` 상태 확인 엔드포인트를 추가했습니다.
- 누락되어 있던 `favicon.svg`를 추가했습니다.
- 프런트엔드가 서버의 JSON이 아닌 응답도 안전하게 처리하도록 보강했습니다.

## 검증 방법 3가지
1. 자료 주소로 검증: URL을 입력하고 원문을 불러옵니다.
2. 본문을 붙여넣어 검증: 기사나 글을 직접 입력합니다.
3. 특정 문장만 검증: 한 문장을 직접 입력합니다.

## 무료 구성
- OpenAI API를 사용하지 않습니다.
- 기본 검색은 Google News RSS를 사용합니다.
- Google Fact Check Tools API는 선택 기능입니다. API key를 등록하지 않아도 웹 검색 기반 검증은 동작합니다.
- URL 읽기가 막힌 경우 Jina Reader를 보조 경로로 사용합니다. Jina 공식 문서에서는 Reader의 기본 사용을 무료로 안내하고 있으며, API key 없이도 제한된 호출을 제공한다고 명시합니다.

## Cloudflare 배포
1. 이 폴더를 GitHub 저장소에 올립니다.
2. Cloudflare Workers & Pages에서 Git 저장소를 연결합니다.
3. `wrangler.toml`의 `main = "src/index.js"`와 Assets 설정을 확인합니다.
4. 배포 후 `/api/health`를 열어 `ok: true`가 나오는지 확인합니다.

## 주의
자동 판정은 참고용입니다. 검색 결과가 없다는 사실만으로 거짓이라고 결론내리지 않습니다. 원문, 날짜, 숫자, 인용의 맥락을 직접 확인해야 합니다.

## 로컬 스모크 테스트
Node.js 18+에서 다음을 실행할 수 있습니다.

```bash
node tests/worker-smoke.mjs
node --check public/app.js
node --check src/index.js
```

# fake-review-detector - CLAUDE.md

## 프로젝트 개요

B2C 소비자를 위한 **가짜 리뷰 판별 크롬 확장프로그램**.
사용자가 아마존 상품 페이지를 방문하면 리뷰를 자동 분석해서 신뢰도 등급을 보여주는 서비스.

### 배경
- 기존 `analyze-review` 프로젝트(Python, B2B 셀러용)에서 피벗
- B2C 소비자 대상 가짜 리뷰 판별은 블루오션
- 미국에서 Fakespot(Mozilla 인수), ReviewMeta 등으로 검증된 시장
- 1차 목표: 개인 수익 (부업), 2차 목표: 글로벌 확장

## 핵심 전략 결정사항

### 비즈니스에서 가장 중요한 것: 분석 정확도
- 이건 신뢰 게임. 툴이 틀리면 바로 삭제됨
- 성장이 입소문에 의존 → 입소문 트리거는 "실제로 맞더라"
- 크롬 웹스토어 별점 → 검색 노출 → 신규 유저 선순환
- 2순위: 스크래핑 내구성 (아마존 DOM 바뀌면 제품 자체가 죽음)

### MVP 범위 (합의된 사항)
**포함:**
- 아마존 US 상품 페이지에서 첫 페이지 리뷰(10개) DOM 파싱
- 로컬 패턴 분석 (별점 분포, VP 비율, 리뷰 폭주, 유사 문구)
- 분석 결과 배지 + 사이드패널 UI
- OpenAI API 연동 (보조적 역할)

**MVP에서 제외 (나중에):**
- Supabase 캐싱 → 로컬스토리지로 대체
- Stripe 결제 연동 → 사용자 생기면 추가
- 쿠팡/네이버 adapter → 아마존 US 먼저
- 백엔드 서버 → content script에서 직접 OpenAI 호출로 시작

## 기술 스택

- **Chrome Extension Manifest V3**
- **Frontend:** HTML/CSS/JS (React 없이 가볍게)
- **분석:** 로컬 패턴 분석 (JS) + OpenAI API (gpt-4o-mini)
- **저장:** 로컬스토리지 (캐싱)
- **향후:** Node.js 백엔드, Supabase, Stripe

## 폴더 구조

```
fake-review-detector/
├── CLAUDE.md
├── extension/
│   ├── manifest.json
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── content/
│   │   ├── content.js         # 아마존 페이지 주입 + DOM 파싱
│   │   └── content.css        # 배지/사이드패널 스타일
│   ├── background/
│   │   └── service-worker.js
│   ├── services/
│   │   ├── analyzer/
│   │   │   ├── pattern.js     # 패턴 기반 분석 (로컬)
│   │   │   └── ai.js          # OpenAI API 연동
│   │   └── scraper/
│   │       └── amazon.js      # 아마존 DOM 파싱
│   ├── _locales/
│   │   ├── en/messages.json
│   │   └── ko/messages.json
│   └── assets/
│       └── icons/
└── README.md
```

## 구현 순서

1. `manifest.json` + 기본 구조 세팅
2. 아마존 리뷰 DOM 파싱 (`amazon.js`)
3. 패턴 기반 분석 로직 (`pattern.js`)
4. 배지 + 사이드패널 UI (`content.js`, `content.css`)
5. OpenAI 연동 (`ai.js`)
6. 팝업 UI (`popup/`)
7. i18n 적용
8. 웹스토어 배포

## 패턴 분석 기준 (핵심 로직)

로컬에서 처리, API 비용 절감용. 이 4개가 탄탄하면 OpenAI 없이도 60~70% 탐지 가능:

1. **별점 분포 이상 탐지** - 5점/1점 극단 편중
2. **리뷰 폭주 탐지** - 특정 기간 리뷰 급증
3. **Verified Purchase 비율** - VP 비율 낮으면 의심
4. **유사 문구 클러스터링** - 코사인 유사도로 반복 탐지

## OpenAI 프롬프트 (AI 분석용)

```
이 상품 리뷰들을 분석해서 각 리뷰의 신뢰도를 0-100으로 평가해줘.
판단 기준:
1. 구체적인 사용 경험이 있는가?
2. 감정 표현이 자연스러운가?
3. AI가 생성한 것 같은 패턴이 있는가?
4. 다른 리뷰와 비정상적으로 유사한가?

리뷰 데이터: {reviews_json}

JSON 형식으로 응답:
[{"review_id": "...", "trust_score": 85, "flags": ["구체적 사용기 포함"], "risk_level": "low"}]
```

## 신뢰도 등급 기준 (UI 표시)

| 등급 | 점수 | 의미 |
|------|------|------|
| A | 80~100 | 신뢰할 수 있는 리뷰 |
| B | 60~79 | 대체로 신뢰 가능 |
| C | 40~59 | 일부 의심 |
| D | 20~39 | 가짜 리뷰 의심 |
| F | 0~19 | 가짜 리뷰 강력 의심 |

## 주의사항

- **아마존 ToS:** 서버사이드 스크래핑 금지. content script로 사용자 브라우저에서 DOM 파싱하는 방식 사용 (회색지대 회피)
- **DOM 내구성:** 아마존이 HTML 구조 자주 바꿈. 셀렉터를 여러 개 fallback으로 준비
- **API 비용:** 패턴 분석 먼저, OpenAI는 보조. 리뷰 10개 기준 $0.01 미만 목표
- **크롬 웹스토어 정책:** 결제는 외부 웹사이트에서 처리 (Stripe 직접 연동은 정책 위반 위험)

## 참고 프로젝트

- `/Users/heeeione/PycharmProjects/analyze-review/` - 기존 B2B 리뷰 분석 (Python). OpenAI 프롬프트 패턴 참고 가능

# 광주전남SI뉴스 — AI 자동 취재·송고 + 기자 CMS + 독자 뉴스 사이트

```
ai-newsroom/
├── backend/            # Groq + 지자체 보도자료 크롤링 기반 AI 기사 자동 송고 (Python)
├── frontend/           # Next.js 14 독자 사이트 + 관리자 CMS
├── supabase_schema.sql # DB 테이블 / 관리자 권한(RLS)
└── .env.example
```

## 1. Supabase 준비 (최초 1회)

1. https://supabase.com 에서 프로젝트 생성
2. **SQL Editor** → `supabase_schema.sql` 전체 실행
3. **Authentication → Users → Add user** 로 관리자 계정 생성 (Auto Confirm User 체크)
4. SQL Editor 에서 관리자 등록
   ```sql
   insert into public.admin_users (email) values ('내이메일@example.com')
   on conflict (email) do nothing;
   ```
5. (권장) **Authentication → Sign In / Providers** 에서 신규 가입(Allow new users to sign up) 끄기
6. **Project Settings → API** 에서 URL, `anon` 키, `service_role` 키 확인

## 2. 환경변수

```powershell
Copy-Item .env.example .env                    # 백엔드용
Copy-Item .env.example frontend\.env.local     # 프론트용
```

| 파일 | 채울 값 |
|---|---|
| `.env` | `GROQ_API_KEY`(무료, https://console.groq.com/keys), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `frontend/.env.local` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

`service_role` 키는 백엔드 전용입니다. 프론트/깃에 노출하지 마세요.

## 3. 웹사이트 실행

```powershell
cd frontend
npm install        # 최초 1회
npm run dev        # http://localhost:3000
```

| 주소 | 설명 |
|---|---|
| `/` | 독자용 메인 |
| `/article/[id]` | 기사 상세 |
| `/login` | 관리자 로그인 |
| `/admin/write` | 기사 송고실 (로그인 필요) |
| `/admin/list` | 기사 관리 (로그인 필요) |
| `/admin/sources` | AI 취재처 관리 - AI가 가져올 곳 추가/수정/삭제/on-off (로그인 필요) |

운영 실행: `npm run build` → `npm run start`

## 4. AI 기사 자동 송고

```powershell
cd backend
python -m venv .venv                      # 최초 1회
.\.venv\Scripts\python -m pip install -r requirements.txt   # 최초 1회
.\.venv\Scripts\python engine.py                    # 사용 중인 모든 취재처 (취재처당 최신 3건)
.\.venv\Scripts\python engine.py --count 1          # 취재처당 1건만
.\.venv\Scripts\python engine.py --force            # 이미 송고한 보도자료도 다시 작성
.\.venv\Scripts\python engine.py --region 해남군    # 특정 지역만
.\.venv\Scripts\python engine.py --id 3             # 특정 취재처만
.\.venv\Scripts\python engine.py --list             # 취재처 목록 확인
.\.venv\Scripts\python engine.py --dry-run          # DB에 저장하지 않고 결과만 출력(테스트)
```

무료 스택: **Groq(openai/gpt-oss-120b)** + **지자체 보도자료 직접 크롤링**. 검색 API 키가 필요 없고, 검색 엔진 차단과도 무관합니다.

흐름
1. `/admin/sources` 의 **취재처 주소**(보도자료 게시판 목록 또는 RSS 주소)에서 최신 보도자료 3건의 본문을 즉시 수집
2. 이미 송고한 보도자료(기사 하단 `[참고 출처]`에 같은 주소가 있는 것)와 14일 넘은 글은 건너뜀
3. 보도자료 1건당 기사 1건: 취재기자 발제 → 편집국장 데스킹 루프(최대 2회) → JSON 기사 → DB 저장(`author_type='AI'`)
4. 게시판을 읽지 못하면 자동으로 구글 뉴스 RSS + DuckDuckGo 검색 방식으로 대체

취재처 주소 넣는 법: 해당 기관 홈페이지에서 **보도자료 목록 페이지**를 열고 주소창의 주소를 복사해 붙여넣습니다.
(메인 주소만 넣어도 '보도자료' 메뉴를 찾아가지만 목록 주소가 가장 정확합니다.)
기본 제공: 해남군(`haenam.go.kr`), 목포시(`mokpo.go.kr`). 다른 지자체는 게시판 구조가 달라 일부는 인식하지 못할 수 있습니다.

## 문제 해결

- "Supabase 환경변수가 없습니다": `frontend/.env.local` 생성 후 `npm run dev` 재시작
- 송고/삭제 시 `row-level security` 오류: 로그인 상태 및 `admin_users` 등록 확인
- 로그인 후 "관리자 권한이 없는 계정": `admin_users` 에 해당 이메일 등록 필요
- `engine.py` "환경변수 누락": 루트 `.env` 값 확인
- "확인된 최신 공고 없음": 오류가 아니라 검색 결과가 없다는 뜻 (다른 지역/시간에 재시도)
- "Groq 분당 한도 도달 -> N초 후 재시도": 무료 플랜의 분당 토큰 제한입니다. 자동으로 기다렸다 이어갑니다.
- "Groq 일일 사용 한도": 무료 하루 한도를 다 쓴 것입니다. 다음 날 다시 실행하세요.
- "DuckDuckGo news 검색 포기(RatelimitException)": 검색 서비스의 속도 제한입니다. 웹 검색 결과만으로 계속 진행하며, 잠시 뒤 다시 실행하면 해결됩니다.


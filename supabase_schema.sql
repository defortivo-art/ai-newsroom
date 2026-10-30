-- 광주전남SI뉴스 DB 스키마 (여러 번 실행해도 안전합니다)

-- ============================================================
-- 1) 기사 테이블
-- ============================================================
create table if not exists public.articles (
  id          bigint generated always as identity primary key,
  title       text        not null,
  subtitle    text,
  category    text        not null
              check (category in ('정치/행정','경제/산업','사회/지역','문화/라이프')),
  author      text        not null,
  author_type text        not null check (author_type in ('AI','HUMAN')),
  content     text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists articles_created_at_idx on public.articles (created_at desc);

-- 기사 사진: [{"url": "...", "caption": "사진 설명"}, ...] (첫 번째가 대표 사진)
alter table public.articles
  add column if not exists images jsonb not null default '[]'::jsonb;

-- ============================================================
-- 2) 관리자 허용 목록 + 판별 함수
--    admin_users 는 RLS 를 켜고 정책을 두지 않아 클라이언트에서 직접 접근할 수 없습니다.
--    is_admin() 은 security definer 로 목록을 대신 조회합니다.
-- ============================================================
create table if not exists public.admin_users (
  email text primary key
);
alter table public.admin_users enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ============================================================
-- 3) articles RLS: 읽기는 누구나, 쓰기/삭제는 관리자만
--    (AI 엔진은 service_role 키를 쓰므로 RLS 를 우회합니다)
-- ============================================================
alter table public.articles enable row level security;

drop policy if exists "public read"  on public.articles;
drop policy if exists "demo insert"  on public.articles;
drop policy if exists "demo delete"  on public.articles;
drop policy if exists "admin insert" on public.articles;
drop policy if exists "admin update" on public.articles;
drop policy if exists "admin delete" on public.articles;

create policy "public read"  on public.articles for select using (true);
create policy "admin insert" on public.articles for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.articles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin delete" on public.articles for delete to authenticated using (public.is_admin());

-- ============================================================
-- 3-1) 기사 사진 저장소 (Storage 버킷 'article-images')
--      - 버킷은 public: 독자는 주소만으로 사진을 볼 수 있음
--      - 업로드/수정/삭제/목록 조회는 관리자만 가능
--      - 파일당 5MB, jpeg/png/webp/gif 만 허용
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'article-images', 'article-images', true, 5242880,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "article images admin select" on storage.objects;
drop policy if exists "article images admin insert" on storage.objects;
drop policy if exists "article images admin update" on storage.objects;
drop policy if exists "article images admin delete" on storage.objects;

create policy "article images admin select" on storage.objects
  for select to authenticated
  using (bucket_id = 'article-images' and public.is_admin());

create policy "article images admin insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'article-images' and public.is_admin());

create policy "article images admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'article-images' and public.is_admin())
  with check (bucket_id = 'article-images' and public.is_admin());

create policy "article images admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'article-images' and public.is_admin());

-- ============================================================
-- 3-2) 취재처(AI가 가져올 곳) 관리 테이블 - 관리자만 접근
--      engine.py 는 service_role 키로 읽고, 마지막 실행 결과를 기록합니다.
-- ============================================================
create table if not exists public.news_sources (
  id              bigint generated always as identity primary key,
  name            text        not null,              -- 취재처 이름 (예: 해남군청 고시/공고)
  region          text        not null,              -- 지역/구분 (기사 바이라인에 사용)
  url             text,                              -- 보도자료 게시판 목록 주소 또는 RSS 주소
  keywords        text,                              -- 취재 지침/검색 키워드 (대체 검색 시 사용, 선택)
  enabled         boolean     not null default true, -- 자동 취재 사용 여부
  last_run_at     timestamptz,
  last_status     text,
  last_article_id bigint,
  created_at      timestamptz not null default now()
);

alter table public.news_sources enable row level security;

drop policy if exists "admin all sources" on public.news_sources;
create policy "admin all sources" on public.news_sources
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 기본 취재처: 지자체 '보도자료 게시판' 주소 (테이블이 비어 있을 때만 1회 입력)
--   url 에는 보도자료 게시판 목록 주소 또는 RSS/Atom 주소를 넣습니다.
insert into public.news_sources (name, region, url, keywords)
select v.name, v.region, v.url, v.keywords
from (values
  ('해남군청 보도자료', '해남군', 'https://www.haenam.go.kr/index.9is?contentUid=18e3368f5d745106015d877ab2850a94', null),
  ('목포시청 보도자료', '목포시', 'https://www.mokpo.go.kr/www/mokpo_news/press_release/report_material', null)
) as v(name, region, url, keywords)
where not exists (select 1 from public.news_sources);

-- 예전 기본값(지자체 메인 주소 / 고시·공고 검색용)을 쓰던 경우 보도자료 게시판 주소로 교체
update public.news_sources
   set name = '해남군청 보도자료',
       url  = 'https://www.haenam.go.kr/index.9is?contentUid=18e3368f5d745106015d877ab2850a94'
 where url in ('https://www.haenam.go.kr', 'https://www.haenam.go.kr/')
   and name = '해남군청 고시/공고';

update public.news_sources
   set name = '목포시청 보도자료',
       url  = 'https://www.mokpo.go.kr/www/mokpo_news/press_release/report_material'
 where url in ('https://www.mokpo.go.kr', 'https://www.mokpo.go.kr/')
   and name = '목포시청 고시/공고';

-- ============================================================
-- 4) 관리자 등록 (Authentication > Users 에서 사용자를 먼저 만든 뒤 실행)
--    아래 이메일을 실제 관리자 이메일로 바꿔서 실행하세요.
-- ============================================================
-- insert into public.admin_users (email) values ('admin@example.com')
-- on conflict (email) do nothing;

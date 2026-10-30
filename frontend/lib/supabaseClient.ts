import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Supabase 환경변수가 없습니다. frontend/.env.local 에 NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY 를 설정하세요."
  );
}

const isBrowser = typeof window !== "undefined";

/**
 * 모든 Supabase 요청을 캐시하지 않는다.
 *
 * Next.js(App Router)는 서버에서 fetch 응답을 기본적으로 캐시(Data Cache, 기본 1년)한다.
 * supabase-js 는 내부에서 fetch 를 호출하므로, `export const dynamic = "force-dynamic"` 만으로는
 * 막히지 않아 '기사가 없던 시점의 빈 응답'이 계속 재사용되는 문제가 생길 수 있다.
 * 그래서 클라이언트 단에서 항상 cache: "no-store" 로 호출한다.
 */
const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

// 브라우저에서는 관리자 로그인 세션을 유지하고, 서버(SSR)에서는 세션을 저장하지 않는다.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: isBrowser,
    autoRefreshToken: isBrowser,
    detectSessionInUrl: false,
  },
  global: { fetch: noStoreFetch },
});

export const CATEGORIES = [
  "정치/행정",
  "경제/산업",
  "사회/지역",
  "문화/라이프",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type AuthorType = "AI" | "HUMAN";

export interface ArticleImage {
  url: string;
  caption: string;
}

export interface Article {
  id: number;
  title: string;
  subtitle: string | null;
  category: Category;
  author: string;
  author_type: AuthorType;
  content: string;
  images: ArticleImage[] | null;
  created_at: string;
}

/** 기사 사진 Storage 버킷 이름 */
export const IMAGE_BUCKET = "article-images";
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 공개 URL 에서 Storage 파일 경로 추출 (삭제 시 사용) */
export function storagePathFromUrl(url: string): string | null {
  const marker = `/${IMAGE_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length).split("?")[0]);
}

/** AI 자동 취재처 (news_sources 테이블) */
export interface NewsSource {
  id: number;
  name: string;
  region: string;
  url: string | null;
  keywords: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_article_id: number | null;
  created_at: string;
}

/** 한국 표준시 기준 날짜 포맷 (서버/클라이언트 동일 결과) */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

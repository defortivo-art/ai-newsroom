import Link from "next/link";
import {
  supabase,
  CATEGORIES,
  formatDate,
  type Article,
} from "@/lib/supabaseClient";

// 매 요청마다 최신 기사를 읽도록 모든 캐시를 끈다.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** 메인에 노출할 최대 기사 수 (Top 1건 + 그리드) */
const MAX_ARTICLES = 100;

function AuthorBadge({ type }: { type: Article["author_type"] }) {
  return type === "AI" ? (
    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-800">AI</span>
  ) : null;
}

function leadImageUrl(a: Article): string | null {
  return (a.images ?? []).find((img) => img?.url)?.url ?? null;
}

function excerpt(content: string, len: number) {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > len ? flat.slice(0, len) + "…" : flat;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: { category?: string };
}) {
  const category = searchParams.category;
  const validCategory = CATEGORIES.find((c) => c === category);

  // 작성자 유형(AI/HUMAN)이나 사진 유무와 무관하게 전체 기사를 최신순으로 가져온다.
  // (id 를 보조 정렬 기준으로 두어 작성 시각이 같아도 순서가 항상 일정하다)
  let query = supabase
    .from("articles")
    .select("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_ARTICLES);

  if (validCategory) query = query.eq("category", validCategory);

  const { data, error } = await query;
  const articles = (data ?? []) as Article[];

  if (error) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-6 text-red-700">
        기사를 불러오지 못했습니다: {error.message}
      </div>
    );
  }

  if (articles.length === 0) {
    return (
      <div className="py-24 text-center text-gray-500">
        <p className="font-serif text-2xl font-bold">
          {validCategory ? `'${validCategory}' 분야에 ` : ""}아직 출고된 기사가 없습니다.
        </p>
        <Link
          href="/admin/write"
          className="mt-6 inline-block rounded bg-brand px-5 py-2 text-sm font-bold text-white hover:bg-red-900"
        >
          첫 기사 송고하기
        </Link>
      </div>
    );
  }

  const [top, ...rest] = articles;
  const topImage = leadImageUrl(top);

  return (
    <div>
      {validCategory && (
        <h2 className="mb-6 border-b-2 border-ink pb-2 font-serif text-2xl font-black">
          {validCategory}
        </h2>
      )}

      {/* ===== 1면 톱기사 ===== */}
      <Link
        href={`/article/${top.id}`}
        className="group block overflow-hidden rounded-sm border border-gray-300 bg-white"
      >
        <div className="relative isolate overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-brand px-6 py-12 text-white sm:px-12 sm:py-16">
          {topImage && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={topImage}
                alt=""
                className="absolute inset-0 -z-20 h-full w-full object-cover"
              />
              <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/55 to-black/30" />
            </>
          )}
          <div className="mb-4 flex items-center gap-2 text-xs font-bold">
            <span className="rounded bg-white px-2 py-0.5 text-brand">TOP</span>
            <span className="opacity-90">{top.category}</span>
            {top.author_type === "AI" && (
              <span className="rounded bg-blue-500 px-1.5 py-0.5 text-[10px]">AI</span>
            )}
          </div>
          <h1 className="font-serif text-3xl font-black leading-tight group-hover:underline sm:text-5xl">
            {top.title}
          </h1>
          {top.subtitle && (
            <p className="mt-4 max-w-3xl font-serif text-lg text-gray-200 sm:text-xl">
              {top.subtitle}
            </p>
          )}
          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-gray-300">
            {excerpt(top.content, 160)}
          </p>
          <p className="mt-6 text-xs text-gray-300">
            {top.author} · {formatDate(top.created_at)}
          </p>
        </div>
      </Link>

      {/* ===== 최신 기사 3열 그리드 ===== */}
      {rest.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-6 border-b-2 border-ink pb-2 font-serif text-2xl font-black">
            최신 기사
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((a) => {
              const thumb = leadImageUrl(a);
              return (
              <Link
                key={a.id}
                href={`/article/${a.id}`}
                className="group flex flex-col rounded-sm border border-gray-300 bg-white p-5 transition hover:shadow-md"
              >
                {thumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt=""
                    loading="lazy"
                    className="mb-3 aspect-[16/10] w-full rounded-sm object-cover"
                  />
                )}
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <span className="font-bold text-brand">{a.category}</span>
                  <AuthorBadge type={a.author_type} />
                </div>
                <h3 className="font-serif text-xl font-bold leading-snug group-hover:underline">
                  {a.title}
                </h3>
                {a.subtitle && (
                  <p className="mt-2 text-sm font-medium text-gray-600">{a.subtitle}</p>
                )}
                <p className="mt-3 flex-1 text-sm leading-relaxed text-gray-600">
                  {excerpt(a.content, 90)}
                </p>
                <p className="mt-4 border-t border-gray-200 pt-3 text-xs text-gray-500">
                  {a.author} · {formatDate(a.created_at)}
                </p>
              </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

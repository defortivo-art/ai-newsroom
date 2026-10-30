import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabase, formatDate, type Article } from "@/lib/supabaseClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

async function getArticle(idParam: string): Promise<Article | null> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;

  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;
  return data as Article;
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const article = await getArticle(params.id);
  if (!article) return { title: "기사를 찾을 수 없습니다" };
  return {
    title: article.title,
    description: article.subtitle ?? undefined,
  };
}

export default async function ArticlePage({ params }: { params: { id: string } }) {
  const article = await getArticle(params.id);
  if (!article) notFound();

  // 줄바꿈 처리: 하나 이상의 개행을 문단 경계로 취급
  const paragraphs = article.content
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const images = (article.images ?? []).filter((img) => img?.url);
  const [leadImage, ...restImages] = images;

  return (
    <article className="mx-auto max-w-3xl">
      {article.author_type === "AI" && (
        <div className="mb-6 flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-900">
          <span className="rounded bg-blue-700 px-2 py-0.5 text-xs font-bold text-white">AI</span>
          AI 가상뉴스룸이 공공 데이터를 분석해 출고한 기사입니다
        </div>
      )}

      <p className="text-sm font-bold text-brand">{article.category}</p>
      <h1 className="mt-2 font-serif text-3xl font-black leading-tight sm:text-4xl">
        {article.title}
      </h1>
      {article.subtitle && (
        <h2 className="mt-4 font-serif text-lg font-medium text-gray-600 sm:text-xl">
          {article.subtitle}
        </h2>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-gray-300 py-3 text-sm text-gray-600">
        <span className="font-bold text-ink">{article.author}</span>
        <span>출고 {formatDate(article.created_at)}</span>
      </div>

      {leadImage && (
        <figure className="mt-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={leadImage.url}
            alt={leadImage.caption || article.title}
            className="w-full rounded-sm border border-gray-200 object-cover"
          />
          {leadImage.caption && (
            <figcaption className="mt-2 text-sm text-gray-600">{leadImage.caption}</figcaption>
          )}
        </figure>
      )}

      <div className="mt-8 space-y-5 font-serif text-[17px] leading-8 text-gray-900">
        {paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            {p}
          </p>
        ))}
      </div>

      {restImages.length > 0 && (
        <div className="mt-8 space-y-6">
          {restImages.map((img, i) => (
            <figure key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.caption || `${article.title} 사진 ${i + 2}`}
                className="w-full rounded-sm border border-gray-200 object-cover"
              />
              {img.caption && (
                <figcaption className="mt-2 text-sm text-gray-600">{img.caption}</figcaption>
              )}
            </figure>
          ))}
        </div>
      )}

      <div className="mt-12 border-t border-gray-300 pt-6">
        <Link href="/" className="text-sm font-bold text-brand hover:underline">
          ← 목록으로 돌아가기
        </Link>
      </div>
    </article>
  );
}

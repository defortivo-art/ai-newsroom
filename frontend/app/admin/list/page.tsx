"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  supabase,
  formatDate,
  IMAGE_BUCKET,
  storagePathFromUrl,
  type Article,
} from "@/lib/supabaseClient";

type Row = Pick<
  Article,
  "id" | "title" | "author" | "author_type" | "category" | "created_at" | "images"
>;

export default function AdminListPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("articles")
      .select("id,title,author,author_type,category,created_at,images")
      .order("created_at", { ascending: false });

    if (error) setError(error.message);
    else setRows((data ?? []) as Row[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(row: Row) {
    if (!window.confirm(`[#${row.id}] "${row.title}"\n\n이 기사를 영구 삭제하시겠습니까?`)) return;

    setDeletingId(row.id);
    const { error } = await supabase.from("articles").delete().eq("id", row.id);
    setDeletingId(null);

    if (error) {
      window.alert(`삭제 실패: ${error.message}`);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));

    // 기사에 첨부된 사진 파일도 Storage 에서 함께 삭제
    const paths = (row.images ?? [])
      .map((img) => storagePathFromUrl(img.url))
      .filter((p): p is string => !!p);
    if (paths.length) {
      const { error: rmError } = await supabase.storage.from(IMAGE_BUCKET).remove(paths);
      if (rmError) window.alert(`기사는 삭제되었으나 사진 파일 삭제에 실패했습니다: ${rmError.message}`);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between border-b-2 border-ink pb-3">
        <h1 className="font-serif text-3xl font-black">
          기사 관리 <span className="text-lg font-normal text-gray-500">({rows.length}건)</span>
        </h1>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="rounded border border-gray-400 px-4 py-2 text-sm font-bold hover:bg-gray-100"
          >
            새로고침
          </button>
          <Link
            href="/admin/write"
            className="rounded bg-brand px-4 py-2 text-sm font-bold text-white hover:bg-red-900"
          >
            새 기사 송고
          </Link>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          불러오기 실패: {error}
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded border border-gray-300 bg-white">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-gray-100 text-xs uppercase text-gray-600">
            <tr>
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">제목</th>
              <th className="px-4 py-3">작성자</th>
              <th className="px-4 py-3">카테고리</th>
              <th className="px-4 py-3">작성일시</th>
              <th className="px-4 py-3 text-center">관리</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                  불러오는 중...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                  발행된 기사가 없습니다.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-200 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500">{r.id}</td>
                  <td className="max-w-xs px-4 py-3">
                    <Link
                      href={`/article/${r.id}`}
                      className="font-bold hover:text-brand hover:underline"
                    >
                      {r.title}
                    </Link>
                    {(r.images ?? []).length > 0 && (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 align-middle text-[10px] font-bold text-gray-700">
                        사진 {(r.images ?? []).length}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1">
                      {r.author_type === "AI" ? (
                        <span className="rounded bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-800">
                          AI 기사
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                          인간 기자
                        </span>
                      )}
                      <span className="text-xs text-gray-600">{r.author}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">{r.category}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                    {formatDate(r.created_at)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-2">
                      <Link
                        href={`/article/${r.id}`}
                        className="rounded border border-gray-300 px-3 py-1 text-xs font-bold hover:bg-gray-100"
                      >
                        확인
                      </Link>
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={deletingId === r.id}
                        className="rounded bg-red-600 px-3 py-1 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {deletingId === r.id ? "삭제 중" : "삭제"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase, formatDate, type NewsSource } from "@/lib/supabaseClient";

type ToastState = { type: "success" | "error"; message: string } | null;

const REGION_SUGGESTIONS = ["해남군", "목포시", "광주광역시", "전라남도", "나주시", "여수시", "순천시", "광양시"];

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export default function SourcesPage() {
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 폼 상태 (editingId 가 있으면 수정 모드)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [url, setUrl] = useState("");
  const [keywords, setKeywords] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const [toast, setToast] = useState<ToastState>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);

  function showToast(t: NonNullable<ToastState>, ms = 3000) {
    setToast(t);
    timers.current.push(setTimeout(() => setToast(null), ms));
  }

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase
      .from("news_sources")
      .select("*")
      .order("id", { ascending: true });

    if (error) setLoadError(error.message);
    else setSources((data ?? []) as NewsSource[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setRegion("");
    setUrl("");
    setKeywords("");
    setEnabled(true);
  }

  function startEdit(s: NewsSource) {
    setEditingId(s.id);
    setName(s.name);
    setRegion(s.region);
    setUrl(s.url ?? "");
    setKeywords(s.keywords ?? "");
    setEnabled(s.enabled);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;

    const trimmedUrl = url.trim();
    if (!name.trim() || !region.trim()) {
      showToast({ type: "error", message: "취재처 이름과 지역은 필수입니다." });
      return;
    }
    if (trimmedUrl && !isValidUrl(trimmedUrl)) {
      showToast({ type: "error", message: "웹사이트 주소는 http:// 또는 https:// 로 시작해야 합니다." });
      return;
    }

    setSaving(true);
    const payload = {
      name: name.trim(),
      region: region.trim(),
      url: trimmedUrl || null,
      keywords: keywords.trim() || null,
      enabled,
    };

    const { error } =
      editingId === null
        ? await supabase.from("news_sources").insert(payload)
        : await supabase.from("news_sources").update(payload).eq("id", editingId);

    setSaving(false);

    if (error) {
      showToast({ type: "error", message: `저장 실패: ${error.message}` }, 5000);
      return;
    }

    showToast({
      type: "success",
      message: editingId === null ? "취재처가 추가되었습니다." : "취재처가 수정되었습니다.",
    });
    resetForm();
    load();
  }

  async function toggleEnabled(s: NewsSource) {
    const next = !s.enabled;
    setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: next } : x)));

    const { error } = await supabase.from("news_sources").update({ enabled: next }).eq("id", s.id);
    if (error) {
      setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: s.enabled } : x)));
      showToast({ type: "error", message: `변경 실패: ${error.message}` }, 5000);
    }
  }

  async function handleDelete(s: NewsSource) {
    if (!window.confirm(`[${s.region}] "${s.name}" 취재처를 삭제하시겠습니까?`)) return;

    const { error } = await supabase.from("news_sources").delete().eq("id", s.id);
    if (error) {
      showToast({ type: "error", message: `삭제 실패: ${error.message}` }, 5000);
      return;
    }
    setSources((prev) => prev.filter((x) => x.id !== s.id));
    if (editingId === s.id) resetForm();
    showToast({ type: "success", message: "삭제되었습니다." });
  }

  const inputCls =
    "w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";
  const enabledCount = sources.filter((s) => s.enabled).length;

  return (
    <div>
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed right-4 top-4 z-50 max-w-sm rounded-md px-5 py-3 text-sm font-bold text-white shadow-lg ${
            toast.type === "success" ? "bg-green-700" : "bg-red-700"
          }`}
        >
          {toast.message}
        </div>
      )}

      <div className="flex items-end justify-between border-b-2 border-ink pb-3">
        <h1 className="font-serif text-3xl font-black">
          AI 취재처 관리{" "}
          <span className="text-lg font-normal text-gray-500">
            (사용 {enabledCount} / 전체 {sources.length})
          </span>
        </h1>
        <button
          onClick={load}
          className="rounded border border-gray-400 px-4 py-2 text-sm font-bold hover:bg-gray-100"
        >
          새로고침
        </button>
      </div>
      <p className="mt-3 text-sm text-gray-600">
        AI 엔진(<code className="rounded bg-gray-100 px-1">python engine.py</code>)은 여기서 <strong>사용 중</strong>인
        취재처마다 보도자료 게시판에서 최신 글(기본 3건)을 가져와 기사를 작성합니다. 이미 송고한 보도자료는 건너뜁니다.
      </p>

      {/* ===== 입력 폼 ===== */}
      <form
        onSubmit={handleSubmit}
        className="mt-6 space-y-4 rounded border border-gray-300 bg-white p-5"
      >
        <h2 className="font-serif text-xl font-bold">
          {editingId === null ? "새 취재처 추가" : `취재처 수정 (#${editingId})`}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="src-name" className="mb-1 block text-sm font-bold">
              취재처 이름 <span className="text-brand">*</span>
            </label>
            <input
              id="src-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 해남군청 보도자료"
              maxLength={80}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="src-region" className="mb-1 block text-sm font-bold">
              지역 <span className="text-brand">*</span>
              <span className="ml-1 font-normal text-gray-500">(기사 바이라인에 표시)</span>
            </label>
            <input
              id="src-region"
              type="text"
              list="region-list"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="예: 해남군"
              maxLength={30}
              className={inputCls}
            />
            <datalist id="region-list">
              {REGION_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
        </div>

        <div>
          <label htmlFor="src-url" className="mb-1 block text-sm font-bold">
            보도자료 게시판 주소 <span className="font-normal text-gray-500">(또는 RSS 주소)</span>
          </label>
          <input
            id="src-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.mokpo.go.kr/www/mokpo_news/press_release/report_material"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-gray-500">
            브라우저에서 해당 기관의 <strong>보도자료 목록 페이지</strong>를 열어 주소창의 주소를 붙여넣으세요.
            AI 엔진이 이 게시판에서 최신 글 3건의 본문을 직접 가져와 기사로 만듭니다.
            기관 메인 주소만 넣으면 &apos;보도자료&apos; 메뉴를 찾아가지만, 목록 주소를 넣는 것이 가장 정확합니다.
            비워두거나 읽지 못하면 뉴스 검색 방식으로 대신 취재합니다.
          </p>
        </div>

        <div>
          <label htmlFor="src-keywords" className="mb-1 block text-sm font-bold">
            검색 키워드 <span className="font-normal text-gray-500">(선택 · 게시판을 읽지 못해 검색으로 대체할 때만 사용)</span>
          </label>
          <textarea
            id="src-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="예: 모집공고, 청년 지원사업"
            rows={2}
            maxLength={300}
            className={`${inputCls} resize-y`}
          />
        </div>

        <label className="flex items-center gap-2 text-sm font-bold">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-red-800"
          />
          자동 취재에 사용
        </label>

        <div className="flex justify-end gap-2">
          {editingId !== null && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded border border-gray-400 px-5 py-2 text-sm font-bold hover:bg-gray-100"
            >
              수정 취소
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-brand px-6 py-2 text-sm font-bold text-white hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "저장 중..." : editingId === null ? "취재처 추가" : "수정 저장"}
          </button>
        </div>
      </form>

      {/* ===== 목록 ===== */}
      {loadError && (
        <div className="mt-6 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          불러오기 실패: {loadError}
          <br />
          <span className="text-xs">
            Supabase SQL Editor에서 최신 <code>supabase_schema.sql</code> 을 실행했는지 확인하세요.
          </span>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded border border-gray-300 bg-white">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-gray-100 text-xs uppercase text-gray-600">
            <tr>
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">사용</th>
              <th className="px-4 py-3">취재처 / 지역</th>
              <th className="px-4 py-3">웹사이트 · 지침</th>
              <th className="px-4 py-3">마지막 실행</th>
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
            ) : sources.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                  등록된 취재처가 없습니다. 위 폼에서 추가하세요.
                </td>
              </tr>
            ) : (
              sources.map((s) => (
                <tr key={s.id} className={`border-t border-gray-200 ${s.enabled ? "" : "bg-gray-50 text-gray-400"}`}>
                  <td className="px-4 py-3 text-gray-500">{s.id}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleEnabled(s)}
                      aria-pressed={s.enabled}
                      aria-label={s.enabled ? "사용 중 (클릭하면 중지)" : "중지됨 (클릭하면 사용)"}
                      className={`relative h-6 w-11 rounded-full transition ${s.enabled ? "bg-green-600" : "bg-gray-300"}`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                          s.enabled ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-bold">{s.name}</p>
                    <p className="text-xs">{s.region}</p>
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-blue-700 hover:underline"
                      >
                        {s.url}
                      </a>
                    ) : (
                      <span className="text-gray-400">주소 없음 (뉴스 검색으로 취재)</span>
                    )}
                    {s.keywords && <p className="mt-1 text-gray-600">{s.keywords}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {s.last_run_at ? (
                      <>
                        <p className="text-gray-600">{formatDate(s.last_run_at)}</p>
                        <p
                          className={
                            s.last_status?.startsWith("실패") ? "font-bold text-red-600" : "text-gray-700"
                          }
                        >
                          {s.last_status}
                        </p>
                        {s.last_article_id && (
                          <Link
                            href={`/article/${s.last_article_id}`}
                            className="text-blue-700 hover:underline"
                          >
                            기사 보기 →
                          </Link>
                        )}
                      </>
                    ) : (
                      <span className="text-gray-400">아직 실행 안 됨</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-2">
                      <button
                        onClick={() => startEdit(s)}
                        className="rounded border border-gray-300 px-3 py-1 text-xs font-bold hover:bg-gray-100"
                      >
                        수정
                      </button>
                      <button
                        onClick={() => handleDelete(s)}
                        className="rounded bg-red-600 px-3 py-1 text-xs font-bold text-white hover:bg-red-700"
                      >
                        삭제
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

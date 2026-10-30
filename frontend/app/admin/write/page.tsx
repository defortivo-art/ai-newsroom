"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  supabase,
  CATEGORIES,
  IMAGE_BUCKET,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_TYPES,
  type ArticleImage,
  type Category,
} from "@/lib/supabaseClient";

type ToastState = { type: "success" | "error"; message: string } | null;

interface PhotoItem {
  key: string;
  file: File;
  preview: string; // 브라우저 미리보기용 object URL
  caption: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function WritePage() {
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [category, setCategory] = useState<Category>(CATEGORIES[0]);
  const [author, setAuthor] = useState("");
  const [content, setContent] = useState("");
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<PhotoItem[]>([]);
  photosRef.current = photos;

  useEffect(() => {
    const list = timers.current;
    return () => {
      list.forEach(clearTimeout);
      photosRef.current.forEach((p) => URL.revokeObjectURL(p.preview));
    };
  }, []);

  function showToast(t: NonNullable<ToastState>, ms = 3000) {
    setToast(t);
    timers.current.push(setTimeout(() => setToast(null), ms));
  }

  // ----- 사진 선택/관리 -----
  function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 같은 파일 재선택 가능하게 초기화
    if (files.length === 0) return;

    const accepted: PhotoItem[] = [];
    const problems: string[] = [];
    let slots = MAX_IMAGES - photos.length;

    for (const file of files) {
      if (!(file.type in ALLOWED_IMAGE_TYPES)) {
        problems.push(`${file.name}: JPG/PNG/WEBP/GIF 만 가능`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        problems.push(`${file.name}: ${formatBytes(file.size)} (최대 5MB)`);
        continue;
      }
      if (slots <= 0) {
        problems.push(`${file.name}: 사진은 최대 ${MAX_IMAGES}장`);
        continue;
      }
      slots -= 1;
      accepted.push({
        key: crypto.randomUUID(),
        file,
        preview: URL.createObjectURL(file),
        caption: "",
      });
    }

    if (accepted.length) setPhotos((prev) => [...prev, ...accepted]);
    if (problems.length) showToast({ type: "error", message: problems.join("\n") }, 5000);
  }

  function removePhoto(key: string) {
    setPhotos((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((p) => p.key !== key);
    });
  }

  function setCaption(key: string, caption: string) {
    setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, caption } : p)));
  }

  function makeLead(key: string) {
    setPhotos((prev) => {
      const target = prev.find((p) => p.key === key);
      if (!target) return prev;
      return [target, ...prev.filter((p) => p.key !== key)];
    });
  }

  // ----- 송고 -----
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (!title.trim() || !author.trim() || !content.trim()) {
      showToast({ type: "error", message: "제목, 바이라인, 본문은 필수입니다." });
      return;
    }

    setSubmitting(true);
    const uploadedPaths: string[] = [];
    const images: ArticleImage[] = [];

    try {
      // 1) 사진 업로드
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        setProgress(`사진 업로드 중 (${i + 1}/${photos.length})`);

        const ext = ALLOWED_IMAGE_TYPES[p.file.type];
        const d = new Date();
        const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;

        const { error: upError } = await supabase.storage
          .from(IMAGE_BUCKET)
          .upload(path, p.file, { contentType: p.file.type, cacheControl: "31536000", upsert: false });

        if (upError) throw new Error(`사진 업로드 실패(${p.file.name}): ${upError.message}`);

        uploadedPaths.push(path);
        const { data: pub } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
        images.push({ url: pub.publicUrl, caption: p.caption.trim() });
      }

      // 2) 기사 저장
      setProgress("기사 송고 중");
      const { data, error } = await supabase
        .from("articles")
        .insert({
          title: title.trim(),
          subtitle: subtitle.trim() || null,
          category,
          author: author.trim(),
          author_type: "HUMAN", // 직접 송고는 항상 HUMAN
          content: content.trim(),
          images,
        })
        .select("id")
        .single();

      if (error || !data) throw new Error(error?.message ?? "알 수 없는 오류");

      showToast({ type: "success", message: "기사가 성공적으로 송고되었습니다. 기사 페이지로 이동합니다." }, 2500);
      timers.current.push(setTimeout(() => router.push(`/article/${data.id}`), 1200));
    } catch (err) {
      // 기사 저장에 실패하면 이미 올린 사진을 정리해 고아 파일이 남지 않게 한다.
      if (uploadedPaths.length) {
        await supabase.storage.from(IMAGE_BUCKET).remove(uploadedPaths);
      }
      setSubmitting(false);
      setProgress(null);
      showToast(
        { type: "error", message: `송고 실패: ${err instanceof Error ? err.message : String(err)}` },
        6000
      );
    }
  }

  const inputCls =
    "w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";

  return (
    <div className="mx-auto max-w-3xl">
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed right-4 top-4 z-50 max-w-sm whitespace-pre-line rounded-md px-5 py-3 text-sm font-bold text-white shadow-lg ${
            toast.type === "success" ? "bg-green-700" : "bg-red-700"
          }`}
        >
          {toast.message}
        </div>
      )}

      <h1 className="border-b-2 border-ink pb-3 font-serif text-3xl font-black">기사 송고실</h1>
      <p className="mt-2 text-sm text-gray-600">
        작성한 기사는 즉시 독자 페이지에 출고됩니다.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <div>
          <label htmlFor="title" className="mb-1 block text-sm font-bold">
            기사 제목 <span className="text-brand">*</span>
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="헤드라인을 입력하세요"
            maxLength={120}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="subtitle" className="mb-1 block text-sm font-bold">
            부제목
          </label>
          <input
            id="subtitle"
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="부제목을 입력하세요"
            maxLength={160}
            className={inputCls}
          />
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <label htmlFor="category" className="mb-1 block text-sm font-bold">
              카테고리 <span className="text-brand">*</span>
            </label>
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className={inputCls}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="author" className="mb-1 block text-sm font-bold">
              작성자 바이라인 <span className="text-brand">*</span>
            </label>
            <input
              id="author"
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="예: 목포취재본부 김철수 기자"
              maxLength={80}
              className={inputCls}
            />
          </div>
        </div>

        {/* ===== 사진 첨부 ===== */}
        <div>
          <div className="mb-1 flex items-end justify-between">
            <label className="block text-sm font-bold">
              사진 첨부{" "}
              <span className="font-normal text-gray-500">
                ({photos.length}/{MAX_IMAGES}장 · JPG/PNG/WEBP/GIF · 장당 5MB 이하)
              </span>
            </label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={photos.length >= MAX_IMAGES || submitting}
              className="rounded border border-gray-400 bg-white px-4 py-1.5 text-sm font-bold hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              사진 추가
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={handleFiles}
            className="hidden"
          />

          {photos.length === 0 ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center rounded border-2 border-dashed border-gray-300 bg-white py-10 text-sm text-gray-500 hover:border-brand hover:text-brand"
            >
              <span className="font-bold">클릭해서 사진을 선택하세요</span>
              <span className="mt-1 text-xs">첫 번째 사진이 대표 사진으로 표시됩니다</span>
            </button>
          ) : (
            <ul className="space-y-3">
              {photos.map((p, idx) => (
                <li key={p.key} className="flex gap-3 rounded border border-gray-300 bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.preview}
                    alt={`첨부 사진 ${idx + 1}`}
                    className="h-24 w-32 flex-none rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      {idx === 0 ? (
                        <span className="rounded bg-brand px-2 py-0.5 font-bold text-white">대표 사진</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => makeLead(p.key)}
                          className="rounded border border-gray-400 px-2 py-0.5 font-bold hover:bg-gray-100"
                        >
                          대표로 지정
                        </button>
                      )}
                      <span className="truncate text-gray-500">
                        {p.file.name} · {formatBytes(p.file.size)}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={p.caption}
                      onChange={(e) => setCaption(p.key, e.target.value)}
                      placeholder="사진 설명(캡션) - 예: 해남군청 전경 / 사진=홍길동 기자"
                      maxLength={200}
                      className={inputCls}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removePhoto(p.key)}
                    disabled={submitting}
                    className="h-8 flex-none rounded bg-red-600 px-3 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label htmlFor="content" className="mb-1 block text-sm font-bold">
            본문 <span className="text-brand">*</span>
          </label>
          <textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="본문을 입력하세요. 줄바꿈은 문단으로 표시됩니다."
            rows={16}
            className={`${inputCls} resize-y font-serif leading-7`}
          />
          <p className="mt-1 text-right text-xs text-gray-500">{content.length.toLocaleString()}자</p>
        </div>

        <div className="flex items-center justify-end gap-4">
          {progress && <span className="text-sm text-gray-600">{progress}...</span>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-brand px-8 py-3 text-sm font-bold text-white hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "송고 중..." : "기사 즉시 송고"}
          </button>
        </div>
      </form>
    </div>
  );
}

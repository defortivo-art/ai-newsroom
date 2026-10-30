"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

/** 오픈 리다이렉트 방지: 내부 /admin 경로만 허용 */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/admin") && !raw.startsWith("//")) return raw;
  return "/admin/list";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // 이미 관리자로 로그인되어 있으면 바로 이동
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "forbidden") {
      setError("관리자 권한이 없는 계정입니다.");
    }

    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        const { data: isAdmin } = await supabase.rpc("is_admin");
        if (!cancelled && isAdmin === true) {
          router.replace(safeNext(params.get("next")));
          return;
        }
      }
      if (!cancelled) setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!email.trim() || !password) {
      setError("이메일과 비밀번호를 입력하세요.");
      return;
    }

    setSubmitting(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setSubmitting(false);
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      return;
    }

    const { data: isAdmin, error: rpcError } = await supabase.rpc("is_admin");
    if (rpcError || isAdmin !== true) {
      await supabase.auth.signOut();
      setSubmitting(false);
      setError(
        rpcError
          ? `권한 확인 실패: ${rpcError.message}`
          : "관리자 권한이 없는 계정입니다."
      );
      return;
    }

    const params = new URLSearchParams(window.location.search);
    router.replace(safeNext(params.get("next")));
  }

  const inputCls =
    "w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";

  if (checking) {
    return <p className="py-24 text-center text-sm text-gray-500">확인 중...</p>;
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <h1 className="border-b-2 border-ink pb-3 text-center font-serif text-3xl font-black">
        관리자 로그인
      </h1>
      <p className="mt-3 text-center text-sm text-gray-600">
        기사 송고실과 기사 관리는 등록된 관리자만 이용할 수 있습니다.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-bold">
            이메일
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-bold">
            비밀번호
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </div>

        {error && (
          <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-brand py-3 text-sm font-bold text-white hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "로그인 중..." : "로그인"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm">
        <Link href="/" className="text-gray-500 hover:text-brand hover:underline">
          ← 독자 페이지로 돌아가기
        </Link>
      </p>
    </div>
  );
}

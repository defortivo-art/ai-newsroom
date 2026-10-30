"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

/**
 * /admin/* 접근 가드.
 * - 세션이 없으면 /login 으로 이동
 * - 세션은 있으나 관리자(is_admin)가 아니면 로그아웃 후 /login 으로 이동
 * 실제 쓰기/삭제 권한은 DB의 RLS 정책(is_admin)이 최종적으로 강제합니다.
 */
export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }

      const { data: isAdmin } = await supabase.rpc("is_admin");
      if (isAdmin !== true) {
        await supabase.auth.signOut();
        router.replace("/login?error=forbidden");
        return;
      }

      if (!cancelled) {
        setEmail(session.user.email ?? null);
        setReady(true);
      }
    }

    check();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setReady(false);
        router.replace("/login");
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [router, pathname]);

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  if (!ready) {
    return <p className="py-24 text-center text-sm text-gray-500">관리자 권한 확인 중...</p>;
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-end gap-3 text-xs text-gray-600">
        <span>
          관리자: <strong className="text-ink">{email}</strong>
        </span>
        <button
          onClick={handleLogout}
          className="rounded border border-gray-400 px-3 py-1 font-bold hover:bg-gray-100"
        >
          로그아웃
        </button>
      </div>
      {children}
    </>
  );
}

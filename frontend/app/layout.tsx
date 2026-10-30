import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { CATEGORIES } from "@/lib/supabaseClient";

export const metadata: Metadata = {
  title: {
    default: "광주전남SI뉴스",
    template: "%s | 광주전남SI뉴스",
  },
  description: "AI와 기자가 함께 만드는 광주·전남 지역 인터넷신문",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const today = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col font-sans">
        {/* ===== GNB ===== */}
        <header className="border-b-2 border-ink bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2 text-xs text-gray-600">
            <span>{today}</span>
            <Link
              href="/admin/write"
              className="rounded bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-red-900"
            >
              기사 송고실
            </Link>
          </div>

          <div className="mx-auto max-w-6xl px-4 py-5 text-center">
            <Link href="/" className="font-serif text-4xl font-black tracking-tight sm:text-5xl">
              광주전남<span className="text-brand">SI</span>뉴스
            </Link>
          </div>

          <nav className="border-t border-gray-300">
            <ul className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-1 px-4 py-3 text-sm font-bold">
              <li>
                <Link href="/" className="hover:text-brand">
                  전체
                </Link>
              </li>
              {CATEGORIES.map((c) => (
                <li key={c}>
                  <Link href={`/?category=${encodeURIComponent(c)}`} className="hover:text-brand">
                    {c}
                  </Link>
                </li>
              ))}
              <li className="text-gray-400">|</li>
              <li>
                <Link href="/admin/list" className="font-normal text-gray-500 hover:text-brand">
                  기사 관리
                </Link>
              </li>
              <li>
                <Link href="/admin/sources" className="font-normal text-gray-500 hover:text-brand">
                  AI 취재처 관리
                </Link>
              </li>
            </ul>
          </nav>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>

        {/* ===== 신문법 준수 푸터 ===== */}
        <footer className="mt-12 border-t-4 border-ink bg-gray-100 text-sm text-gray-700">
          <div className="mx-auto max-w-6xl px-4 py-8">
            <p className="font-serif text-2xl font-black">
              광주전남<span className="text-brand">SI</span>뉴스
            </p>
            <dl className="mt-4 grid gap-x-8 gap-y-1 text-xs leading-relaxed sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="font-bold">제호</dt>
                <dd>광주전남SI뉴스</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">등록번호</dt>
                <dd>전남 아00000</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">발행인·편집인</dt>
                <dd>홍길동</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">청소년보호책임자</dt>
                <dd>김철수</dd>
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <dt className="font-bold">사업장 주소</dt>
                <dd>전라남도 목포시 영산로 000, 광주전남SI뉴스 본사</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">대표 전화</dt>
                <dd>061-000-0000</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">이메일</dt>
                <dd>news@gjjn-si.example</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">등록일</dt>
                <dd>2025. 01. 01.</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-bold">발행일</dt>
                <dd>2025. 01. 01.</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-gray-500">
              본지에 실린 모든 기사의 저작권은 광주전남SI뉴스에 있으며 무단 전재 및 재배포를 금합니다.
              AI가 작성한 기사에는 별도의 표기를 하며, 오보 신고 및 정정 요청은 위 연락처로 접수해 주십시오.
            </p>
            <p className="mt-2 text-xs text-gray-400">
              Copyright © 광주전남SI뉴스. All rights reserved.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

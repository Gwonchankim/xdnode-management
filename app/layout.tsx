import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./compensation-calculator.css";
import "./chat-workspace.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const ogImage = `${protocol}://${host}/og.png`;

  return {
    title: "XDnode management · 경영지원실",
    description: "경영지원실의 인사·임금 계산·감사 기록을 한곳에서 다루는 XDnode management",
    icons: {
      icon: [
        { url: "/brand/xdnode-favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/brand/xdnode-favicon-64.png", sizes: "64x64", type: "image/png" },
      ],
      shortcut: "/brand/xdnode-favicon-32.png",
      apple: "/brand/apple-touch-icon.png",
    },
    openGraph: {
      title: "XDnode management",
      description: "인사 · 임금 계산 · 감사 기록, 경영지원실의 한 흐름",
      images: [{ url: ogImage, width: 1731, height: 909, alt: "XDnode management" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "XDnode management",
      description: "인사 · 임금 계산 · 감사 기록, 경영지원실의 한 흐름",
      images: [ogImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

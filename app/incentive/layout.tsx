import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/incentive-og.png`;
  const description = "매출 데이터를 입력하거나 엑셀로 불러와 개인별 인센티브와 급여 반영액을 계산합니다.";
  return {
    title: "개인 인센티브 계산기 · XDnode management",
    description,
    openGraph: { title: "개인 인센티브 계산기", description, images: [{ url: image, width: 1731, height: 909, alt: "개인 인센티브 계산기" }] },
    twitter: { card: "summary_large_image", title: "개인 인센티브 계산기", description, images: [image] },
  };
}

export default function IncentiveLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

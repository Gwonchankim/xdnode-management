"use client";

// 단가 추이 그래프(quote-tool Design §10.2 '단가 이력', 옛 index.html priceChart·spark·bindChart). SVG 를 React 로만 그린다(HTML 문자열 주입 없음).
// 키보드: 그래프에 초점을 두고 ←/→ 로 점을 옮기면 십자선과 툴팁(날짜·단가·고객·수량)이 따라온다. Esc 는 툴팁을 닫는다.
// 축 눈금은 실제 최소·최대만 쓴다(그리기 여백은 눈금으로 쓰지 않는다). 값이 모두 같거나 점이 2개 미만이면 그리지 않는다.
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { HistRow } from "./quote-pricing";

const W = 680;
const H = 132;
const L = 56;
const R = 88;
const T = 10;
const B = 22;

type Point = { t: number; v: number; date: string; customer: string | null; qty: number | null };

const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
/** 억·만 단위 짧은 금액(옛 fmtK). */
export function shortWon(value: number | null | undefined) {
  const n = Math.round(value || 0);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(n % 1e8 ? 1 : 0)}억`;
  if (Math.abs(n) >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
  return n.toLocaleString("ko-KR");
}

function points(history: readonly HistRow[]): Point[] {
  return history
    .filter((row) => row.date && row.price)
    .map((row) => ({ t: Date.parse(String(row.date).slice(0, 10)), v: row.price as number, date: String(row.date), customer: row.customer, qty: row.qty }))
    .filter((point) => Number.isFinite(point.t))
    .sort((a, b) => a.t - b.t);
}

/** 제안 막대 안의 작은 추이 선(옛 spark). */
export function Sparkline({ history }: { history: readonly HistRow[] }) {
  const list = points(history);
  if (list.length < 2) return null;
  const width = 132;
  const height = 24;
  const pad = 3;
  const t0 = list[0].t;
  const span = list[list.length - 1].t - t0 || 1;
  const values = list.map((point) => point.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const range = hi - lo || 1;
  const x = (point: Point) => pad + ((point.t - t0) / span) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - lo) / range) * (height - pad * 2);
  const last = list[list.length - 1];
  return (
    <svg className="quote-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {lo === hi
        ? <line x1={pad} y1={12} x2={width - pad} y2={12} className="flat" />
        : <path d={list.map((point, index) => `${index ? "L" : "M"}${x(point).toFixed(1)} ${y(point.v).toFixed(1)}`).join(" ")} />}
      <circle cx={x(last).toFixed(1)} cy={(lo === hi ? 12 : y(last.v)).toFixed(1)} r={2.5} />
    </svg>
  );
}

/** 펼친 이력 패널의 추이 그래프. */
export default function QuotePriceChart({ history, label }: { history: readonly HistRow[]; label: string }) {
  const list = useMemo(() => points(history), [history]);
  const [active, setActive] = useState<number | null>(null);
  if (list.length < 2) return null;
  const values = list.map((point) => point.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return null;
  const innerW = W - L - R;
  const innerH = H - T - B;
  const t0 = list[0].t;
  const span = list[list.length - 1].t - t0 || 1;
  const pad = (hi - lo) * 0.12;
  const vmin = lo - pad;
  const vmax = hi + pad;
  const x = (point: Point) => L + ((point.t - t0) / span) * innerW;
  const y = (value: number) => T + innerH - ((value - vmin) / (vmax - vmin)) * innerH;
  const last = list[list.length - 1];
  const dateLabel = (date: string) => date.slice(2, 7).replace("-", ".");
  // 눈금 표기: 두 값이 서로 다르게 보이는 가장 짧은 형식.
  const axis = [shortWon, (value: number) => `${(value / 1e4).toFixed(1)}만`, (value: number) => Math.round(value).toLocaleString("ko-KR")]
    .find((format) => format(lo) !== format(hi)) ?? ((value: number) => Math.round(value).toLocaleString("ko-KR"));
  const current = active === null ? null : list[active];

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") { event.preventDefault(); setActive((index) => Math.max(0, (index ?? list.length) - 1)); }
    else if (event.key === "ArrowRight") { event.preventDefault(); setActive((index) => Math.min(list.length - 1, (index ?? list.length - 2) + 1)); }
    else if (event.key === "Escape") setActive(null);
  }
  function onMove(event: MouseEvent<SVGRectElement>) {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box) return;
    const sx = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    list.forEach((point, index) => { if (Math.abs(x(point) - sx) < Math.abs(x(list[best]) - sx)) best = index; });
    setActive(best);
  }

  return (
    <div className="quote-chart" tabIndex={0} role="slider" aria-label={`${label} 단가 추이 그래프. 좌우 화살표로 점을 옮깁니다.`}
      aria-valuemin={1} aria-valuemax={list.length} aria-valuenow={(active ?? list.length - 1) + 1}
      aria-valuetext={`${won((current ?? last).v)}, ${(current ?? last).date.slice(0, 10)}`}
      onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setActive(null)} aria-hidden="true">
        {[lo, hi].map((value) => (
          <g key={value}>
            <line x1={L} x2={W - R} y1={y(value).toFixed(1)} y2={y(value).toFixed(1)} className="grid" />
            <text x={L - 8} y={(y(value) + 3.5).toFixed(1)} textAnchor="end" className="axis">{axis(value)}</text>
          </g>
        ))}
        <path className="trend" d={list.map((point, index) => `${index ? "L" : "M"}${x(point).toFixed(1)} ${y(point.v).toFixed(1)}`).join(" ")} />
        {list.map((point, index) => <circle key={index} className="dot" cx={x(point).toFixed(1)} cy={y(point.v).toFixed(1)} r={3.2} />)}
        <circle className="last" cx={x(last).toFixed(1)} cy={y(last.v).toFixed(1)} r={4.4} />
        <text x={(x(last) + 10).toFixed(1)} y={(y(last.v) + 4).toFixed(1)} className="last-label">{won(last.v)}</text>
        <text x={L} y={H - 6} className="axis">{dateLabel(list[0].date)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="axis">{dateLabel(last.date)}</text>
        {current && (
          <>
            <line className="cross" x1={x(current)} x2={x(current)} y1={T} y2={T + innerH} />
            <circle className="cursor" cx={x(current)} cy={y(current.v)} r={5} />
          </>
        )}
        <rect className="hit" x={L} y={T} width={innerW} height={innerH} onMouseMove={onMove} />
      </svg>
      <p className="quote-chart-tip" aria-live="polite">
        {current ? `${won(current.v)} · ${current.date.slice(0, 10)}${current.customer ? ` · ${current.customer}` : ""}${current.qty ? ` · ${current.qty}개` : ""}` : " "}
      </p>
    </div>
  );
}

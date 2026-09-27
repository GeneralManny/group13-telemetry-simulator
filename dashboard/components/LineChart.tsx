"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clock } from "@/lib/format";

export interface Series {
  key: string;
  label: string;
  /** A CSS colour, normally a token such as var(--team-blue). */
  color: string;
  points: [number, number][];
}

interface Props {
  series: Series[];
  xMax: number;
  height: number;
  ariaLabel: string;
  yFormat?: (v: number) => string;
  /** Shaded reference range, named by a legend outside the chart. */
  band?: { lo: number; hi: number };
  annotations?: { x: number; y: number; label: string }[];
  emptyText?: string;
}

const M = { top: 10, bottom: 24, left: 44 };
const END_LABEL_WIDTH = 72;

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** Ticks that enclose the data, so a gridline always sits above the highest value. */
function yTicks(min: number, max: number, target = 4): number[] {
  if (max - min < 1e-9) return [min];
  const step = niceStep((max - min) / target);
  const out: number[] = [];
  const end = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step + 1e-9) * step; v <= end + 1e-9; v += step)
    out.push(+v.toFixed(6));
  return out;
}

function xTicks(xMax: number, maxTicks: number): number[] {
  const step = [15, 30, 60, 120, 300, 600, 900, 1800].find((s) => xMax / s <= maxTicks) ?? 3600;
  const out: number[] = [];
  for (let v = 0; v <= xMax + 1e-9; v += step) out.push(v);
  return out;
}

function nearestIndex(points: [number, number][], x: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1]![0] - x) < Math.abs(points[lo]![0] - x)) return lo - 1;
  return lo;
}

export function LineChart({
  series,
  xMax,
  height: baseHeight,
  ariaLabel,
  yFormat = (v) => String(v),
  band,
  annotations = [],
  emptyText = "No data yet",
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);
  // Tall charts shrink on narrow screens so a phone shows the chart and its context together.
  const height = Math.min(baseHeight, Math.max(120, Math.round(width * 0.8)));

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasData = series.some((s) => s.points.length > 0);
  const primary = series.reduce<Series | undefined>(
    (best, s) => (!best || s.points.length > best.points.length ? s : best),
    undefined,
  );

  const geo = useMemo(() => {
    const ys = series.flatMap((s) => s.points.map((p) => p[1]));
    if (band) ys.push(band.lo, band.hi);
    const lo = ys.length ? Math.min(...ys) : 0;
    const hi = ys.length ? Math.max(...ys) : 1;
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.04;
    const ticks = yTicks(lo - pad, hi + pad);
    const min = ticks[0] ?? lo;
    const max = ticks.at(-1) ?? hi;

    const endLabels = series.length > 0 && width > 420;
    const right = endLabels ? END_LABEL_WIDTH : 12;
    const plotW = width - M.left - right;
    const plotH = height - M.top - M.bottom;
    const x = (v: number) => M.left + (Math.min(v, xMax) / Math.max(1, xMax)) * plotW;
    const y = (v: number) => M.top + (1 - (v - min) / (max - min || 1)) * plotH;

    // End labels only when they cannot collide; otherwise the legend and tooltip carry identity.
    const ends = series
      .filter((s) => s.points.length)
      .map((s) => ({ s, p: s.points.at(-1)! }))
      .map(({ s, p }) => ({ s, px: x(p[0]), py: y(p[1]), value: p[1] }));
    const collide = ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.py - b.py) < 14));

    return { ticks, x, y, plotW, plotH, right, ends, showEndLabels: endLabels && !collide };
  }, [series, band, width, height, xMax]);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    if (!primary?.points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const dataX = Math.max(0, Math.min(xMax, frac * xMax));
    const idx = nearestIndex(primary.points, dataX);
    setHoverX(primary.points[idx]![0]);
  };

  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    if (!primary?.points.length) return;
    const pts = primary.points;
    const current = hoverX === null ? pts.length - 1 : nearestIndex(pts, hoverX);
    if (e.key === "ArrowLeft") setHoverX(pts[Math.max(0, current - 1)]![0]);
    else if (e.key === "ArrowRight") setHoverX(pts[Math.min(pts.length - 1, current + 1)]![0]);
    else if (e.key === "Escape") setHoverX(null);
    else return;
    e.preventDefault();
  };

  const tooltip =
    hoverX === null
      ? null
      : {
          px: geo.x(hoverX),
          rows: series
            .filter((s) => s.points.length)
            .map((s) => ({ s, p: s.points[nearestIndex(s.points, hoverX)]! })),
        };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      {series.length >= 2 && (
        <ul className="legend" aria-label="Legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="legend-line" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="chart-svg">
        {band && (
          <g>
            <rect
              x={M.left}
              width={geo.plotW}
              y={geo.y(band.hi)}
              height={Math.max(0, geo.y(band.lo) - geo.y(band.hi))}
              className="chart-band"
            />
          </g>
        )}
        {geo.ticks.map((t) => (
          <g key={`y${t}`}>
            <line
              x1={M.left}
              x2={M.left + geo.plotW}
              y1={geo.y(t)}
              y2={geo.y(t)}
              className="chart-gridline"
            />
            <text
              x={M.left - 6}
              y={geo.y(t)}
              className="chart-tick"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {yFormat(t)}
            </text>
          </g>
        ))}
        <line
          x1={M.left}
          x2={M.left + geo.plotW}
          y1={M.top + geo.plotH}
          y2={M.top + geo.plotH}
          className="chart-axis"
        />
        {xTicks(xMax, width < 420 ? 4 : 6).map((t) => (
          <text
            key={`x${t}`}
            x={geo.x(t)}
            y={height - 6}
            className="chart-tick"
            textAnchor="middle"
          >
            {clock(t)}
          </text>
        ))}

        {series.map((s) =>
          s.points.length > 1 ? (
            <path
              key={s.key}
              d={s.points
                .map(
                  (p, i) => `${i ? "L" : "M"}${geo.x(p[0]).toFixed(1)},${geo.y(p[1]).toFixed(1)}`,
                )
                .join("")}
              className="chart-line"
              style={{ stroke: s.color }}
            />
          ) : null,
        )}

        {annotations.map((a, i) => (
          <g key={`a${i}`}>
            <circle cx={geo.x(a.x)} cy={geo.y(a.y)} r={5} className="chart-annotation" />
            <text
              x={geo.x(a.x)}
              y={geo.y(a.y) - 10}
              className="chart-annotation-label"
              textAnchor="middle"
            >
              {a.label}
            </text>
          </g>
        ))}

        {geo.ends.map(({ s, px, py, value }) => (
          <g key={`end${s.key}`}>
            <circle cx={px} cy={py} r={4} className="chart-dot" style={{ fill: s.color }} />
            {geo.showEndLabels && (
              <text x={px + 9} y={py} className="chart-end-label" dominantBaseline="middle">
                {yFormat(value)}
              </text>
            )}
          </g>
        ))}

        {tooltip && (
          <line
            x1={tooltip.px}
            x2={tooltip.px}
            y1={M.top}
            y2={M.top + geo.plotH}
            className="chart-crosshair"
          />
        )}
        {tooltip?.rows.map(({ s, p }) => (
          <circle
            key={`h${s.key}`}
            cx={geo.x(p[0])}
            cy={geo.y(p[1])}
            r={4}
            className="chart-dot"
            style={{ fill: s.color }}
          />
        ))}

        {!hasData && (
          <text x={width / 2} y={height / 2} className="chart-empty" textAnchor="middle">
            {emptyText}
          </text>
        )}

        <rect
          x={M.left}
          y={M.top}
          width={Math.max(0, geo.plotW)}
          height={geo.plotH}
          fill="transparent"
          tabIndex={hasData ? 0 : -1}
          aria-label={`${ariaLabel}. Use the arrow keys to read values.`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverX(null)}
          onFocus={() => primary?.points.length && setHoverX(primary.points.at(-1)![0])}
          onBlur={() => setHoverX(null)}
          onKeyDown={onKey}
          className="chart-hit"
        />
      </svg>

      {tooltip && (
        <div
          className="chart-tooltip"
          role="status"
          style={{
            left: tooltip.px > width - 170 ? undefined : tooltip.px + 12,
            right: tooltip.px > width - 170 ? width - tooltip.px + 12 : undefined,
          }}
        >
          <div className="chart-tooltip-head">{clock(tooltip.rows[0]?.p[0] ?? 0)}</div>
          {tooltip.rows.map(({ s, p }) => (
            <div key={s.key} className="chart-tooltip-row">
              <span className="legend-line" style={{ background: s.color }} aria-hidden="true" />
              <strong>{yFormat(p[1])}</strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

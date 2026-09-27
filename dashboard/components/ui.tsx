"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Icons (inline, stroke-based, inherit currentColor)

const paths = {
  check: "M4 10.5l4 4 8-9",
  warning: "M10 3l8 14H2L10 3zM10 8v4M10 14.5v.5",
  critical: "M10 2a8 8 0 100 16 8 8 0 000-16zM7 7l6 6M13 7l-6 6",
  info: "M10 2a8 8 0 100 16 8 8 0 000-16zM10 9v5M10 6v.5",
  lock: "M5 9h10v8H5zM7 9V6a3 3 0 016 0v3",
  unlock: "M5 9h10v8H5zM7 9V6a3 3 0 015.5-1.6",
  sun: "M10 6a4 4 0 100 8 4 4 0 000-8zM10 1v2M10 17v2M1 10h2M17 10h2M3.6 3.6L5 5M15 15l1.4 1.4M3.6 16.4L5 15M15 5l1.4-1.4",
  moon: "M16 12.5A7 7 0 017.5 4a7 7 0 108.5 8.5z",
  copy: "M7 7h9v9H7zM4 13V4h9",
};

export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="icon">
      <path
        d={paths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type Tone = "good" | "warning" | "critical" | "neutral";

const toneIcon: Record<Tone, keyof typeof paths> = {
  good: "check",
  warning: "warning",
  critical: "critical",
  neutral: "info",
};

/** Status is always icon + label, never colour alone. */
export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="status-chip" data-tone={tone}>
      <Icon name={toneIcon[tone]} size={14} />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toasts

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const notify = useCallback((text: string, tone: Tone = "neutral") => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      tone === "critical" ? 8000 : 4500,
    );
  }, []);
  return { toasts, notify };
}

export type Notify = (text: string, tone?: Tone) => void;

export function ToastRegion({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          <Icon name={toneIcon[t.tone]} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Polling

/** Calls `fn` now and every `ms` while the tab is visible. */
export function usePoll(
  fn: () => Promise<void> | void,
  ms: number,
  deps: unknown[],
  enabled = true,
) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const tick = () => {
      if (!stopped && !document.hidden) void saved.current();
    };
    tick();
    const id = setInterval(tick, ms);
    const onVisible = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled, ...deps]);
}

// ---------------------------------------------------------------------------
// Copy button

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard can be blocked; the text is still selectable.
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
      {done ? "Copied" : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons. Shown only until the first response arrives; later refreshes keep the
// previous content on screen so nothing flickers.

export function Skeleton({
  width = "100%",
  height = 14,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />
  );
}

/** Wraps placeholder content so assistive tech announces loading once instead of reading shapes. */
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="loading" aria-busy="true">
      <span className="visually-hidden" role="status">
        {label}
      </span>
      {children}
    </div>
  );
}

export function ChartSkeleton({
  height,
  label = "Loading chart",
}: {
  height: number;
  label?: string;
}) {
  return (
    <Loading label={label}>
      <div className="chart-skeleton" style={{ height }} aria-hidden="true">
        <div className="chart-skeleton-axis">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width={26} height={8} />
          ))}
        </div>
        <div className="chart-skeleton-plot">
          <span className="skeleton-sheen" />
        </div>
      </div>
    </Loading>
  );
}

export function TableSkeleton({
  rows,
  columns,
  label,
}: {
  rows: number;
  columns: number;
  label: string;
}) {
  return (
    <Loading label={label}>
      <div className="table-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, r) => (
          <div
            className="table-skeleton-row"
            key={r}
            style={{ gridTemplateColumns: `2fr repeat(${columns - 1}, 1fr)` }}
          >
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton
                key={c}
                width={c === 0 ? "70%" : `${45 + ((r * 7 + c * 13) % 40)}%`}
                height={12}
              />
            ))}
          </div>
        ))}
      </div>
    </Loading>
  );
}

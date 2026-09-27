export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en");

export function count(n: number): string {
  return n >= 10_000 ? compact.format(n) : plain.format(n);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const diff = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (diff < 5) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "None";
  return s.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  completed: "Completed",
  failed: "Failed",
};

export const HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "No deliveries yet",
  disabled: "No webhook",
};

export function healthTone(h: string): "good" | "warning" | "critical" | "neutral" {
  if (h === "healthy") return "good";
  if (h === "degraded") return "warning";
  if (h === "failing") return "critical";
  return "neutral";
}

export function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

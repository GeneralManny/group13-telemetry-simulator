const KEY_STORAGE = "g13_access_key";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** The access key lives in sessionStorage: it is gone when the tab closes. */
export function loadKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function saveKey(key: string | null): void {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage can be blocked (private mode). The key then lasts until reload.
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; key?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.key) headers["x-api-key"] = opts.key;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "The simulator is not reachable.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const issues = Array.isArray(data.issues) ? (data.issues as ApiError["issues"]) : [];
    const detail = issues.length
      ? `: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`
      : "";
    throw new ApiError(
      res.status,
      String(data.error ?? "error"),
      `${String(data.message ?? `Request failed (${res.status})`)}${detail}`,
      issues,
    );
  }
  return data as T;
}

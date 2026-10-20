/* Backend client. Same-origin /api (Vite proxies to Flask in dev; the backend
   serves it in prod/Docker). Every call is best-effort: when the backend is
   unreachable the app falls back to localStorage so the UI works standalone. */

let cached: boolean | null = null;
let cachedAt = 0;
/** How long a negative probe is trusted before re-checking the backend. */
const NEGATIVE_TTL_MS = 10_000;
/** Hard ceiling so a stalled request can never hang the UI forever. */
const REQUEST_TIMEOUT_MS = 300_000;

export async function backendAvailable(): Promise<boolean> {
  if (cached === true) return true;
  if (cached === false && Date.now() - cachedAt < NEGATIVE_TTL_MS) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('/api/health', { signal: ctl.signal });
    clearTimeout(t);
    cached = res.ok;
  } catch {
    cached = false;
  }
  cachedAt = Date.now();
  return cached;
}

export function resetBackendProbe(): void {
  cached = null;
  cachedAt = 0;
}

function timeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout is Chrome 103+. Keep a fallback so an older browser
  // degrades to a controller instead of throwing on every API call.
  const timeout = (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }).timeout;
  if (typeof timeout === 'function') return timeout(ms);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  if (!(await backendAvailable())) throw new Error('backend unreachable');
  const signal = init?.signal ?? timeoutSignal(REQUEST_TIMEOUT_MS);
  return fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
    signal,
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await call(path);
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const res = await call(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) {
    let detail = `backend ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error || j?.message) detail = j.error ?? j.message;
    } catch {
      /* keep status */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await call(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    let detail = `backend ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) detail = j.error;
    } catch {
      /* keep status */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  if (!(await backendAvailable())) throw new Error('backend unreachable');
  const res = await fetch(`/api${path}`, {
    method: 'DELETE',
    credentials: 'include',
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return res.json() as Promise<T>;
}

/** Mirror local credentials into the backend (creates the same User row + cookie). */
export async function mirrorAuth(
  kind: 'bootstrap' | 'login',
  creds: { username: string; displayName?: string; password: string; theme?: string },
): Promise<void> {
  await apiPost(`/auth/${kind}`, creds);
}

export async function backendLogout(): Promise<void> {
  try {
    await apiPost('/auth/logout', {});
  } catch {
    /* already out or unreachable */
  }
}

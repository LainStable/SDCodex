/* Backend client. Same-origin /api (Vite proxies to Flask in dev; the backend
   serves it in prod/Docker). Every call is best-effort: when the backend is
   unreachable the app falls back to localStorage so the UI works standalone. */

let cached: boolean | null = null;

export async function backendAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('/api/health', { signal: ctl.signal });
    clearTimeout(t);
    cached = res.ok;
  } catch {
    cached = false;
  }
  return cached;
}

export function resetBackendProbe(): void {
  cached = null;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  if (!(await backendAvailable())) throw new Error('backend unreachable');
  return fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await call(path);
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {  const res = await call(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
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
  const res = await fetch(`/api${path}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return res.json() as Promise<T>;
}

/** Mirror local credentials into the backend (creates the same User row + cookie). */
export async function mirrorAuth(
  kind: 'bootstrap' | 'login',
  creds: { username: string; displayName?: string; password: string },
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

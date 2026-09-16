/* Frontend auth store. Shapes mirror OldCode models.User / OidcConfig so the
   backend can adopt these rows as-is. No passwords are stored here — local
   accounts get a real password hash only once the backend lands. */

export interface Profile {
  username: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  authProvider: string; // 'local' or 'oidc:<name>'
  /** PBKDF2-SHA256 hash: `pbkdf2$<iter>$<salt-b64>$<hash-b64>`. Empty for OIDC-only rows. */
  passwordHash: string;
  /** Avatar data-URL (128px JPEG). Mirrors OldCode User.avatar. */
  avatar: string;
  createdAt: number;
}

/** Mirrors OldCode OidcConfig columns (subset shown in UI, rest defaulted). */
export interface OidcProvider {
  id: string;
  name: string;
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Must exactly match the URI registered at the provider. */
  redirectUri: string;
  scopes: string;
  usernameClaim: string;
  emailClaim: string;
  displayNameClaim: string;
  adminClaim: string;
  adminValue: string;
}

const PROFILE_KEY = 'sdcodex.profile.v1';
const OIDC_KEY = 'sdcodex.oidc.v1';
const SESSION_KEY = 'sdcodex.session.v1';
const PBKDF2_ITER = 210_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadProfile(): Profile | null {
  try {
    const raw = read(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Profile;
    // Migrate older rows.
    if (typeof p.avatar !== 'string') p.avatar = '';
    if (typeof p.email !== 'string') p.email = '';
    return p;
  } catch {
    return null;
  }
}

/** Downscale an uploaded image to a 128px JPEG data-URL (keeps localStorage small). */
export function processAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        const side = Math.min(img.width, img.height);
        ctx.drawImage(
          img,
          (img.width - side) / 2,
          (img.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size,
        );
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

/** Bootstrap: first-ever user is admin (mirrors OldCode bootstrap mode). */
export async function bootstrapUser(
  username: string,
  displayName: string,
  password: string,
): Promise<Profile> {
  let first = true;
  try {
    first = localStorage.getItem('sdcodex.bootstrapped.v1') !== '1';
    localStorage.setItem('sdcodex.bootstrapped.v1', '1');
  } catch {
    first = true;
  }
  const p: Profile = {
    username: username.trim(),
    displayName: displayName.trim() || username.trim(),
    email: '',
    isAdmin: first,
    authProvider: 'local',
    passwordHash: await hashPassword(password),
    avatar: '',
    createdAt: Date.now(),
  };
  saveProfile(p);
  startSession();
  return p;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PBKDF2-SHA256 password hash (browser-side stand-in for OldCode scrypt). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(new Uint8Array(bits as ArrayBuffer))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [, iterStr, saltB64, hashB64] = stored.split('$');
    const salt = unb64(saltB64);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: Number(iterStr), hash: 'SHA-256' },
      key,
      256,
    );
    return b64(new Uint8Array(bits as ArrayBuffer)) === hashB64;
  } catch {
    return false;
  }
}

/** Session flag. Frontend gate only — the backend httpOnly cookie enforces for real. */
export function hasSession(): boolean {
  return read(SESSION_KEY) !== null;
}

export interface ServerAuthState {
  authed: boolean;
  bootstrap: boolean;
  user: {
    username: string;
    displayName: string;
    email: string;
    isAdmin: boolean;
    authProvider: string;
  } | null;
}

/** Ask the backend who (if anyone) is signed in. Null when unreachable. */
export async function fetchServerAuth(): Promise<ServerAuthState | null> {
  try {
    const { apiGet, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) return null;
    return await apiGet<ServerAuthState>('/auth/status');
  } catch {
    return null;
  }
}

/** Adopt a backend user row as the local profile. Never clobbers local-only
    state (password hash, avatar) or filled-in fields with server empties. */
export function adoptServerUser(u: ServerAuthState['user']): Profile | null {
  if (!u) return null;
  const existing = loadProfile();
  const sameUser = existing && existing.username === u.username;
  const p: Profile = {
    username: u.username,
    displayName: u.displayName || existing?.displayName || u.username,
    email: u.email || (sameUser ? (existing?.email ?? '') : ''),
    isAdmin: u.isAdmin,
    authProvider: u.authProvider || 'local',
    passwordHash: sameUser ? (existing?.passwordHash ?? '') : '',
    avatar: sameUser ? (existing?.avatar ?? '') : '',
    createdAt: existing?.createdAt ?? Date.now(),
  };
  saveProfile(p);
  return p;
}

export interface ServerProfile extends NonNullable<ServerAuthState['user']> {
  avatarData?: string;
}

/** Pull the full server profile (incl. avatar data) and merge over local. */
export async function pullServerProfile(): Promise<Profile | null> {
  try {
    const { apiGet, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) return null;
    const u = await apiGet<ServerProfile>('/profile');
    const existing = loadProfile();
    const sameUser = existing && existing.username === u.username;
    const p: Profile = {
      username: u.username,
      displayName: u.displayName || existing?.displayName || u.username,
      email: u.email || (sameUser ? (existing?.email ?? '') : ''),
      isAdmin: u.isAdmin,
      authProvider: u.authProvider || 'local',
      passwordHash: sameUser ? (existing?.passwordHash ?? '') : '',
      // Server avatar wins when set (edits push there); else keep local.
      avatar: u.avatarData || (sameUser ? (existing?.avatar ?? '') : ''),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    saveProfile(p);
    return p;
  } catch {
    return null;
  }
}

/** Push local profile edits to the server (best-effort). */
export async function pushProfile(p: Profile): Promise<void> {
  try {
    const { apiPost, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) return;
    await apiPost('/profile', {
      displayName: p.displayName,
      email: p.email,
      avatar: p.avatar,
    });
  } catch {
    /* standalone — local stands */
  }
}

export function startSession(): void {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch {
    /* ignore */
  }
}

/** End the session. The account stays — next launch asks for its password. */
export function endSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Full reset (account + session). Used only when explicitly wiping. */
export function wipeAccount(): void {
  clearProfile();
  endSession();
}

export function initials(p: Profile | null): string {
  if (!p) return '?';
  const src = p.displayName || p.username;
  const parts = src.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export function loadProviders(): OidcProvider[] {
  try {
    const raw = read(OIDC_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persistProviders(list: OidcProvider[]): void {
  try {
    localStorage.setItem(OIDC_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function blankProvider(): OidcProvider {
  const fallback =
    typeof window !== 'undefined' ? `${window.location.origin}/auth/oidc/callback` : '';
  return {
    id: `oidc-${Date.now()}`,
    name: '',
    enabled: true,
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
    redirectUri: fallback,
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
    emailClaim: 'email',
    displayNameClaim: 'name',
    adminClaim: '',
    adminValue: '',
  };
}

export function saveProvider(p: OidcProvider): OidcProvider[] {
  const list = loadProviders();
  const i = list.findIndex((x) => x.id === p.id);
  const next = i >= 0 ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
  persistProviders(next);
  return next;
}

export function deleteProvider(id: string): OidcProvider[] {
  const next = loadProviders().filter((x) => x.id !== id);
  persistProviders(next);
  return next;
}

/** Real check: fetch the provider's OIDC discovery document. */
export async function testDiscovery(issuerUrl: string, signal?: AbortSignal): Promise<string> {
  const base = issuerUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Issuer URL is empty');
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Discovery ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint) throw new Error('No authorization_endpoint in discovery doc');
  return `OK · ${doc.issuer ?? base}`;
}

/** Server OIDC rows (admin). The exchange must run server-side (client secret
    + PKCE verifier live there), so these hit /api directly. */
export async function fetchServerProviders(): Promise<OidcProvider[]> {
  const { apiGet } = await import('./backend');
  const res = await apiGet<{ items: Array<Record<string, unknown>> }>('/oidc');
  return res.items.map((c) => ({
    id: String(c.id),
    name: String(c.name ?? ''),
    enabled: Boolean(c.enabled),
    issuerUrl: String(c.issuerUrl ?? ''),
    clientId: String(c.clientId ?? ''),
    clientSecret: '',
    redirectUri: String(c.redirectUri ?? ''),
    scopes: String(c.scopes ?? 'openid profile email'),
    usernameClaim: String(c.usernameClaim ?? 'preferred_username'),
    emailClaim: String(c.emailClaim ?? 'email'),
    displayNameClaim: String(c.displayNameClaim ?? 'name'),
    adminClaim: String(c.adminClaim ?? ''),
    adminValue: String(c.adminValue ?? ''),
  }));
}

export async function createServerProvider(p: OidcProvider): Promise<void> {
  const { apiPost } = await import('./backend');
  await apiPost('/oidc', {
    name: p.name,
    enabled: p.enabled,
    issuerUrl: p.issuerUrl,
    clientId: p.clientId,
    clientSecret: p.clientSecret || undefined,
    redirectUri: p.redirectUri,
    scopes: p.scopes,
    usernameClaim: p.usernameClaim,
    emailClaim: p.emailClaim,
    displayNameClaim: p.displayNameClaim,
    adminClaim: p.adminClaim || undefined,
    adminValue: p.adminValue || undefined,
  });
}

export async function deleteServerProvider(id: string): Promise<void> {
  const { apiDelete } = await import('./backend');
  await apiDelete(`/oidc/${id}`);
}

export async function testServerProvider(id: string): Promise<string> {
  const { apiPost } = await import('./backend');
  const r = await apiPost<{ ok: boolean; result?: { success: boolean; issuer?: string; error?: string }; error?: string }>(
    `/oidc/${id}/test`,
    {},
  );
  if (r.result?.success) return `OK · ${r.result.issuer ?? 'discovery passed'}`;
  throw new Error(r.result?.error || r.error || 'test failed');
}

/** Start SSO: backend builds the provider URL (verifier stays server-side). */
export async function serverLoginUrl(id: string): Promise<string> {
  const { apiGet } = await import('./backend');
  const r = await apiGet<{ ok: boolean; url?: string; error?: string }>(`/oidc/${id}/login-url`);
  if (!r.url) throw new Error(r.error || 'no login URL');
  return r.url;
}

/** Complete SSO after the provider redirects to /auth/oidc/callback. */
export async function completeOidcCallback(code: string, state: string): Promise<Profile> {
  const { apiPost } = await import('./backend');
  const r = await apiPost<{ ok: boolean; user: ServerAuthState['user']; error?: string }>(
    '/auth/oidc/callback',
    { code, state },
  );
  const adopted = adoptServerUser(r.user);
  if (!adopted) throw new Error(r.error || 'sign-in failed');
  startSession();
  return adopted;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}


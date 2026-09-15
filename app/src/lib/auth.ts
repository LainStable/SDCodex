/* Frontend auth store. Shapes mirror OldCode models.User / OidcConfig so the
   backend can adopt these rows as-is. No passwords are stored here — local
   accounts get a real password hash only once the backend lands. */

export interface Profile {
  username: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  authProvider: string; // 'local' or 'oidc:<name>'
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
  scopes: string;
  usernameClaim: string;
  emailClaim: string;
  displayNameClaim: string;
  adminClaim: string;
  adminValue: string;
}

const PROFILE_KEY = 'sdcodex.profile.v1';
const OIDC_KEY = 'sdcodex.oidc.v1';

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
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
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
export function bootstrapUser(username: string, displayName: string): Profile {
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
    createdAt: Date.now(),
  };
  saveProfile(p);
  return p;
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
  return {
    id: `oidc-${Date.now()}`,
    name: '',
    enabled: true,
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
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

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a PKCE sign-in URL (mirrors OldCode oidc.build_authorization_url). */
export async function buildAuthUrl(p: OidcProvider, redirectUri: string): Promise<string> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(verifierBytes);
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = b64url(challengeBytes);
  const stateBytes = crypto.getRandomValues(new Uint8Array(16));
  try {
    sessionStorage.setItem(`sdcodex.pkce.${b64url(stateBytes)}`, verifier);
  } catch {
    /* ignore */
  }
  const base = p.issuerUrl.trim().replace(/\/+$/, '');
  const doc = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri,
    scope: p.scopes || 'openid profile email',
    state: b64url(stateBytes),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${doc.authorization_endpoint}?${params}`;
}

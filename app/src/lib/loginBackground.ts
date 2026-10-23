/**
 * Optional image behind the sign-in gate. Stored as a downscaled data URL in
 * localStorage so it works on a fresh origin/password reset, before any
 * account (and therefore profile/theme row) exists.
 */

const LOGIN_BG_KEY = 'sdcodex.login.background.v1';

/** Fired when the image is uploaded, replaced, or removed. */
export const LOGIN_BG_EVENT = 'sdcodex:login-background-changed';

export type LoginBackground = {
  /** `data:image/jpeg;base64,…` */
  dataUrl: string;
  name: string;
  width: number;
  height: number;
  updated: number;
  /** 0–1; how strongly the image shows through the login backdrop. */
  opacity: number;
};

export const DEFAULT_LOGIN_BG_OPACITY = 1;

/** Clamp a stored/edited opacity to 0–1 (older rows default to fully opaque). */
export function loginBackgroundOpacity(background: LoginBackground): number {
  const value = Number(background.opacity);
  if (!Number.isFinite(value)) return DEFAULT_LOGIN_BG_OPACITY;
  return Math.min(1, Math.max(0, value));
}

/** Longest edge kept; larger uploads are scaled down before being stored. */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const JPEG_QUALITY = 0.85;

export function loadLoginBackground(): LoginBackground | null {
  try {
    const raw = localStorage.getItem(LOGIN_BG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LoginBackground> | null;
    if (!parsed || typeof parsed.dataUrl !== 'string' || !parsed.dataUrl.startsWith('data:image/')) {
      return null;
    }
    return {
      dataUrl: parsed.dataUrl,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : 'login-background.jpg',
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      updated: Number(parsed.updated) || 0,
      opacity: Number.isFinite(Number(parsed.opacity)) ? Math.min(1, Math.max(0, Number(parsed.opacity))) : DEFAULT_LOGIN_BG_OPACITY,
    };
  } catch {
    return null;
  }
}

export function saveLoginBackground(background: LoginBackground): void {
  const normalized: LoginBackground = {
    ...background,
    opacity: Math.min(1, Math.max(0, Number(background.opacity) || 0)),
  };
  try {
    localStorage.setItem(LOGIN_BG_KEY, JSON.stringify(normalized));
  } catch {
    throw new Error('That image is too large to store in this browser. Try a smaller file.');
  }
  window.dispatchEvent(new Event(LOGIN_BG_EVENT));
}

export function clearLoginBackground(): void {
  try {
    localStorage.removeItem(LOGIN_BG_KEY);
  } catch {
    /* nothing stored */
  }
  window.dispatchEvent(new Event(LOGIN_BG_EVENT));
}

/** Approximate stored size in bytes (data URL overhead included). */
export function loginBackgroundBytes(background: LoginBackground): number {
  return background.dataUrl.length;
}

function decodeImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  return img
    .decode()
    .then(() => img)
    .finally(() => URL.revokeObjectURL(url));
}

/**
 * Decode an uploaded file, scale it to the backdrop budget and re-encode as
 * JPEG. Keeps localStorage well under its ~5 MB quota even for 4K sources.
 */
export async function prepareLoginBackground(file: File): Promise<LoginBackground> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Pick an image file (PNG, JPEG, WebP…).');
  }
  if (file.size > 30 * 1024 * 1024) {
    throw new Error('That image is over 30 MB. Choose a smaller file.');
  }
  const img = await decodeImage(file).catch(() => {
    throw new Error('That image could not be read.');
  });
  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('That image could not be read.');
  }
  const scale = Math.min(1, MAX_WIDTH / naturalWidth, MAX_HEIGHT / naturalHeight);
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process images.');
  // Flatten transparency onto the app background so the JPEG stays dark.
  ctx.fillStyle = '#0f131c';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
    name: file.name || 'login-background.jpg',
    width,
    height,
    updated: Date.now(),
    opacity: DEFAULT_LOGIN_BG_OPACITY,
  };
}

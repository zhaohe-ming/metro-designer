export const TOKEN_KEY = 'metro_token';
export const SESSION_META_KEY = 'metro_auth_session';
// 7 天内活跃免登录：每次进入应用或发起有效鉴权请求时自动顺延 7 天；超过 7 天未打开则需重新登录
export const AUTH_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_TOUCH_THROTTLE_MS = 60 * 1000;

export interface CachedAuthUser {
  id: string;
  phone: string;
  email: string;
  emailVerified: boolean;
  username: string;
  avatar?: string;
}

interface StoredAuthSession {
  version: 1;
  loginAt: number;
  lastActiveAt: number;
  user: CachedAuthUser | null;
}

export interface BootstrappedAuthSession {
  status: 'none' | 'expired' | 'verifying' | 'active';
  token: string | null;
  user: CachedAuthUser | null;
}

interface JwtPayloadInfo {
  userId?: string;
  purpose?: string;
  iat?: number;
  exp?: number;
}

let lastActivityTouchAt = 0;

function decodeBase64Url(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLen);
    if (typeof atob === 'function') {
      const binary = atob(padded);
      if (typeof TextDecoder === 'function') {
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
      }
      return binary;
    }
    return null;
  } catch {
    return null;
  }
}

function inspectToken(token: string): { isJwt: boolean; validFormat: boolean; payload: JwtPayloadInfo | null } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { isJwt: false, validFormat: true, payload: null };
  }
  const json = decodeBase64Url(parts[1]);
  if (!json) {
    return { isJwt: true, validFormat: false, payload: null };
  }
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') {
      return { isJwt: true, validFormat: false, payload: null };
    }
    return { isJwt: true, validFormat: true, payload: parsed as JwtPayloadInfo };
  } catch {
    return { isJwt: true, validFormat: false, payload: null };
  }
}

function sanitizeCachedUser(raw: any): CachedAuthUser | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
    return null;
  }
  return {
    id: raw.id,
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    emailVerified: Boolean(raw.emailVerified),
    username: typeof raw.username === 'string' ? raw.username : '',
    ...(typeof raw.avatar === 'string' && raw.avatar ? { avatar: raw.avatar } : {})
  };
}

function readStoredSession(): StoredAuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.lastActiveAt !== 'number') {
      return null;
    }
    return {
      version: 1,
      loginAt: typeof parsed.loginAt === 'number' ? parsed.loginAt : parsed.lastActiveAt,
      lastActiveAt: parsed.lastActiveAt,
      user: sanitizeCachedUser(parsed.user)
    };
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredAuthSession): void {
  try {
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(session));
  } catch {
    // 若头像 dataURL 触发极小配额限制，剥离头像重试写入，保证免登录会话元数据不丢失
    if (session.user?.avatar) {
      try {
        const slim: StoredAuthSession = {
          ...session,
          user: { ...session.user, avatar: undefined }
        };
        localStorage.setItem(SESSION_META_KEY, JSON.stringify(slim));
      } catch {
        /* ignore storage failure */
      }
    }
  }
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearAuthSession(): void {
  lastActivityTouchAt = 0;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_META_KEY);
  } catch {
    /* ignore */
  }
}

export function saveAuthSession(token: string, user: CachedAuthUser, now = Date.now()): void {
  setStoredToken(token);
  const prev = readStoredSession();
  const sameUser = prev?.user?.id === user.id;
  lastActivityTouchAt = now;
  writeStoredSession({
    version: 1,
    loginAt: sameUser ? prev!.loginAt : now,
    lastActiveAt: now,
    user: sanitizeCachedUser(user)
  });
}

export function touchAuthSessionUser(user: CachedAuthUser, refreshedToken?: string, now = Date.now()): void {
  if (refreshedToken) {
    setStoredToken(refreshedToken);
  }
  const prev = readStoredSession();
  lastActivityTouchAt = now;
  writeStoredSession({
    version: 1,
    loginAt: prev?.loginAt ?? now,
    lastActiveAt: now,
    user: sanitizeCachedUser(user)
  });
}

export function touchAuthActivity(now = Date.now()): void {
  if (now - lastActivityTouchAt < ACTIVITY_TOUCH_THROTTLE_MS) return;
  const token = getStoredToken();
  if (!token) return;
  const prev = readStoredSession();
  if (!prev || now - prev.lastActiveAt > AUTH_IDLE_TTL_MS) return;
  lastActivityTouchAt = now;
  writeStoredSession({
    ...prev,
    lastActiveAt: now
  });
}

/**
 * 首屏同步检查并续期本地登录会话：
 * - 无 token -> 'none'
 * - JWT 已过期 / 超过 7 天未活跃 -> 自动清理本地凭证并返回 'expired'
 * - 7 天内活跃且有缓存用户 -> 自动顺延 lastActiveAt 至当前时间并返回 'active'（首帧零闪烁进工作台）
 * - 7 天内活跃但仅有旧版遗留 token（尚无本地用户快照）-> 返回 'verifying'（首帧同样跳过登录页，等 /api/me 补齐快照）
 */
export function bootstrapAuthSession(now = Date.now()): BootstrappedAuthSession {
  const token = getStoredToken();
  if (!token) {
    try {
      localStorage.removeItem(SESSION_META_KEY);
    } catch {
      /* ignore */
    }
    return { status: 'none', token: null, user: null };
  }

  const inspected = inspectToken(token);
  if (inspected.isJwt) {
    if (!inspected.validFormat) {
      clearAuthSession();
      return { status: 'expired', token: null, user: null };
    }
    const payload = inspected.payload;
    if (payload?.purpose && payload.purpose !== 'login') {
      clearAuthSession();
      return { status: 'expired', token: null, user: null };
    }
    if (typeof payload?.exp === 'number' && payload.exp * 1000 <= now) {
      clearAuthSession();
      return { status: 'expired', token: null, user: null };
    }
  }

  const session = readStoredSession();
  if (session) {
    if (now - session.lastActiveAt > AUTH_IDLE_TTL_MS) {
      clearAuthSession();
      return { status: 'expired', token: null, user: null };
    }
    const tokenUserId = inspected.payload?.userId;
    const validUser =
      session.user && (!tokenUserId || tokenUserId === session.user.id)
        ? session.user
        : null;
    lastActivityTouchAt = now;
    writeStoredSession({
      version: 1,
      loginAt: session.loginAt,
      lastActiveAt: now,
      user: validUser
    });
    return {
      status: validUser ? 'active' : 'verifying',
      token,
      user: validUser
    };
  }

  // 兼容升级前只存了 metro_token 的已登录老会话：若签发时间已超 7 天则失效，否则平滑过渡并顺延
  const issuedAtMs = typeof inspected.payload?.iat === 'number' ? inspected.payload.iat * 1000 : null;
  if (issuedAtMs !== null && now - issuedAtMs > AUTH_IDLE_TTL_MS) {
    clearAuthSession();
    return { status: 'expired', token: null, user: null };
  }

  lastActivityTouchAt = now;
  writeStoredSession({
    version: 1,
    loginAt: issuedAtMs ?? now,
    lastActiveAt: now,
    user: null
  });
  return { status: 'verifying', token, user: null };
}

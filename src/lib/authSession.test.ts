import {
  AUTH_IDLE_TTL_MS,
  SESSION_META_KEY,
  TOKEN_KEY,
  bootstrapAuthSession,
  clearAuthSession,
  saveAuthSession,
  touchAuthActivity,
  touchAuthSessionUser
} from './authSession';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const sampleUser = {
  id: 'u_100',
  phone: '',
  email: 'designer@example.com',
  emailVerified: true,
  username: '地铁设计师',
  avatar: 'data:image/jpeg;base64,abc'
};

describe('authSession 7-day sliding persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test('returns none when no token exists', () => {
    const res = bootstrapAuthSession(1_000_000);
    expect(res).toEqual({ status: 'none', token: null, user: null });
  });

  test('hydrates cached user immediately within 7 days and slides idle window on subsequent visits', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const t0 = 1_700_000_000_000;
    const token = makeJwt({
      userId: sampleUser.id,
      purpose: 'login',
      iat: Math.floor(t0 / 1000),
      exp: Math.floor((t0 + 30 * dayMs) / 1000)
    });

    saveAuthSession(token, sampleUser, t0);

    // 第 5 天打开：未超 7 天，直接返回 active 用户并把活跃时间顺延到第 5 天
    const day5 = t0 + 5 * dayMs;
    const boot1 = bootstrapAuthSession(day5);
    expect(boot1.status).toBe('active');
    expect(boot1.user?.username).toBe('地铁设计师');

    // 第 10 天再次打开：距初始登录虽已 10 天，但距上次打开仅 5 天（≤7 天），仍免登录直达主页
    const day10 = t0 + 10 * dayMs;
    const boot2 = bootstrapAuthSession(day10);
    expect(boot2.status).toBe('active');
    expect(boot2.user?.id).toBe(sampleUser.id);
  });

  test('expires and clears storage when inactive for more than 7 days', () => {
    const t0 = 1_700_000_000_000;
    const token = makeJwt({
      userId: sampleUser.id,
      purpose: 'login',
      iat: Math.floor(t0 / 1000),
      exp: Math.floor((t0 + 30 * 24 * 60 * 60 * 1000) / 1000)
    });

    saveAuthSession(token, sampleUser, t0);

    const expiredAt = t0 + AUTH_IDLE_TTL_MS + 1;
    const res = bootstrapAuthSession(expiredAt);
    expect(res).toEqual({ status: 'expired', token: null, user: null });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_META_KEY)).toBeNull();
  });

  test('rejects expired JWT or non-login upgrade JWT immediately', () => {
    const t0 = 1_700_000_000_000;
    const expiredJwt = makeJwt({
      userId: sampleUser.id,
      purpose: 'login',
      iat: Math.floor((t0 - 10_000) / 1000),
      exp: Math.floor((t0 - 1_000) / 1000)
    });
    saveAuthSession(expiredJwt, sampleUser, t0);
    expect(bootstrapAuthSession(t0).status).toBe('expired');

    const upgradeJwt = makeJwt({
      userId: sampleUser.id,
      purpose: 'upgrade',
      iat: Math.floor(t0 / 1000),
      exp: Math.floor((t0 + 600_000) / 1000)
    });
    saveAuthSession(upgradeJwt, sampleUser, t0);
    expect(bootstrapAuthSession(t0).status).toBe('expired');
  });

  test('migrates legacy token-only storage smoothly when issued within 7 days', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const t0 = 1_700_000_000_000;
    const freshLegacyToken = makeJwt({
      userId: sampleUser.id,
      purpose: 'login',
      iat: Math.floor((t0 - 2 * dayMs) / 1000),
      exp: Math.floor((t0 + 28 * dayMs) / 1000)
    });
    localStorage.setItem(TOKEN_KEY, freshLegacyToken);

    const migrated = bootstrapAuthSession(t0);
    expect(migrated).toEqual({ status: 'verifying', token: freshLegacyToken, user: null });

    const newToken = makeJwt({
      userId: sampleUser.id,
      purpose: 'login',
      iat: Math.floor(t0 / 1000),
      exp: Math.floor((t0 + 30 * dayMs) / 1000)
    });
    touchAuthSessionUser({ ...sampleUser, username: '新昵称' }, newToken, t0 + 1000);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(newToken);
    const nextBoot = bootstrapAuthSession(t0 + 2000);
    expect(nextBoot.status).toBe('active');
    expect(nextBoot.user?.username).toBe('新昵称');

    // 活跃刷新不应复活已经超过 7 天未操作的过期会话
    touchAuthActivity(t0 + AUTH_IDLE_TTL_MS + 120_000);
    expect(bootstrapAuthSession(t0 + AUTH_IDLE_TTL_MS + 120_000).status).toBe('expired');
    clearAuthSession();
  });
});

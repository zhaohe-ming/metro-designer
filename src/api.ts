import { Line, MapSettings, Section, Station } from './types';

const TOKEN_KEY = 'metro_token';
const API_BASE_URL = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');

export interface UserDto {
  id: string;
  // 老账号会带 phone（升级前），新账号 phone 为空。
  phone: string;
  // 新主标识符：邮箱。注册即必填，登录前必须验证。
  email: string;
  emailVerified: boolean;
  username: string;
  avatar?: string;
}

export interface MapSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  // 列表里展示用，老服务端可能不带这些字段，前端按 0 兜底
  lineCount?: number;
  stationCount?: number;
  sectionCount?: number;
}

export interface FullMap extends MapSummary {
  userId: string;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings?: MapSettings;
}

// 登录返回三种状态：
//  - ok                正常登录，给主 JWT 和完整 user
//  - verify_required   邮箱未验证，前端要引导用户去邮箱；带 pollKey 给跨设备轮询用
//  - upgrade_required  legacy 手机号账号，必须先绑邮箱并验证；upgradeToken 只能调 upgrade-email
export type LoginResult =
  | { status: 'ok'; token: string; user: UserDto }
  | { status: 'verify_required'; email: string; pollKey: string }
  | { status: 'upgrade_required'; upgradeToken: string; hint?: string };

// 注册 / 升级邮箱 / 重发都返回 verify_sent；其中只有"刚提交"那次会带 pollKey
export type RegisterResult = { status: 'verify_sent'; email: string; pollKey: string };
export type VerifySentResult = { status: 'verify_sent'; email: string; pollKey?: string };
export type ResetSentResult = { status: 'reset_sent'; email: string };

// 跨设备等待验证的轮询响应。一旦后端见到 user.email_verified === true，
// 就消费 pollKey 并连同主 JWT 一起回来；前端拿到 ok 后停止轮询当登录处理。
export type CheckPendingResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ok'; token: string; user: UserDto };

// AI 自然语言编辑返回的操作类型。后端用 DeepSeek tool calls 翻译用户意图，
// 已经过 id / 颜色 / 长度校验，前端直接 apply 即可。
export type AIOperation =
  | { type: 'create_line'; name: string; color: string; stationIds: string[] }
  | { type: 'recolor_line'; lineId: string; color: string }
  | { type: 'rename_line'; lineId: string; name: string }
  | { type: 'delete_line'; lineId: string }
  | { type: 'attach_station_to_line'; lineId: string; stationId: string; position: 'start' | 'end' }
  | { type: 'create_station_between'; lineId: string; afterStationId: string; beforeStationId: string; names: string[] }
  | { type: 'create_station_at_line_end'; lineId: string; position: 'start' | 'end'; names: string[] }
  | { type: 'rename_station'; stationId: string; name: string }
  | { type: 'delete_station'; stationId: string };

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  authMode: 'none' | 'login' | 'custom' = 'none',
  customToken?: string
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined)
  };
  if (authMode === 'login') {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (authMode === 'custom' && customToken) {
    headers.Authorization = `Bearer ${customToken}`;
  }
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || '请求失败');
  return data as T;
}

async function requestBlob(path: string, options: RequestInit = {}, auth = false): Promise<Blob> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined)
  };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || '请求失败');
  }
  return res.blob();
}

export const api = {
  // 邮箱或老手机号都从 `account` 字段送，后端会自动按是否含 @ 路由。
  login: (payload: { account: string; password: string }) =>
    request<LoginResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        account: payload.account.trim(),
        password: payload.password
      })
    }),

  register: (payload: { email: string; password: string; username: string }) =>
    request<RegisterResult>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: payload.email.trim().toLowerCase(),
        password: payload.password,
        username: payload.username.trim()
      })
    }),

  // 用 upgradeToken（不是主 JWT）调，给 legacy 手机号账号补绑邮箱
  upgradeEmail: (payload: { email: string; upgradeToken: string }) =>
    request<VerifySentResult>(
      '/api/auth/upgrade-email',
      {
        method: 'POST',
        body: JSON.stringify({ email: payload.email.trim().toLowerCase() })
      },
      'custom',
      payload.upgradeToken
    ),

  // 消费一次性 verify token；服务端响应里带 token + user，前端拿到就当登录成功
  verifyEmail: (token: string) =>
    request<{ status: 'ok'; token: string; user: UserDto }>('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token })
    }),

  resendVerification: (email: string) =>
    request<VerifySentResult>('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim().toLowerCase() })
    }),

  // 跨设备验证轮询：等待中的设备每 ~5s 调一次，确认另一设备是否完成了验证
  checkPending: (pollKey: string) =>
    request<CheckPendingResult>('/api/auth/check-pending', {
      method: 'POST',
      body: JSON.stringify({ pollKey })
    }),

  forgotPassword: (email: string) =>
    request<ResetSentResult>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim().toLowerCase() })
    }),

  // 消费一次性 reset token，并设置新密码；成功后服务端也回主 JWT
  resetPassword: (payload: { token: string; password: string }) =>
    request<{ status: 'ok'; token: string; user: UserDto }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: payload.token, password: payload.password })
    }),

  // AI 助手相关接口（后端代理 DeepSeek）
  translateStation: (name: string) =>
    request<{ name: string; english: string }>('/api/ai/translate-station', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() })
    }, 'login'),

  // 自然语言编辑：把当前地图状态 + 用户描述送给 LLM，回一组结构化 operations
  aiEdit: (payload: {
    message: string;
    mapState: {
      lines: { id: string; name: string; color: string; stationIds: string[] }[];
      stations: { id: string; name: string }[];
    };
  }) =>
    request<{
      operations: AIOperation[];
      explanation: string;
      skipped: { name: string; reason: string }[];
    }>('/api/ai/edit', {
      method: 'POST',
      body: JSON.stringify(payload)
    }, 'login'),

  me: () => request<{ user: UserDto }>('/api/me', {}, 'login'),
  updateMe: (payload: { username?: string; avatar?: string; password?: string }) =>
    request<{ user: UserDto }>('/api/me', { method: 'PUT', body: JSON.stringify(payload) }, 'login'),
  listMaps: () => request<{ maps: MapSummary[] }>('/api/maps', {}, 'login'),
  getMap: (id: string) => request<{ map: FullMap }>(`/api/maps/${id}`, {}, 'login'),
  createMap: (payload: { name: string; lines: Line[]; stations: Station[]; sections: Section[]; mapSettings?: MapSettings }) =>
    request<{ map: MapSummary }>('/api/maps', { method: 'POST', body: JSON.stringify(payload) }, 'login'),
  updateMap: (id: string, payload: { name?: string; lines?: Line[]; stations?: Station[]; sections?: Section[]; mapSettings?: MapSettings }) =>
    request<{ map: MapSummary }>(`/api/maps/${id}`, { method: 'PUT', body: JSON.stringify(payload) }, 'login'),
  deleteMap: (id: string) => request<{ ok: boolean }>(`/api/maps/${id}`, { method: 'DELETE' }, 'login'),
  getAmapStaticMap: (params: {
    center: [number, number];
    zoom: number;
    width: number;
    height: number;
    style?: string;
  }) => {
    const query = new URLSearchParams({
      lng: String(params.center[0]),
      lat: String(params.center[1]),
      zoom: String(params.zoom),
      width: String(params.width),
      height: String(params.height),
      style: params.style || 'normal'
    });
    return requestBlob(`/api/amap/static-map?${query.toString()}`, {}, true);
  }
};

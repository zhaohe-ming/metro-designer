import { Line, MapSettings, Section, Station } from './types';

const TOKEN_KEY = 'metro_token';
const API_BASE_URL = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');

function normalizeAuthPayload<T extends { phone: string; password: string }>(payload: T): T {
  return {
    ...payload,
    phone: payload.phone.trim(),
    password: payload.password
  };
}

export interface UserDto {
  id: string;
  phone: string;
  username: string;
  avatar?: string;
}

export interface MapSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FullMap extends MapSummary {
  userId: string;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings?: MapSettings;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined)
  };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
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
  login: (payload: { phone: string; password: string }) =>
    request<{ token: string; user: UserDto }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(normalizeAuthPayload(payload))
    }),
  register: (payload: { phone: string; password: string; username: string }) =>
    request<{ token: string; user: UserDto }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        ...normalizeAuthPayload(payload),
        username: payload.username.trim()
      })
    }),
  me: () => request<{ user: UserDto }>('/api/me', {}, true),
  updateMe: (payload: { username?: string; avatar?: string; password?: string }) =>
    request<{ user: UserDto }>('/api/me', { method: 'PUT', body: JSON.stringify(payload) }, true),
  listMaps: () => request<{ maps: MapSummary[] }>('/api/maps', {}, true),
  getMap: (id: string) => request<{ map: FullMap }>(`/api/maps/${id}`, {}, true),
  createMap: (payload: { name: string; lines: Line[]; stations: Station[]; sections: Section[]; mapSettings?: MapSettings }) =>
    request<{ map: MapSummary }>('/api/maps', { method: 'POST', body: JSON.stringify(payload) }, true),
  updateMap: (id: string, payload: { name?: string; lines?: Line[]; stations?: Station[]; sections?: Section[]; mapSettings?: MapSettings }) =>
    request<{ map: MapSummary }>(`/api/maps/${id}`, { method: 'PUT', body: JSON.stringify(payload) }, true),
  deleteMap: (id: string) => request<{ ok: boolean }>(`/api/maps/${id}`, { method: 'DELETE' }, true),
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

import { DEFAULT_MAP_SETTINGS, Line, MapSettings, Section, Station, normalizeMapSettings, normalizeSections } from '../types';
import { createId } from '../utils/id';

export interface GuestDraft {
  gallerySourceToken?: string;
  version: 1;
  id: string;
  updatedAt: number;
  name: string;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  currentLineId: string | null;
  viewport?: { scale: number; x: number; y: number };
}

const ACTIVE_KEY = 'metro_guest_active';
const DB_NAME = 'metro-designer-guest';
const STORE = 'drafts';
export const hasGuestSession = () => {
  try { return localStorage.getItem(ACTIVE_KEY) === '1'; } catch { return false; }
};
export const setGuestSession = (active: boolean) => {
  try { active ? localStorage.setItem(ACTIVE_KEY, '1') : localStorage.removeItem(ACTIVE_KEY); } catch { /* IndexedDB still works. */ }
};

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他旧版预览页面后重试'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('本机草稿保存失败')); };
  });
}

export async function readGuestDraft(): Promise<GuestDraft | null> {
  const value = await transaction('readonly', store => store.get('current'));
  if (!value) return null;
  if (value.version !== 1 || typeof value.id !== 'string' || !Array.isArray(value.lines) || !Array.isArray(value.stations)) {
    throw new Error('本机草稿格式需要检查，请先保留备份');
  }
  return { ...value, sections: normalizeSections(value.sections), mapSettings: normalizeMapSettings(value.mapSettings) };
}
let pendingWrite: Promise<unknown> = Promise.resolve();
function orderedWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingWrite.catch(() => {}).then(operation);
  pendingWrite = result;
  return result;
}
export const writeGuestDraft = (draft: GuestDraft) => orderedWrite(() => transaction('readwrite', store => store.put(draft, 'current')));
export const deleteGuestDraft = () => orderedWrite(() => transaction('readwrite', store => store.delete('current')));

// Fictional, compact graph: two shared nodes demonstrate transfers without claiming a real city.
export function createGuestDraft(blank = false): GuestDraft {
  const nodes: Array<[string, string, number, number]> = [
    ['a', '西园', 80, 240], ['b', '艺术街', 190, 240], ['c', '城市中心', 300, 240],
    ['d', '滨河', 410, 240], ['e', '东岸', 520, 130],
    ['f', '北门', 190, 20], ['g', '书院', 300, 130], ['h', '南广场', 300, 360], ['i', '南园', 300, 470],
    ['j', '湖畔', 190, 470], ['k', '科技园', 410, 360], ['l', '新城', 520, 360]
  ];
  const stations: Station[] = blank ? [] : nodes.map(([id, name, x, y]) => ({ id: `demo-${id}`, name, x, y }));
  const routes = blank ? [] : [
    { id: 'demo-1', name: '1号线', color: '#2563eb', ids: ['a', 'b', 'c', 'd', 'e'] },
    { id: 'demo-2', name: '2号线', color: '#f59e0b', ids: ['f', 'g', 'c', 'h', 'i'] },
    { id: 'demo-3', name: '3号线', color: '#10b981', ids: ['j', 'h', 'k', 'l'] }
  ];
  const sections: Section[] = [];
  const lines = routes.map(route => {
    const stationIds = route.ids.map(id => `demo-${id}`);
    const sectionIds = stationIds.slice(1).map((endStationId, i) => {
      const id = `${route.id}-${i}`;
      sections.push({ id, lineId: route.id, startStationId: stationIds[i], endStationId });
      return id;
    });
    return { id: route.id, name: route.name, color: route.color, stationIds, sectionIds };
  });
  return {
    version: 1, id: createId(), updatedAt: Date.now(), name: blank ? '' : '我的示例线网',
    stations, lines, sections, currentLineId: lines[0]?.id || null,
    mapSettings: normalizeMapSettings({ ...DEFAULT_MAP_SETTINGS, cornerRadius: 14, labelDensity: blank ? DEFAULT_MAP_SETTINGS.labelDensity : 'adaptive' })
  };
}

import {
  DEFAULT_MAP_SETTINGS,
  Line,
  MapSettings,
  Section,
  Station,
  normalizeMapSettings,
  normalizeSections
} from '../types';

export const METRO_PROJECT_FORMAT = 'metro-designer-project';
export const METRO_PROJECT_EXT = '.metro';

export interface MetroProjectViewport {
  scale: number;
  x: number;
  y: number;
}

export interface MetroProjectData {
  format: typeof METRO_PROJECT_FORMAT;
  version: 1;
  savedAt: string;
  name: string;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  currentLineId: string | null;
  viewport?: MetroProjectViewport;
}

export function stripProjectExtension(filename: string): string {
  return filename
    .trim()
    .replace(/\.(metro\.json|metro|json)$/i, '')
    .trim();
}

export function sanitizeProjectFilename(name: string): string {
  const raw = stripProjectExtension(name || '');
  let filtered = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = raw[i];
    if (code < 32 || '<>:"/\\|?*'.indexOf(ch) >= 0) {
      filtered += '_';
    } else {
      filtered += ch;
    }
  }
  const safe = filtered.trim().replace(/^\.+/, '').trim() || '未命名线路图';
  return safe.length > 80 ? safe.slice(0, 80).trim() : safe;
}

export function serializeMetroProject(input: {
  name: string;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  currentLineId?: string | null;
  viewport?: MetroProjectViewport;
}): string {
  const payload: MetroProjectData = {
    format: METRO_PROJECT_FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    name: stripProjectExtension(input.name || '') || '未命名线路图',
    lines: input.lines.map((line) => ({
      ...line,
      stationIds: Array.isArray(line.stationIds) ? [...line.stationIds] : [],
      sectionIds: Array.isArray(line.sectionIds) ? [...line.sectionIds] : []
    })),
    stations: input.stations.map((st) => ({ ...st })),
    sections: normalizeSections(input.sections),
    mapSettings: normalizeMapSettings(input.mapSettings),
    currentLineId: input.currentLineId ?? null,
    ...(input.viewport &&
    typeof input.viewport.scale === 'number' &&
    typeof input.viewport.x === 'number' &&
    typeof input.viewport.y === 'number'
      ? {
          viewport: {
            scale: input.viewport.scale,
            x: input.viewport.x,
            y: input.viewport.y
          }
        }
      : {})
  };
  return JSON.stringify(payload, null, 2);
}

function normalizeStations(rawStations: unknown): Station[] {
  if (!Array.isArray(rawStations)) {
    throw new Error('工程文件缺少有效的站点列表');
  }
  return rawStations
    .filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'))
    .map((st, idx) => {
      const id = typeof st.id === 'string' && st.id.trim() ? st.id.trim() : `station_${idx}`;
      const name = typeof st.name === 'string' && st.name.trim() ? st.name.trim() : `站点${idx + 1}`;
      const x = typeof st.x === 'number' && Number.isFinite(st.x) ? st.x : 0;
      const y = typeof st.y === 'number' && Number.isFinite(st.y) ? st.y : 0;
      const normalized: Station = { id, name, x, y };
      if (typeof st.lng === 'number' && Number.isFinite(st.lng)) normalized.lng = st.lng;
      if (typeof st.lat === 'number' && Number.isFinite(st.lat)) normalized.lat = st.lat;
      if (typeof st.note === 'string' && st.note) normalized.note = st.note;
      if (typeof st.labelPosition === 'string') normalized.labelPosition = st.labelPosition as Station['labelPosition'];
      return normalized;
    });
}

function normalizeLines(rawLines: unknown): Line[] {
  if (!Array.isArray(rawLines)) {
    throw new Error('工程文件缺少有效的线路列表');
  }
  return rawLines
    .filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'))
    .map((line, idx) => ({
      id: typeof line.id === 'string' && line.id.trim() ? line.id.trim() : `line_${idx}`,
      name: typeof line.name === 'string' && line.name.trim() ? line.name.trim() : `${idx + 1}号线`,
      color: typeof line.color === 'string' && line.color.trim() ? line.color.trim() : '#2563eb',
      stationIds: Array.isArray(line.stationIds)
        ? line.stationIds.filter((id: unknown): id is string => typeof id === 'string')
        : [],
      sectionIds: Array.isArray(line.sectionIds)
        ? line.sectionIds.filter((id: unknown): id is string => typeof id === 'string')
        : [],
      ...(typeof line.lastAddedStationId === 'string' ? { lastAddedStationId: line.lastAddedStationId } : {})
    }));
}

/**
 * 解析 .metro 工程文件或旧版 .json 草稿备份，统一返回可直接加载到工作台的数据结构。
 */
export function parseMetroProjectJson(rawText: string, fallbackFilename = ''): MetroProjectData {
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('文件不是有效的 JSON / Metro 工程格式');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('工程文件内容为空或已损坏');
  }

  // 同时兼容新版 .metro 工程、访客草稿备份以及云端地图导出结构
  const source = parsed.map && typeof parsed.map === 'object' ? parsed.map : parsed;
  if (!Array.isArray(source.lines) || !Array.isArray(source.stations)) {
    throw new Error('未识别到线路与站点数据，请选择正确的 .metro 或 .json 工程文件');
  }

  const lines = normalizeLines(source.lines);
  const stations = normalizeStations(source.stations);
  const sections = normalizeSections(source.sections);
  const mapSettings = normalizeMapSettings(
    source.mapSettings && typeof source.mapSettings === 'object'
      ? source.mapSettings
      : DEFAULT_MAP_SETTINGS
  );

  const fallbackName = stripProjectExtension(fallbackFilename) || '未命名线路图';
  const rawName = typeof source.name === 'string' ? stripProjectExtension(source.name) : '';
  const name = rawName || fallbackName;

  const rawViewport = source.viewport;
  const viewport: MetroProjectViewport | undefined =
    rawViewport &&
    typeof rawViewport === 'object' &&
    typeof rawViewport.scale === 'number' &&
    Number.isFinite(rawViewport.scale) &&
    typeof rawViewport.x === 'number' &&
    Number.isFinite(rawViewport.x) &&
    typeof rawViewport.y === 'number' &&
    Number.isFinite(rawViewport.y)
      ? {
          scale: rawViewport.scale,
          x: rawViewport.x,
          y: rawViewport.y
        }
      : undefined;

  const currentLineId =
    typeof source.currentLineId === 'string' && lines.some((l) => l.id === source.currentLineId)
      ? source.currentLineId
      : lines[0]?.id || null;

  return {
    format: METRO_PROJECT_FORMAT,
    version: 1,
    savedAt: typeof source.savedAt === 'string' ? source.savedAt : new Date().toISOString(),
    name,
    lines,
    stations,
    sections,
    mapSettings,
    currentLineId,
    ...(viewport ? { viewport } : {})
  };
}

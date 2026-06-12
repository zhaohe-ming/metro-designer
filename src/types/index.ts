export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
  lng?: number;
  lat?: number;
  note?: string;
  labelPosition?: 'auto' | 'top' | 'right' | 'bottom' | 'left' | 'hidden';
}

export interface Waypoint {
  x: number;
  y: number;
  lng?: number;
  lat?: number;
  hidden?: boolean;
}

export interface Section {
  id: string;
  lineId: string;
  startStationId: string;
  endStationId: string;
  waypoints?: Waypoint[];
}

export interface Line {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
  sectionIds: string[];
  lastAddedStationId?: string;
}

export type MapStyle = 'classic-badge' | 'dot-label';
export type CanvasTheme = 'light' | 'dark';
export type CityStyle = 'standard' | 'beijing' | 'shanghai' | 'mtr';
export type DotLabelStyle = {
  fontSize: number;
  fontWeight: number;
  color: string;
};
export type BaseMapMode = 'plain' | 'amap';
export type AmapStyle = 'normal' | 'dark' | 'grey' | 'fresh';
export type AmapBaseMapSettings = {
  center: [number, number];
  zoom: number;
  style: AmapStyle;
};
export type BaseMapSettings = {
  mode: BaseMapMode;
  amap?: AmapBaseMapSettings;
};

// 站点标签密度。决定缩放时站名/站点圆点/线宽如何呈现 + 是否隐藏次要站名。
// - paper:    图纸缩放，站名+圆点+线宽跟着画布/AMap 一起缩放，缩远会看不清，看的是结构
// - adaptive: 屏幕可读，做弱反向缩放保证编辑时不糊；overlap 多就藏 Tier 2
// - key:      只显示换乘 + 首末站；其他站名永久隐藏（圆点仍画）
export type LabelDensity = 'paper' | 'adaptive' | 'key';

export interface MapSettings {
  mapStyle: MapStyle;
  canvasTheme: CanvasTheme;
  cityStyle: CityStyle;
  showLineNameLabels: boolean;
  dotLabelStyle: DotLabelStyle;
  baseMap: BaseMapSettings;
  labelDensity: LabelDensity;
  // 线路转角圆角半径（世界坐标单位）。0 = 直角（关闭）。只圆途经点拐角，站点端点不圆。
  cornerRadius: number;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  // 新建项目默认"专业线网"（dot-label）。注意 normalizeMapSettings 的 fallback
  // 仍是 classic-badge —— 老存档缺 mapStyle 字段时保持原观感，只有新项目吃这个默认。
  mapStyle: 'dot-label',
  canvasTheme: 'light',
  cityStyle: 'standard',
  showLineNameLabels: true,
  dotLabelStyle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a'
  },
  baseMap: {
    mode: 'plain',
    amap: {
      center: [116.397428, 39.90923],
      zoom: 11,
      style: 'normal'
    }
  },
  // 默认 paper：保持原有"图纸缩放"行为不破坏老用户预期。
  // App.tsx 在 boot 时会用 localStorage 里的 user-last preference 覆盖这个默认值。
  labelDensity: 'paper',
  // 默认 0（直角）：不改变老地图的既有观感，用户在设置里主动开启圆角。
  cornerRadius: 0
};

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numberValue));
};

export const normalizeMapSettings = (settings?: Partial<MapSettings> | null): MapSettings => {
  const dotLabelStyle = (settings?.dotLabelStyle || {}) as Partial<DotLabelStyle>;
  const baseMap = (settings?.baseMap || {}) as Partial<BaseMapSettings>;
  const amap = (baseMap.amap || {}) as Partial<AmapBaseMapSettings>;
  const cityStyle =
    settings?.cityStyle === 'beijing' ||
    settings?.cityStyle === 'shanghai' ||
    settings?.cityStyle === 'mtr'
      ? settings.cityStyle
      : 'standard';
  return {
    mapStyle: settings?.mapStyle === 'dot-label' ? 'dot-label' : 'classic-badge',
    canvasTheme: settings?.canvasTheme === 'dark' ? 'dark' : 'light',
    cityStyle,
    showLineNameLabels: settings?.showLineNameLabels !== false,
    dotLabelStyle: {
      fontSize: normalizeNumber(dotLabelStyle.fontSize, DEFAULT_MAP_SETTINGS.dotLabelStyle.fontSize, 10, 24),
      fontWeight: normalizeNumber(dotLabelStyle.fontWeight, DEFAULT_MAP_SETTINGS.dotLabelStyle.fontWeight, 300, 900),
      color:
        typeof dotLabelStyle.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(dotLabelStyle.color)
          ? dotLabelStyle.color
          : DEFAULT_MAP_SETTINGS.dotLabelStyle.color
    },
    baseMap: {
      mode: baseMap.mode === 'amap' ? 'amap' : 'plain',
      amap: {
        center:
          Array.isArray(amap.center) &&
          amap.center.length === 2 &&
          amap.center.every(value => typeof value === 'number' && Number.isFinite(value))
            ? [amap.center[0], amap.center[1]]
            : DEFAULT_MAP_SETTINGS.baseMap.amap!.center,
        zoom: normalizeNumber(amap.zoom, DEFAULT_MAP_SETTINGS.baseMap.amap!.zoom, 3, 20),
        style:
          amap.style === 'dark' || amap.style === 'grey' || amap.style === 'fresh'
            ? amap.style
            : 'normal'
      }
    },
    labelDensity:
      settings?.labelDensity === 'adaptive' ||
      settings?.labelDensity === 'key'
        ? settings.labelDensity
        : 'paper',
    cornerRadius: normalizeNumber(settings?.cornerRadius, DEFAULT_MAP_SETTINGS.cornerRadius, 0, 40)
  };
};

const normalizeWaypoint = (raw: any): Waypoint | null => {
  if (!raw || typeof raw !== 'object') return null;
  const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : null;
  const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : null;
  if (x === null || y === null) return null;
  const waypoint: Waypoint = { x, y };
  if (typeof raw.lng === 'number' && Number.isFinite(raw.lng)) waypoint.lng = raw.lng;
  if (typeof raw.lat === 'number' && Number.isFinite(raw.lat)) waypoint.lat = raw.lat;
  if (raw.hidden === true) waypoint.hidden = true;
  return waypoint;
};

export const normalizeSections = (rawSections: any): Section[] => {
  if (!Array.isArray(rawSections)) return [];
  return rawSections
    .map((section): Section | null => {
      if (!section || typeof section !== 'object') return null;
      if (!section.id || !section.lineId || !section.startStationId || !section.endStationId) return null;
      const waypointsInput = Array.isArray(section.waypoints) ? section.waypoints : [];
      const waypoints = waypointsInput
        .map(normalizeWaypoint)
        .filter((point: Waypoint | null): point is Waypoint => point !== null);
      const normalized: Section = {
        id: String(section.id),
        lineId: String(section.lineId),
        startStationId: String(section.startStationId),
        endStationId: String(section.endStationId)
      };
      if (waypoints.length) normalized.waypoints = waypoints;
      return normalized;
    })
    .filter((section: Section | null): section is Section => section !== null);
};

export const LINE_COLORS = [
  '#1890ff',
  '#f5222d',
  '#52c41a',
  '#faad14',
  '#722ed1',
  '#13c2c2',
  '#eb2f96',
  '#fa8c16'
];

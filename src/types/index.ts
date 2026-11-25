export type StationLabelPosition =
  | 'auto'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'hidden';

export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
  lng?: number;
  lat?: number;
  note?: string;
  labelPosition?: StationLabelPosition;
}

export type WaypointCurveMode = 'corner' | 'arc';

export interface Waypoint {
  x: number;
  y: number;
  lng?: number;
  lat?: number;
  hidden?: boolean;
  /** 单点独立圆弧半径（世界坐标；undefined 时回退到全局 cornerRadius，0 为折角） */
  radius?: number;
  /** 曲线模式：'corner' 相切导圆角（默认），'arc' 过前一点-当前点-后一点的三点正圆弧 */
  mode?: WaypointCurveMode;
}

export interface Section {
  id: string;
  lineId: string;
  startStationId: string;
  endStationId: string;
  waypoints?: Waypoint[];
  /** 可选：共线并行走廊中各线路的上/左 → 下/右槽位顺序（lineId 数组；缺省按左侧线路列表顺序排布） */
  parallelOrder?: string[];
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
export type BaseMapMode = 'plain' | 'light-city' | 'amap';
export type AmapStyle = 'normal' | 'dark' | 'grey' | 'fresh';
export type GeoCoordSystem = 'wgs84' | 'gcj02';
export type AmapBaseMapSettings = {
  center: [number, number];
  zoom: number;
  style: AmapStyle;
  /** 坐标基准：新版免 Key 开源底图统一存 'wgs84'；未标记的旧版高德存档自动识别为 'gcj02' 并在加载时一次性纠偏 */
  coordSystem?: GeoCoordSystem;
};

export type LightCityArchetype = 'river' | 'confluence' | 'bay' | 'ring' | 'delta' | 'lake' | 'custom';
export type LightCityZoneKind = 'urban' | 'park' | 'island';
export type LightCityRoadKind = 'express' | 'arterial';
export type LightCityLabelKind = 'district' | 'subdistrict' | 'water';

export interface LightCityPoint {
  x: number;
  y: number;
}

export type LightCityFeature =
  | {
      id: string;
      type: 'zone';
      kind: LightCityZoneKind;
      points: LightCityPoint[];
    }
  | {
      id: string;
      type: 'waterArea';
      points: LightCityPoint[];
    }
  | {
      id: string;
      type: 'river';
      width: number;
      points: LightCityPoint[];
    }
  | {
      id: string;
      type: 'road';
      kind: LightCityRoadKind;
      closed?: boolean;
      points: LightCityPoint[];
    }
  | {
      id: string;
      type: 'label';
      kind: LightCityLabelKind;
      x: number;
      y: number;
      text: string;
    };

export interface LightCityLayerVisibility {
  zones: boolean;
  water: boolean;
  roads: boolean;
  labels: boolean;
}

export interface LightCitySettings {
  theme: 'paper-grey';
  archetype: LightCityArchetype;
  seed: number;
  opacity: number;
  layerVisibility: LightCityLayerVisibility;
  features: LightCityFeature[];
}

export type BaseMapSettings = {
  mode: BaseMapMode;
  amap?: AmapBaseMapSettings;
  lightCity?: LightCitySettings;
};

// 站点标签密度。决定缩放时站名/站点圆点/线宽如何呈现 + 是否隐藏次要站名。
// - paper:    图纸缩放，站名+圆点+线宽跟着画布/AMap 一起缩放，缩远会看不清，看的是结构
// - adaptive: 屏幕可读，做弱反向缩放保证编辑时不糊；overlap 多就藏 Tier 2
// - key:      只显示换乘 + 首末站；其他站名永久隐藏（圆点仍画）
export type LabelDensity = 'paper' | 'adaptive' | 'key';

export type VideoAspectRatio = '16:9' | '9:16' | '4:3' | '1:1';
export type VideoResolution = '1080p' | '720p';
export type VideoFps = 30 | 60;
export type VideoSpeedMultiplier = 0.75 | 1 | 1.5 | 2;
export type VideoCameraMode = 'overview' | 'gentle' | 'follow';
export type VideoUnopenedStyle = 'ghost' | 'hidden';
export type VideoDateMode = 'date' | 'sequence';

export interface VideoSegmentInput {
  id: string;
  lineId: string;
  startStationId: string;
  endStationId: string;
  openDate: string;
  phaseLabel?: string;
}

export interface VideoExportConfig {
  segments: VideoSegmentInput[];
  title: string;
  subtitle: string;
  titleDurationSec: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  fps?: VideoFps;
  speedMultiplier?: VideoSpeedMultiplier;
  cameraMode?: VideoCameraMode;
  unopenedStyle?: VideoUnopenedStyle;
  dateMode?: VideoDateMode;
  showYearBadge?: boolean;
  showLineLegend?: boolean;
}

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
  // 是否默认隐藏画布上的途经点控制柄（圆弧/折角仍正常生效，仅选中或右键区间唤醒时才显示控制柄）
  hideWaypoints?: boolean;
  videoExport?: VideoExportConfig;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  // 全部创作统一采用"专业线网"（dot-label）模式
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
      center: [116.391276, 39.907335],
      zoom: 11,
      style: 'normal',
      coordSystem: 'wgs84'
    }
  },
  // 默认 paper：保持原有"图纸缩放"行为不破坏老用户预期。
  // App.tsx 在 boot 时会用 localStorage 里的 user-last preference 覆盖这个默认值。
  labelDensity: 'paper',
  // 默认 0（直角）：不改变老地图的既有观感，用户在设置里主动开启圆角。
  cornerRadius: 0,
  hideWaypoints: false
};

const roundCoord = (n: number) => Math.round(n * 10) / 10;

const normalizeLightCityPoint = (raw: any): LightCityPoint | null => {
  if (!raw || typeof raw !== 'object') return null;
  const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? roundCoord(raw.x) : null;
  const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? roundCoord(raw.y) : null;
  if (x === null || y === null) return null;
  return { x, y };
};

export const normalizeLightCitySettings = (raw: unknown): LightCitySettings | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Partial<LightCitySettings>;
  const archetypes: LightCityArchetype[] = ['river', 'confluence', 'bay', 'ring', 'delta', 'lake', 'custom'];
  const archetype: LightCityArchetype = archetypes.includes(src.archetype as LightCityArchetype)
    ? (src.archetype as LightCityArchetype)
    : 'river';
  const seed = Math.max(1, Math.min(999999999, Math.round(Number(src.seed) || 1024)));
  const opacity = Math.round(normalizeNumber(src.opacity, 1, 0.25, 1) * 100) / 100;
  const lv = (src.layerVisibility || {}) as Partial<LightCityLayerVisibility>;
  const layerVisibility: LightCityLayerVisibility = {
    zones: lv.zones !== false,
    water: lv.water !== false,
    roads: lv.roads !== false,
    labels: lv.labels !== false
  };

  const usedIds = new Set<string>();
  const rawFeatures = Array.isArray(src.features) ? src.features.slice(0, 600) : [];
  const features: LightCityFeature[] = [];

  rawFeatures.forEach((item: any, idx: number) => {
    if (!item || typeof item !== 'object') return;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 64) : `lc_${idx + 1}`;
    while (usedIds.has(id)) id += '_c';
    usedIds.add(id);

    if (item.type === 'label') {
      const x = typeof item.x === 'number' && Number.isFinite(item.x) ? roundCoord(item.x) : null;
      const y = typeof item.y === 'number' && Number.isFinite(item.y) ? roundCoord(item.y) : null;
      const text = typeof item.text === 'string' ? item.text.trim().slice(0, 32) : '';
      if (x === null || y === null || !text) return;
      const kind: LightCityLabelKind =
        item.kind === 'subdistrict' || item.kind === 'water' ? item.kind : 'district';
      features.push({ id, type: 'label', kind, x, y, text });
      return;
    }

    const pts = (Array.isArray(item.points) ? item.points.slice(0, 400) : [])
      .map(normalizeLightCityPoint)
      .filter((p: LightCityPoint | null): p is LightCityPoint => p !== null);

    if (item.type === 'zone') {
      if (pts.length < 3) return;
      const kind: LightCityZoneKind =
        item.kind === 'park' || item.kind === 'island' ? item.kind : 'urban';
      features.push({ id, type: 'zone', kind, points: pts });
    } else if (item.type === 'waterArea') {
      if (pts.length < 3) return;
      features.push({ id, type: 'waterArea', points: pts });
    } else if (item.type === 'river') {
      if (pts.length < 2) return;
      const width = Math.round(normalizeNumber(item.width, 56, 10, 220));
      features.push({ id, type: 'river', width, points: pts });
    } else if (item.type === 'road') {
      if (pts.length < 2) return;
      const kind: LightCityRoadKind = item.kind === 'express' ? 'express' : 'arterial';
      features.push({
        id,
        type: 'road',
        kind,
        ...(item.closed === true && pts.length >= 3 ? { closed: true } : {}),
        points: pts
      });
    }
  });

  return {
    theme: 'paper-grey',
    archetype,
    seed,
    opacity,
    layerVisibility,
    features
  };
};

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numberValue));
};

export const normalizeVideoExportConfig = (raw: unknown): VideoExportConfig | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const config = raw as Partial<VideoExportConfig>;
  const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
  const usedIds = new Set<string>();
  const segments = (Array.isArray(config.segments) ? config.segments : [])
    .filter(segment => segment && typeof segment === 'object' && !Array.isArray(segment))
    .map((segment, index) => {
      let id = text(segment.id, 128) || `video-step-${index + 1}`;
      while (usedIds.has(id)) id += '-copy';
      usedIds.add(id);
      const phaseLabel = text(segment.phaseLabel, 24);
      return {
        id,
        lineId: text(segment.lineId, 128),
        startStationId: text(segment.startStationId, 128),
        endStationId: text(segment.endStationId, 128),
        openDate: text(segment.openDate, 24),
        ...(phaseLabel ? { phaseLabel } : {})
      };
    });
  const aspectRatio: VideoAspectRatio | undefined =
    config.aspectRatio === '16:9' || config.aspectRatio === '9:16' || config.aspectRatio === '4:3' || config.aspectRatio === '1:1'
      ? config.aspectRatio
      : undefined;
  const resolution: VideoResolution | undefined =
    config.resolution === '1080p' || config.resolution === '720p' ? config.resolution : undefined;
  const fps: VideoFps | undefined = config.fps === 30 || config.fps === 60 ? config.fps : undefined;
  const speedMultiplier: VideoSpeedMultiplier | undefined =
    config.speedMultiplier === 0.75 || config.speedMultiplier === 1 || config.speedMultiplier === 1.5 || config.speedMultiplier === 2
      ? config.speedMultiplier
      : undefined;
  const cameraMode: VideoCameraMode | undefined =
    config.cameraMode === 'overview' || config.cameraMode === 'gentle' || config.cameraMode === 'follow'
      ? config.cameraMode
      : undefined;
  const unopenedStyle: VideoUnopenedStyle | undefined =
    config.unopenedStyle === 'ghost' || config.unopenedStyle === 'hidden' ? config.unopenedStyle : undefined;
  const dateMode: VideoDateMode | undefined =
    config.dateMode === 'date' || config.dateMode === 'sequence' ? config.dateMode : undefined;

  return {
    segments,
    title: text(config.title, 32),
    subtitle: text(config.subtitle, 48),
    titleDurationSec: normalizeNumber(config.titleDurationSec, 3, 1, 8),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(fps ? { fps } : {}),
    ...(speedMultiplier ? { speedMultiplier } : {}),
    ...(cameraMode ? { cameraMode } : {}),
    ...(unopenedStyle ? { unopenedStyle } : {}),
    ...(dateMode ? { dateMode } : {}),
    ...(typeof config.showYearBadge === 'boolean' ? { showYearBadge: config.showYearBadge } : {}),
    ...(typeof config.showLineLegend === 'boolean' ? { showLineLegend: config.showLineLegend } : {})
  };
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
    mapStyle: 'dot-label',
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
      mode: baseMap.mode === 'amap' ? 'amap' : baseMap.mode === 'light-city' ? 'light-city' : 'plain',
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
            : 'normal',
        ...(amap.coordSystem === 'wgs84' || amap.coordSystem === 'gcj02'
          ? { coordSystem: amap.coordSystem }
          : baseMap.mode !== 'amap'
            ? { coordSystem: 'wgs84' as const }
            : {})
      },
      ...(baseMap.lightCity ? { lightCity: normalizeLightCitySettings(baseMap.lightCity) } : {})
    },
    labelDensity:
      settings?.labelDensity === 'adaptive' ||
      settings?.labelDensity === 'key'
        ? settings.labelDensity
        : 'paper',
    cornerRadius: normalizeNumber(settings?.cornerRadius, DEFAULT_MAP_SETTINGS.cornerRadius, 0, 40),
    hideWaypoints: settings?.hideWaypoints === true,
    ...(settings?.videoExport ? { videoExport: normalizeVideoExportConfig(settings.videoExport) } : {})
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
  if (typeof raw.radius === 'number' && Number.isFinite(raw.radius) && raw.radius >= 0) {
    waypoint.radius = Math.min(2000, Math.max(0, raw.radius));
  }
  if (raw.mode === 'arc' || raw.mode === 'corner') {
    waypoint.mode = raw.mode;
  }
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
      if (Array.isArray(section.parallelOrder)) {
        const seen = new Set<string>();
        const order = section.parallelOrder
          .filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item: string) => item.trim())
          .filter((id: string) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .slice(0, 16);
        if (order.length >= 2) normalized.parallelOrder = order;
      }
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

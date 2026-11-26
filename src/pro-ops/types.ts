// 专业运营模式（Pro Operations Mode）独立数据类型与防御性归一化。
// 架构铁律：单向只读引用核心绘制图（Line / Station / Section 的 ID），
// 绝不向 src/types/index.ts 核心三元组注入任何字段。

export type ProRollingStockCode = '4B' | '6B' | '6A' | '8A' | '4D' | '8D' | 'custom';

export type ProServiceCategory =
  | 'local'
  | 'express'
  | 'rapid'
  | 'nonstop'
  | 'short_turn'
  | 'through';

export interface ProScaleConfig {
  /** 纯画布 / 轻城市模式下：1 个世界坐标单位对应多少米（默认 25，即 40px = 1km） */
  metersPerUnit: number;
  /** 地理底图模式下且具备经纬度时，优先采用 WGS84 测地线真实距离 */
  useGeoDistanceWhenAvailable: boolean;
}

export interface ProLineSpec {
  rollingStock: ProRollingStockCode;
  /** 单列额定载客量（人/列） */
  carCapacity: number;
  /** 线路最高运营时速（km/h） */
  maxSpeedKmh: number;
  /** 起步平均加速度（m/s²） */
  accelMps2: number;
  /** 进站平均制动减速度（m/s²） */
  decelMps2: number;
  /** 终点折返标准时间（秒） */
  turnbackSec: number;
  /** 信号系统最小追踪安全间隔（秒，默认 120s = 2分钟追踪，上限 30对/h） */
  minHeadwaySec?: number;
}

export interface ProStationProfile {
  /** 是否具备折返配线（区间小交路起终点依据） */
  hasTurnback?: boolean;
  /** 是否具备越行线/四线待避能力（Phase 2 快慢车越行与站内限速依据） */
  hasPassingTrack?: boolean;
  /** 停站时间覆盖（秒；未指定时普通站 30s、换乘站 45s） */
  dwellSec?: number;
  /** 越站通过限速覆盖（km/h；未指定时不额外压速，受区间与线路最高速约束） */
  passSpeedLimitKmh?: number;
  /** 预留 Phase 3：早高峰发生权重（0~100） */
  productionWeight?: number;
  /** 预留 Phase 3：早高峰吸引权重（0~100） */
  attractionWeight?: number;
}

export interface ProSectionOverride {
  /** 手工覆写区间长度（米） */
  distanceMetersOverride?: number;
  /** 区间限速（km/h，如小半径曲线/跨江桥隧限速） */
  speedLimitKmh?: number;
}

/**
 * 显式跨线物理轨行连接（道岔 / 联络线）。
 * 铁律：两条线路共享换乘站（乘客换乘）绝不等于列车可直接跨线，
 * 必须存在显式的 ProTrackConnection 才能编排跨线直通交路。
 */
export interface ProTrackConnection {
  id: string;
  name: string;
  /** same_station_junction: 同站跨线道岔；inter_station_link: 异站联络线 */
  kind: 'same_station_junction' | 'inter_station_link';
  fromLineId: string;
  fromStationId: string;
  toLineId: string;
  toStationId: string;
  fromStationNameHint?: string;
  toStationNameHint?: string;
  /** 道岔或联络线长度（米；同站道岔默认 180m，异站联络线默认按几何距离初始化） */
  distanceMeters: number;
  /** 道岔侧向/联络线限速（km/h，默认 45km/h） */
  speedLimitKmh: number;
  /** 是否允许双向跨线通行 */
  bidirectional: boolean;
}

/**
 * 交路路径步：停靠策略直接绑定在「本次站点访问」上（stopAtEnd），
 * 彻底解决环线首末同站、6字线/折返线同一车站多次经过且停靠策略不同的 Key 冲突问题。
 */
export type ProRouteStep =
  | {
      kind: 'section';
      sectionId: string;
      lineId: string;
      fromStationId: string;
      toStationId: string;
      fromStationNameHint?: string;
      toStationNameHint?: string;
      /** 本步到达 toStationId 时是否停靠载客（false 为越站通过） */
      stopAtEnd: boolean;
      dwellSecOverride?: number;
    }
  | {
      kind: 'connection';
      connectionId: string;
      fromLineId: string;
      fromStationId: string;
      toLineId: string;
      toStationId: string;
      fromStationNameHint?: string;
      toStationNameHint?: string;
      /** 异站联络线到达对端车站时是否停靠（同站道岔与前一步共享同一车站访问，不重复计停站） */
      stopAtEnd: boolean;
      dwellSecOverride?: number;
    };

export interface ProServicePattern {
  id: string;
  name: string;
  /** 种别简称，如 "普通" / "快车" / "直达" / "区间" / "跨线" */
  code: string;
  color: string;
  category: ProServiceCategory;
  /** 始发站是否停靠载客（默认 true） */
  stopAtStart: boolean;
  startDwellSecOverride?: number;
  routeSteps: ProRouteStep[];
  /** 高峰发车间隔（秒，如 240 = 4分钟一班） */
  headwaySec: number;
  /** 首班发车错峰相位偏移（秒，默认 0，用于快慢车错峰避让） */
  firstDepartureOffsetSec?: number;
  /** 是否允许本交路列车在越行站自动延长停站待避后方快车（普通车/区间车默认 true） */
  autoOvertake?: boolean;
  /** 是否双向对称开行（用于周转配车测算与双向上下行铺画） */
  bidirectional: boolean;
}

export interface ProTimetableConfig {
  /** 运行图铺画时间窗起点（距 00:00 的分钟数，默认 420 = 07:00） */
  windowStartMin: number;
  /** 运行图铺画窗口时长（分钟，默认 60 分钟） */
  windowDurationMin: number;
  /** 全局默认最小追踪安全间隔（秒，默认 120s） */
  defaultMinHeadwaySec: number;
}

/**
 * Phase 2 运行图（Marey Chart）与一维导乘走廊轴约定：
 * 纵轴/横轴固定锚定「物理线路或共线物理走廊」，跨线交路在联络线/道岔节点切入或切出。
 */
export interface ProCorridorAxis {
  id: string;
  name: string;
  lineIds: string[];
}

export interface ProOpsDocument {
  schemaVersion: 1;
  scaleConfig: ProScaleConfig;
  lineSpecs: Record<string, ProLineSpec>;
  stationProfiles: Record<string, ProStationProfile>;
  sectionOverrides: Record<string, ProSectionOverride>;
  trackConnections: ProTrackConnection[];
  /**
   * 显式声明「共线共轨运行」的线路对（格式："minLineId::maxLineId"）。
   * 默认空数组：两条线路即便在相邻两站间平行经过，也视为「各自独立双隧」，互不混入对方运行图与追踪冲突检算；
   * 仅当在此声明为共线共轨（或列车通过跨线道岔实际驶入对方物理区间）时，才合并进入同一张运行图并联合检算追踪间隔。
   */
  sharedTrackLinePairs?: string[];
  servicePatterns: ProServicePattern[];
  timetableConfig?: ProTimetableConfig;
}

export interface ProValidationIssue {
  stepIndex: number;
  code: 'missing_section' | 'missing_connection' | 'missing_station' | 'discontinuity';
  message: string;
}

export interface ProServiceValidation {
  patternId: string;
  status: 'valid' | 'broken';
  issues: ProValidationIssue[];
  healedSplitCount: number;
}

export const ROLLING_STOCK_PRESETS: Record<
  Exclude<ProRollingStockCode, 'custom'>,
  Omit<ProLineSpec, 'rollingStock'> & { label: string }
> = {
  '4B': {
    label: '4B（轻轨/中运量 4编B型）',
    carCapacity: 960,
    maxSpeedKmh: 80,
    accelMps2: 1.0,
    decelMps2: 1.1,
    turnbackSec: 120
  },
  '6B': {
    label: '6B（标准地铁 6编B型）',
    carCapacity: 1460,
    maxSpeedKmh: 80,
    accelMps2: 1.0,
    decelMps2: 1.1,
    turnbackSec: 140
  },
  '6A': {
    label: '6A（大运量干线 6编A型）',
    carCapacity: 1860,
    maxSpeedKmh: 100,
    accelMps2: 0.95,
    decelMps2: 1.1,
    turnbackSec: 150
  },
  '8A': {
    label: '8A（超大运量 8编A型）',
    carCapacity: 2480,
    maxSpeedKmh: 100,
    accelMps2: 0.9,
    decelMps2: 1.05,
    turnbackSec: 165
  },
  '4D': {
    label: '4D（市域快线 4编市域D型）',
    carCapacity: 980,
    maxSpeedKmh: 160,
    accelMps2: 0.85,
    decelMps2: 1.0,
    turnbackSec: 180
  },
  '8D': {
    label: '8D（市域快线 8编市域D型）',
    carCapacity: 1960,
    maxSpeedKmh: 160,
    accelMps2: 0.85,
    decelMps2: 1.0,
    turnbackSec: 195
  }
};

export const DEFAULT_PRO_SCALE_CONFIG: ProScaleConfig = {
  metersPerUnit: 25,
  useGeoDistanceWhenAvailable: true
};

export const DEFAULT_PRO_TIMETABLE_CONFIG: ProTimetableConfig = {
  windowStartMin: 420,
  windowDurationMin: 60,
  defaultMinHeadwaySec: 120
};

export function createDefaultLineSpec(code: ProRollingStockCode = '6B'): ProLineSpec {
  if (code === 'custom') {
    return {
      rollingStock: 'custom',
      carCapacity: 1460,
      maxSpeedKmh: 100,
      accelMps2: 1.0,
      decelMps2: 1.1,
      turnbackSec: 150,
      minHeadwaySec: 120
    };
  }
  const preset = ROLLING_STOCK_PRESETS[code];
  return {
    rollingStock: code,
    carCapacity: preset.carCapacity,
    maxSpeedKmh: preset.maxSpeedKmh,
    accelMps2: preset.accelMps2,
    decelMps2: preset.decelMps2,
    turnbackSec: preset.turnbackSec,
    minHeadwaySec: 120
  };
}

export function makeCanonicalLinePairKey(lineAId: string, lineBId: string): string {
  return lineAId < lineBId ? `${lineAId}::${lineBId}` : `${lineBId}::${lineAId}`;
}

export function createEmptyProOpsDocument(): ProOpsDocument {
  return {
    schemaVersion: 1,
    scaleConfig: { ...DEFAULT_PRO_SCALE_CONFIG },
    lineSpecs: {},
    stationProfiles: {},
    sectionOverrides: {},
    trackConnections: [],
    sharedTrackLinePairs: [],
    servicePatterns: [],
    timetableConfig: { ...DEFAULT_PRO_TIMETABLE_CONFIG }
  };
}

export function hasMeaningfulProOps(doc?: ProOpsDocument | null): boolean {
  if (!doc) return false;
  return (
    doc.servicePatterns.length > 0 ||
    doc.trackConnections.length > 0 ||
    (doc.sharedTrackLinePairs?.length || 0) > 0 ||
    Object.keys(doc.lineSpecs).length > 0 ||
    Object.keys(doc.stationProfiles).length > 0 ||
    Object.keys(doc.sectionOverrides).length > 0 ||
    Math.abs(doc.scaleConfig.metersPerUnit - DEFAULT_PRO_SCALE_CONFIG.metersPerUnit) > 1e-3 ||
    doc.scaleConfig.useGeoDistanceWhenAvailable !== DEFAULT_PRO_SCALE_CONFIG.useGeoDistanceWhenAvailable
  );
}

const clampNum = (val: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.max(min, Math.min(max, n));
};

const cleanStr = (val: unknown, maxLen = 96): string =>
  typeof val === 'string' ? val.trim().slice(0, maxLen) : '';

export function normalizeProOpsDocument(raw: unknown): ProOpsDocument | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, any>;

  const rawScale = src.scaleConfig && typeof src.scaleConfig === 'object' ? src.scaleConfig : {};
  const scaleConfig: ProScaleConfig = {
    metersPerUnit: Math.round(clampNum(rawScale.metersPerUnit, DEFAULT_PRO_SCALE_CONFIG.metersPerUnit, 0, 10000) * 100) / 100,
    useGeoDistanceWhenAvailable: rawScale.useGeoDistanceWhenAvailable !== false
  };

  const validStocks: ProRollingStockCode[] = ['4B', '6B', '6A', '8A', '4D', '8D', 'custom'];
  const lineSpecs: Record<string, ProLineSpec> = {};
  if (src.lineSpecs && typeof src.lineSpecs === 'object' && !Array.isArray(src.lineSpecs)) {
    Object.entries(src.lineSpecs).slice(0, 200).forEach(([lineId, item]: [string, any]) => {
      const key = cleanStr(lineId, 96);
      if (!key || !item || typeof item !== 'object') return;
      const rollingStock: ProRollingStockCode = validStocks.includes(item.rollingStock)
        ? item.rollingStock
        : '6B';
      const fallback = createDefaultLineSpec(rollingStock);
      lineSpecs[key] = {
        rollingStock,
        carCapacity: Math.round(clampNum(item.carCapacity, fallback.carCapacity, 100, 5000)),
        maxSpeedKmh: Math.round(clampNum(item.maxSpeedKmh, fallback.maxSpeedKmh, 25, 350)),
        accelMps2: Math.round(clampNum(item.accelMps2, fallback.accelMps2, 0.2, 2.5) * 100) / 100,
        decelMps2: Math.round(clampNum(item.decelMps2, fallback.decelMps2, 0.2, 2.5) * 100) / 100,
        turnbackSec: Math.round(clampNum(item.turnbackSec, fallback.turnbackSec, 30, 900)),
        minHeadwaySec: Math.round(clampNum(item.minHeadwaySec, 120, 45, 900))
      };
    });
  }

  const stationProfiles: Record<string, ProStationProfile> = {};
  if (src.stationProfiles && typeof src.stationProfiles === 'object' && !Array.isArray(src.stationProfiles)) {
    Object.entries(src.stationProfiles).slice(0, 2000).forEach(([stationId, item]: [string, any]) => {
      const key = cleanStr(stationId, 96);
      if (!key || !item || typeof item !== 'object') return;
      const prof: ProStationProfile = {};
      if (typeof item.hasTurnback === 'boolean') prof.hasTurnback = item.hasTurnback;
      if (typeof item.hasPassingTrack === 'boolean') prof.hasPassingTrack = item.hasPassingTrack;
      if (typeof item.dwellSec === 'number' && Number.isFinite(item.dwellSec)) {
        prof.dwellSec = Math.round(clampNum(item.dwellSec, 30, 5, 600));
      }
      if (typeof item.passSpeedLimitKmh === 'number' && Number.isFinite(item.passSpeedLimitKmh)) {
        prof.passSpeedLimitKmh = Math.round(clampNum(item.passSpeedLimitKmh, 80, 15, 350));
      }
      if (typeof item.productionWeight === 'number' && Number.isFinite(item.productionWeight)) {
        prof.productionWeight = Math.round(clampNum(item.productionWeight, 50, 0, 500));
      }
      if (typeof item.attractionWeight === 'number' && Number.isFinite(item.attractionWeight)) {
        prof.attractionWeight = Math.round(clampNum(item.attractionWeight, 50, 0, 500));
      }
      if (Object.keys(prof).length > 0) {
        stationProfiles[key] = prof;
      }
    });
  }

  const sectionOverrides: Record<string, ProSectionOverride> = {};
  if (src.sectionOverrides && typeof src.sectionOverrides === 'object' && !Array.isArray(src.sectionOverrides)) {
    Object.entries(src.sectionOverrides).slice(0, 3000).forEach(([sectionId, item]: [string, any]) => {
      const key = cleanStr(sectionId, 96);
      if (!key || !item || typeof item !== 'object') return;
      const ov: ProSectionOverride = {};
      if (typeof item.distanceMetersOverride === 'number' && Number.isFinite(item.distanceMetersOverride)) {
        ov.distanceMetersOverride = Math.round(clampNum(item.distanceMetersOverride, 1000, 20, 200000));
      }
      if (typeof item.speedLimitKmh === 'number' && Number.isFinite(item.speedLimitKmh)) {
        ov.speedLimitKmh = Math.round(clampNum(item.speedLimitKmh, 80, 15, 350));
      }
      if (Object.keys(ov).length > 0) {
        sectionOverrides[key] = ov;
      }
    });
  }

  const usedConnIds = new Set<string>();
  const trackConnections: ProTrackConnection[] = [];
  if (Array.isArray(src.trackConnections)) {
    src.trackConnections.slice(0, 300).forEach((item: any, idx: number) => {
      if (!item || typeof item !== 'object') return;
      const fromLineId = cleanStr(item.fromLineId, 96);
      const fromStationId = cleanStr(item.fromStationId, 96);
      const toLineId = cleanStr(item.toLineId, 96);
      const toStationId = cleanStr(item.toStationId, 96);
      if (!fromLineId || !fromStationId || !toLineId || !toStationId) return;
      let id = cleanStr(item.id, 96) || `conn_${idx + 1}`;
      while (usedConnIds.has(id)) id += '_c';
      usedConnIds.add(id);
      const kind: ProTrackConnection['kind'] =
        item.kind === 'inter_station_link' || fromStationId !== toStationId
          ? 'inter_station_link'
          : 'same_station_junction';
      const fromStationNameHint = cleanStr(item.fromStationNameHint, 64);
      const toStationNameHint = cleanStr(item.toStationNameHint, 64);
      trackConnections.push({
        id,
        name: cleanStr(item.name, 64) || (kind === 'same_station_junction' ? '同站跨线道岔' : '跨线联络线'),
        kind,
        fromLineId,
        fromStationId,
        toLineId,
        toStationId,
        ...(fromStationNameHint ? { fromStationNameHint } : {}),
        ...(toStationNameHint ? { toStationNameHint } : {}),
        distanceMeters: Math.round(clampNum(item.distanceMeters, kind === 'same_station_junction' ? 180 : 650, 10, 50000)),
        speedLimitKmh: Math.round(clampNum(item.speedLimitKmh, 45, 15, 200)),
        bidirectional: item.bidirectional !== false
      });
    });
  }

  const validCategories: ProServiceCategory[] = ['local', 'express', 'rapid', 'nonstop', 'short_turn', 'through'];
  const usedSvcIds = new Set<string>();
  const servicePatterns: ProServicePattern[] = [];
  if (Array.isArray(src.servicePatterns)) {
    src.servicePatterns.slice(0, 200).forEach((item: any, idx: number) => {
      if (!item || typeof item !== 'object' || !Array.isArray(item.routeSteps)) return;
      let id = cleanStr(item.id, 96) || `svc_${idx + 1}`;
      while (usedSvcIds.has(id)) id += '_c';
      usedSvcIds.add(id);

      const routeSteps: ProRouteStep[] = [];
      item.routeSteps.slice(0, 600).forEach((step: any) => {
        if (!step || typeof step !== 'object') return;
        const fromHint = cleanStr(step.fromStationNameHint, 64);
        const toHint = cleanStr(step.toStationNameHint, 64);
        const dwellOverride =
          typeof step.dwellSecOverride === 'number' && Number.isFinite(step.dwellSecOverride)
            ? Math.round(clampNum(step.dwellSecOverride, 30, 5, 600))
            : undefined;
        if (step.kind === 'connection') {
          const connectionId = cleanStr(step.connectionId, 96);
          const fromLineId = cleanStr(step.fromLineId, 96);
          const fromStationId = cleanStr(step.fromStationId, 96);
          const toLineId = cleanStr(step.toLineId, 96);
          const toStationId = cleanStr(step.toStationId, 96);
          if (!connectionId || !fromLineId || !fromStationId || !toLineId || !toStationId) return;
          routeSteps.push({
            kind: 'connection',
            connectionId,
            fromLineId,
            fromStationId,
            toLineId,
            toStationId,
            ...(fromHint ? { fromStationNameHint: fromHint } : {}),
            ...(toHint ? { toStationNameHint: toHint } : {}),
            stopAtEnd: step.stopAtEnd !== false,
            ...(dwellOverride !== undefined ? { dwellSecOverride: dwellOverride } : {})
          });
        } else {
          const sectionId = cleanStr(step.sectionId, 96);
          const lineId = cleanStr(step.lineId, 96);
          const fromStationId = cleanStr(step.fromStationId, 96);
          const toStationId = cleanStr(step.toStationId, 96);
          if (!sectionId || !lineId || !fromStationId || !toStationId) return;
          routeSteps.push({
            kind: 'section',
            sectionId,
            lineId,
            fromStationId,
            toStationId,
            ...(fromHint ? { fromStationNameHint: fromHint } : {}),
            ...(toHint ? { toStationNameHint: toHint } : {}),
            stopAtEnd: step.stopAtEnd !== false,
            ...(dwellOverride !== undefined ? { dwellSecOverride: dwellOverride } : {})
          });
        }
      });

      const category: ProServiceCategory = validCategories.includes(item.category) ? item.category : 'local';
      const colorRaw = cleanStr(item.color, 24);
      const color = /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw : '#2563eb';
      const startDwell =
        typeof item.startDwellSecOverride === 'number' && Number.isFinite(item.startDwellSecOverride)
          ? Math.round(clampNum(item.startDwellSecOverride, 30, 5, 600))
          : undefined;

      const defaultAutoOvertake = category === 'local' || category === 'short_turn';
      servicePatterns.push({
        id,
        name: cleanStr(item.name, 64) || `运行交路 ${idx + 1}`,
        code: cleanStr(item.code, 16) || (category === 'express' ? '快车' : '普通'),
        color,
        category,
        stopAtStart: item.stopAtStart !== false,
        ...(startDwell !== undefined ? { startDwellSecOverride: startDwell } : {}),
        routeSteps,
        headwaySec: Math.round(clampNum(item.headwaySec, 240, 60, 7200)),
        firstDepartureOffsetSec: Math.round(clampNum(item.firstDepartureOffsetSec, 0, 0, 7199)),
        autoOvertake: typeof item.autoOvertake === 'boolean' ? item.autoOvertake : defaultAutoOvertake,
        bidirectional: item.bidirectional !== false
      });
    });
  }

  const sharedTrackSet = new Set<string>();
  if (Array.isArray(src.sharedTrackLinePairs)) {
    src.sharedTrackLinePairs.slice(0, 300).forEach((rawPair: unknown) => {
      if (typeof rawPair !== 'string') return;
      const parts = rawPair.split('::').map((s) => cleanStr(s, 96));
      if (parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1]) {
        sharedTrackSet.add(makeCanonicalLinePairKey(parts[0], parts[1]));
      }
    });
  }
  const sharedTrackLinePairs = Array.from(sharedTrackSet);

  const rawTt = src.timetableConfig && typeof src.timetableConfig === 'object' ? src.timetableConfig : {};
  const timetableConfig: ProTimetableConfig = {
    windowStartMin: Math.round(clampNum(rawTt.windowStartMin, DEFAULT_PRO_TIMETABLE_CONFIG.windowStartMin, 0, 1380)),
    windowDurationMin: Math.round(clampNum(rawTt.windowDurationMin, DEFAULT_PRO_TIMETABLE_CONFIG.windowDurationMin, 15, 240)),
    defaultMinHeadwaySec: Math.round(clampNum(rawTt.defaultMinHeadwaySec, DEFAULT_PRO_TIMETABLE_CONFIG.defaultMinHeadwaySec, 45, 900))
  };

  return {
    schemaVersion: 1,
    scaleConfig,
    lineSpecs,
    stationProfiles,
    sectionOverrides,
    trackConnections,
    sharedTrackLinePairs,
    servicePatterns,
    timetableConfig
  };
}

export function cloneProOpsDocument(doc: ProOpsDocument): ProOpsDocument {
  return {
    schemaVersion: 1,
    scaleConfig: { ...doc.scaleConfig },
    lineSpecs: Object.fromEntries(Object.entries(doc.lineSpecs).map(([k, v]) => [k, { ...v }])),
    stationProfiles: Object.fromEntries(Object.entries(doc.stationProfiles).map(([k, v]) => [k, { ...v }])),
    sectionOverrides: Object.fromEntries(Object.entries(doc.sectionOverrides).map(([k, v]) => [k, { ...v }])),
    trackConnections: doc.trackConnections.map((c) => ({ ...c })),
    sharedTrackLinePairs: [...(doc.sharedTrackLinePairs || [])],
    servicePatterns: doc.servicePatterns.map((p) => ({
      ...p,
      routeSteps: p.routeSteps.map((s) => ({ ...s }))
    })),
    timetableConfig: doc.timetableConfig ? { ...doc.timetableConfig } : { ...DEFAULT_PRO_TIMETABLE_CONFIG }
  };
}

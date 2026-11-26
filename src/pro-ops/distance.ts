import { Section, Station } from '../types';
import { MapGraph } from '../lib/graphOps';
import { ProOpsDocument, ProScaleConfig, ProSectionOverride } from './types';

const EARTH_RADIUS_METERS = 6371008.8;

export function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_METERS * c;
}

export type DistanceSource = 'override' | 'geo' | 'canvas_scale';

export interface MeasuredSectionDistance {
  meters: number;
  source: DistanceSource;
}

const hasGeo = (pt?: { lng?: number; lat?: number } | null): pt is { lng: number; lat: number } =>
  Boolean(pt && typeof pt.lng === 'number' && Number.isFinite(pt.lng) && typeof pt.lat === 'number' && Number.isFinite(pt.lat));

/**
 * 测量单个物理区间的轨道长度（米）：
 * 1. 若有手工覆写值，优先采用覆写值；
 * 2. 若处于地理底图模式且具备完整经纬度，沿起点 -> 途经点 -> 终点累加 WGS84 测地线长度；
 * 3. 否则沿世界坐标折线长度 × metersPerUnit 换算。
 */
export function measureSectionDistance(
  section: Section,
  stationMap: ReadonlyMap<string, Station>,
  scaleConfig: ProScaleConfig,
  sectionOverrides: Readonly<Record<string, ProSectionOverride>>,
  isGeoMode: boolean
): MeasuredSectionDistance {
  const override = sectionOverrides[section.id]?.distanceMetersOverride;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { meters: override, source: 'override' };
  }

  const start = stationMap.get(section.startStationId);
  const end = stationMap.get(section.endStationId);
  if (!start || !end) {
    return { meters: 1000, source: 'canvas_scale' };
  }

  const wps = section.waypoints || [];
  if (isGeoMode && scaleConfig.useGeoDistanceWhenAvailable && hasGeo(start) && hasGeo(end)) {
    const geoPoints: Array<{ lng: number; lat: number }> = [start];
    wps.forEach((wp) => {
      if (hasGeo(wp)) geoPoints.push({ lng: wp.lng, lat: wp.lat });
    });
    geoPoints.push(end);

    let totalGeo = 0;
    for (let i = 1; i < geoPoints.length; i += 1) {
      totalGeo += haversineMeters(
        geoPoints[i - 1].lng,
        geoPoints[i - 1].lat,
        geoPoints[i].lng,
        geoPoints[i].lat
      );
    }
    return { meters: Math.max(30, Math.round(totalGeo)), source: 'geo' };
  }

  const pts: Array<{ x: number; y: number }> = [start, ...wps, end];
  let worldLen = 0;
  for (let i = 1; i < pts.length; i += 1) {
    worldLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (scaleConfig.metersPerUnit <= 0) {
    return { meters: 0, source: 'canvas_scale' };
  }
  const meters = Math.max(1, Math.round(worldLen * scaleConfig.metersPerUnit));
  return { meters, source: 'canvas_scale' };
}

/**
 * 两点标尺校准：给定两个车站的世界坐标与用户输入的真实直线（或区间）距离，反推 metersPerUnit。
 */
export function calibrateMetersPerUnitBetweenPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  realDistanceMeters: number
): number | null {
  const worldDist = Math.hypot(b.x - a.x, b.y - a.y);
  if (!Number.isFinite(worldDist) || worldDist < 1e-3 || !Number.isFinite(realDistanceMeters) || realDistanceMeters <= 0) {
    return null;
  }
  const raw = realDistanceMeters / worldDist;
  return Math.max(0.2, Math.min(10000, Math.round(raw * 100) / 100));
}

export interface LineMileageSummary {
  lineId: string;
  lineName: string;
  color: string;
  lengthKm: number;
  stationCount: number;
  sectionCount: number;
}

export function computeNetworkMileageSummary(
  graph: MapGraph,
  proOps: ProOpsDocument,
  isGeoMode: boolean
): { totalLineKm: number; lines: LineMileageSummary[] } {
  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const sectionsByLine = new Map<string, Section[]>();
  graph.sections.forEach((sec) => {
    const list = sectionsByLine.get(sec.lineId);
    if (list) list.push(sec);
    else sectionsByLine.set(sec.lineId, [sec]);
  });

  let totalMeters = 0;
  const lines: LineMileageSummary[] = graph.lines.map((line) => {
    const secs = sectionsByLine.get(line.id) || [];
    let lineMeters = 0;
    secs.forEach((sec) => {
      lineMeters += measureSectionDistance(
        sec,
        stationMap,
        proOps.scaleConfig,
        proOps.sectionOverrides,
        isGeoMode
      ).meters;
    });
    totalMeters += lineMeters;
    return {
      lineId: line.id,
      lineName: line.name,
      color: line.color,
      lengthKm: Math.round((lineMeters / 1000) * 100) / 100,
      stationCount: line.stationIds.length,
      sectionCount: secs.length
    };
  });

  return {
    totalLineKm: Math.round((totalMeters / 1000) * 100) / 100,
    lines
  };
}

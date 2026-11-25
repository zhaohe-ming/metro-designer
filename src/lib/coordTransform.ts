import { MapSettings, Section, Station } from '../types';

const PI = Math.PI;
const AXIS = 6378245.0;
const EE = 0.00669342162296594323;

/**
 * 判断经纬度是否位于中国大陆及周边需要 GCJ-02 偏移处理的矩形范围内。
 * 海外坐标（港澳台及境外）本身即为 WGS-84，不做偏移。
 */
export function isInsideChinaMainlandBounds(lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

function computeGcjDelta(lng: number, lat: number): [number, number] {
  const dLat = transformLat(lng - 105.0, lat - 35.0);
  const dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const deltaLat = (dLat * 180.0) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI);
  const deltaLng = (dLng * 180.0) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
  return [deltaLng, deltaLat];
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (!isInsideChinaMainlandBounds(lng, lat)) return [lng, lat];
  const [dLng, dLat] = computeGcjDelta(lng, lat);
  return [Number((lng + dLng).toFixed(6)), Number((lat + dLat).toFixed(6))];
}

/**
 * 精确不动点迭代法将旧版高德 GCJ-02 火星坐标无损还原为国际标准 WGS-84 坐标（误差 < 0.05 米）。
 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (!isInsideChinaMainlandBounds(lng, lat)) return [lng, lat];
  let wgsLng = lng;
  let wgsLat = lat;
  for (let i = 0; i < 3; i += 1) {
    const [dLng, dLat] = computeGcjDelta(wgsLng, wgsLat);
    wgsLng = lng - dLng;
    wgsLat = lat - dLat;
  }
  return [Number(wgsLng.toFixed(6)), Number(wgsLat.toFixed(6))];
}

/**
 * 若旧版存档采用高德底图且尚未标记为 wgs84，则在加载时一次性将中心点、车站与途经点经纬度
 * 从 GCJ-02 自动纠偏为 WGS-84，并写入 coordSystem: 'wgs84' 防止重复转换。
 */
export function migrateLegacyGcj02MapToWgs84(input: {
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
}): {
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  migrated: boolean;
} {
  const { stations, sections, mapSettings } = input;
  const amap = mapSettings?.baseMap?.amap;
  const isLegacyGcj =
    mapSettings?.baseMap?.mode === 'amap' && amap?.coordSystem !== 'wgs84';

  if (!isLegacyGcj) {
    return { stations, sections, mapSettings, migrated: false };
  }

  const nextCenter = amap?.center
    ? gcj02ToWgs84(amap.center[0], amap.center[1])
    : ([116.391276, 39.907335] as [number, number]);

  const nextStations = stations.map((station) => {
    if (typeof station.lng === 'number' && typeof station.lat === 'number') {
      const [lng, lat] = gcj02ToWgs84(station.lng, station.lat);
      return { ...station, lng, lat };
    }
    return station;
  });

  const nextSections = sections.map((section) => {
    if (!section.waypoints?.length) return section;
    const nextWaypoints = section.waypoints.map((wp) => {
      if (typeof wp.lng === 'number' && typeof wp.lat === 'number') {
        const [lng, lat] = gcj02ToWgs84(wp.lng, wp.lat);
        return { ...wp, lng, lat };
      }
      return wp;
    });
    return { ...section, waypoints: nextWaypoints };
  });

  const nextSettings: MapSettings = {
    ...mapSettings,
    baseMap: {
      ...mapSettings.baseMap,
      amap: {
        center: nextCenter,
        zoom: amap?.zoom ?? 11,
        style: amap?.style ?? 'normal',
        coordSystem: 'wgs84'
      }
    }
  };

  return {
    stations: nextStations,
    sections: nextSections,
    mapSettings: nextSettings,
    migrated: true
  };
}

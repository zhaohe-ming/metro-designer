const DEFAULT_MAP_SETTINGS = {
  // 与前端 src/types/index.ts 保持一致：全部创作统一采用 dot-label（专业线网）模式
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
  labelDensity: 'paper',
  cornerRadius: 0,
  hideWaypoints: false
};

const roundCoord = (n) => Math.round(n * 10) / 10;

function normalizeLightCityPoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? roundCoord(raw.x) : null;
  const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? roundCoord(raw.y) : null;
  if (x === null || y === null) return null;
  return { x, y };
}

function normalizeLightCitySettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const archetypes = ['london', 'river', 'confluence', 'bay', 'ring', 'delta', 'lake', 'custom'];
  const archetype = archetypes.includes(raw.archetype) ? raw.archetype : 'river';
  const seed = Math.max(1, Math.min(999999999, Math.round(Number(raw.seed) || 1024)));
  const opacity = Math.round(normalizeNumber(raw.opacity, 1, 0.25, 1) * 100) / 100;
  const lv = raw.layerVisibility && typeof raw.layerVisibility === 'object' ? raw.layerVisibility : {};
  const layerVisibility = {
    zones: lv.zones !== false,
    water: lv.water !== false,
    roads: lv.roads !== false,
    labels: lv.labels !== false
  };

  const usedIds = new Set();
  const rawFeatures = Array.isArray(raw.features) ? raw.features.slice(0, 2500) : [];
  const features = [];

  rawFeatures.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 64) : `lc_${idx + 1}`;
    while (usedIds.has(id)) id += '_c';
    usedIds.add(id);

    if (item.type === 'label') {
      const x = typeof item.x === 'number' && Number.isFinite(item.x) ? roundCoord(item.x) : null;
      const y = typeof item.y === 'number' && Number.isFinite(item.y) ? roundCoord(item.y) : null;
      const text = typeof item.text === 'string' ? item.text.trim().slice(0, 32) : '';
      if (x === null || y === null || !text) return;
      const kind = item.kind === 'subdistrict' || item.kind === 'water' ? item.kind : 'district';
      features.push({ id, type: 'label', kind, x, y, text });
      return;
    }

    const pts = (Array.isArray(item.points) ? item.points.slice(0, 400) : [])
      .map(normalizeLightCityPoint)
      .filter(Boolean);

    if (item.type === 'zone') {
      if (pts.length < 3) return;
      const kind = item.kind === 'park' || item.kind === 'island' ? item.kind : 'urban';
      features.push({ id, type: 'zone', kind, points: pts });
    } else if (item.type === 'waterArea') {
      if (pts.length < 3) return;
      features.push({ id, type: 'waterArea', points: pts });
    } else if (item.type === 'river') {
      if (pts.length < 2) return;
      const width = Math.round(normalizeNumber(item.width, 56, 3, 220) * 10) / 10;
      features.push({ id, type: 'river', width, points: pts });
    } else if (item.type === 'road') {
      if (pts.length < 2) return;
      const kind = item.kind === 'express' ? 'express' : item.kind === 'street' ? 'street' : 'arterial';
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
}


function normalizeNumber(value, fallback, min, max) {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numberValue));
}

function normalizeVideoExportConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const usedIds = new Set();
  const segments = (Array.isArray(raw.segments) ? raw.segments : [])
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
  const aspectRatio = ['16:9', '9:16', '4:3', '1:1'].includes(raw.aspectRatio) ? raw.aspectRatio : undefined;
  const resolution = ['1080p', '720p'].includes(raw.resolution) ? raw.resolution : undefined;
  const fps = raw.fps === 30 || raw.fps === 60 ? raw.fps : undefined;
  const speedMultiplier = [0.75, 1, 1.5, 2].includes(raw.speedMultiplier) ? raw.speedMultiplier : undefined;
  const cameraMode = ['overview', 'gentle', 'follow'].includes(raw.cameraMode) ? raw.cameraMode : undefined;
  const unopenedStyle = ['ghost', 'hidden'].includes(raw.unopenedStyle) ? raw.unopenedStyle : undefined;
  const dateMode = ['date', 'sequence'].includes(raw.dateMode) ? raw.dateMode : undefined;

  return {
    segments,
    title: text(raw.title, 32),
    subtitle: text(raw.subtitle, 48),
    titleDurationSec: normalizeNumber(raw.titleDurationSec, 3, 1, 8),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(fps ? { fps } : {}),
    ...(speedMultiplier ? { speedMultiplier } : {}),
    ...(cameraMode ? { cameraMode } : {}),
    ...(unopenedStyle ? { unopenedStyle } : {}),
    ...(dateMode ? { dateMode } : {}),
    ...(typeof raw.showYearBadge === 'boolean' ? { showYearBadge: raw.showYearBadge } : {}),
    ...(typeof raw.showLineLegend === 'boolean' ? { showLineLegend: raw.showLineLegend } : {})
  };
}

function normalizeMapSettings(settings) {
  const dotLabelStyle = settings && settings.dotLabelStyle ? settings.dotLabelStyle : {};
  const baseMap = settings && settings.baseMap ? settings.baseMap : {};
  const amap = baseMap && baseMap.amap ? baseMap.amap : {};
  return {
    mapStyle: 'dot-label',
    canvasTheme: settings && settings.canvasTheme === 'dark' ? 'dark' : 'light',
    cityStyle:
      settings && ['standard', 'beijing', 'shanghai', 'mtr'].includes(settings.cityStyle)
        ? settings.cityStyle
        : 'standard',
    showLineNameLabels: !settings || settings.showLineNameLabels !== false,
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
            : DEFAULT_MAP_SETTINGS.baseMap.amap.center,
        zoom: normalizeNumber(amap.zoom, DEFAULT_MAP_SETTINGS.baseMap.amap.zoom, 3, 20),
        style: ['dark', 'grey', 'fresh'].includes(amap.style) ? amap.style : 'normal',
        ...(amap.coordSystem === 'wgs84' || amap.coordSystem === 'gcj02'
          ? { coordSystem: amap.coordSystem }
          : baseMap.mode !== 'amap'
            ? { coordSystem: 'wgs84' }
            : {})
      },
      ...(baseMap.lightCity ? { lightCity: normalizeLightCitySettings(baseMap.lightCity) } : {})
    },
    labelDensity: settings && ['adaptive', 'key'].includes(settings.labelDensity) ? settings.labelDensity : 'paper',
    cornerRadius: normalizeNumber(settings && settings.cornerRadius, DEFAULT_MAP_SETTINGS.cornerRadius, 0, 40),
    hideWaypoints: Boolean(settings && settings.hideWaypoints === true),
    ...(settings && settings.lockLineNameLabels === true ? { lockLineNameLabels: true } : {}),
    ...(settings && settings.videoExport ? { videoExport: normalizeVideoExportConfig(settings.videoExport) } : {})
  };
}


module.exports = { DEFAULT_MAP_SETTINGS, normalizeMapSettings, normalizeVideoExportConfig };

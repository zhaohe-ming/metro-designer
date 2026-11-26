// 后端专用：专业运营旁路数据（map_pro_ops）轻量防御性归一化。
// 与普通地图视觉配置（server/lib/mapSettings.js）完全物理隔离。

const DEFAULT_SCALE_CONFIG = {
  metersPerUnit: 25,
  useGeoDistanceWhenAvailable: true
};

const VALID_STOCKS = ['4B', '6B', '6A', '8A', '4D', '8D', 'custom'];
const VALID_CATEGORIES = ['local', 'express', 'rapid', 'nonstop', 'short_turn', 'through'];

function clampNum(val, fallback, min, max) {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanStr(val, maxLen = 96) {
  return typeof val === 'string' ? val.trim().slice(0, maxLen) : '';
}

function normalizeProOpsDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      schemaVersion: 1,
      scaleConfig: { ...DEFAULT_SCALE_CONFIG },
      lineSpecs: {},
      stationProfiles: {},
      sectionOverrides: {},
      trackConnections: [],
      servicePatterns: []
    };
  }

  const rawScale = raw.scaleConfig && typeof raw.scaleConfig === 'object' ? raw.scaleConfig : {};
  const scaleConfig = {
    metersPerUnit: Math.round(clampNum(rawScale.metersPerUnit, 25, 0, 10000) * 100) / 100,
    useGeoDistanceWhenAvailable: rawScale.useGeoDistanceWhenAvailable !== false
  };

  const lineSpecs = {};
  if (raw.lineSpecs && typeof raw.lineSpecs === 'object' && !Array.isArray(raw.lineSpecs)) {
    Object.entries(raw.lineSpecs).slice(0, 200).forEach(([lineId, item]) => {
      const key = cleanStr(lineId, 96);
      if (!key || !item || typeof item !== 'object') return;
      const rollingStock = VALID_STOCKS.includes(item.rollingStock) ? item.rollingStock : '6B';
      lineSpecs[key] = {
        rollingStock,
        carCapacity: Math.round(clampNum(item.carCapacity, 1460, 100, 5000)),
        maxSpeedKmh: Math.round(clampNum(item.maxSpeedKmh, 80, 25, 350)),
        accelMps2: Math.round(clampNum(item.accelMps2, 1.0, 0.2, 2.5) * 100) / 100,
        decelMps2: Math.round(clampNum(item.decelMps2, 1.1, 0.2, 2.5) * 100) / 100,
        turnbackSec: Math.round(clampNum(item.turnbackSec, 150, 30, 900)),
        minHeadwaySec: Math.round(clampNum(item.minHeadwaySec, 120, 45, 900))
      };
    });
  }

  const stationProfiles = {};
  if (raw.stationProfiles && typeof raw.stationProfiles === 'object' && !Array.isArray(raw.stationProfiles)) {
    Object.entries(raw.stationProfiles).slice(0, 2000).forEach(([stationId, item]) => {
      const key = cleanStr(stationId, 96);
      if (!key || !item || typeof item !== 'object') return;
      const prof = {};
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
      if (Object.keys(prof).length > 0) stationProfiles[key] = prof;
    });
  }

  const sectionOverrides = {};
  if (raw.sectionOverrides && typeof raw.sectionOverrides === 'object' && !Array.isArray(raw.sectionOverrides)) {
    Object.entries(raw.sectionOverrides).slice(0, 3000).forEach(([sectionId, item]) => {
      const key = cleanStr(sectionId, 96);
      if (!key || !item || typeof item !== 'object') return;
      const ov = {};
      if (typeof item.distanceMetersOverride === 'number' && Number.isFinite(item.distanceMetersOverride)) {
        ov.distanceMetersOverride = Math.round(clampNum(item.distanceMetersOverride, 1000, 20, 200000));
      }
      if (typeof item.speedLimitKmh === 'number' && Number.isFinite(item.speedLimitKmh)) {
        ov.speedLimitKmh = Math.round(clampNum(item.speedLimitKmh, 80, 15, 350));
      }
      if (Object.keys(ov).length > 0) sectionOverrides[key] = ov;
    });
  }

  const usedConnIds = new Set();
  const trackConnections = [];
  if (Array.isArray(raw.trackConnections)) {
    raw.trackConnections.slice(0, 300).forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      const fromLineId = cleanStr(item.fromLineId, 96);
      const fromStationId = cleanStr(item.fromStationId, 96);
      const toLineId = cleanStr(item.toLineId, 96);
      const toStationId = cleanStr(item.toStationId, 96);
      if (!fromLineId || !fromStationId || !toLineId || !toStationId) return;
      let id = cleanStr(item.id, 96) || `conn_${idx + 1}`;
      while (usedConnIds.has(id)) id += '_c';
      usedConnIds.add(id);
      const kind =
        item.kind === 'inter_station_link' || fromStationId !== toStationId
          ? 'inter_station_link'
          : 'same_station_junction';
      const fromHint = cleanStr(item.fromStationNameHint, 64);
      const toHint = cleanStr(item.toStationNameHint, 64);
      trackConnections.push({
        id,
        name: cleanStr(item.name, 64) || (kind === 'same_station_junction' ? '同站跨线道岔' : '跨线联络线'),
        kind,
        fromLineId,
        fromStationId,
        toLineId,
        toStationId,
        ...(fromHint ? { fromStationNameHint: fromHint } : {}),
        ...(toHint ? { toStationNameHint: toHint } : {}),
        distanceMeters: Math.round(clampNum(item.distanceMeters, kind === 'same_station_junction' ? 180 : 650, 10, 50000)),
        speedLimitKmh: Math.round(clampNum(item.speedLimitKmh, 45, 15, 200)),
        bidirectional: item.bidirectional !== false
      });
    });
  }

  const usedSvcIds = new Set();
  const servicePatterns = [];
  if (Array.isArray(raw.servicePatterns)) {
    raw.servicePatterns.slice(0, 200).forEach((item, idx) => {
      if (!item || typeof item !== 'object' || !Array.isArray(item.routeSteps)) return;
      let id = cleanStr(item.id, 96) || `svc_${idx + 1}`;
      while (usedSvcIds.has(id)) id += '_c';
      usedSvcIds.add(id);

      const routeSteps = [];
      item.routeSteps.slice(0, 600).forEach((step) => {
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

      const category = VALID_CATEGORIES.includes(item.category) ? item.category : 'local';
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
        code: cleanStr(item.code, 16) || '普通',
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

  const rawTt = raw.timetableConfig && typeof raw.timetableConfig === 'object' ? raw.timetableConfig : {};
  const timetableConfig = {
    windowStartMin: Math.round(clampNum(rawTt.windowStartMin, 420, 0, 1380)),
    windowDurationMin: Math.round(clampNum(rawTt.windowDurationMin, 60, 15, 240)),
    defaultMinHeadwaySec: Math.round(clampNum(rawTt.defaultMinHeadwaySec, 120, 45, 900))
  };

  return {
    schemaVersion: 1,
    scaleConfig,
    lineSpecs,
    stationProfiles,
    sectionOverrides,
    trackConnections,
    servicePatterns,
    timetableConfig
  };
}

module.exports = {
  normalizeProOpsDocument
};

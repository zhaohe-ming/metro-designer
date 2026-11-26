import {
  Line,
  Section,
  Station,
  VideoAspectRatio,
  VideoDateMode,
  VideoResolution,
  VideoSegmentInput,
  Waypoint
} from '../types';
import { roundCorners } from './roundedPath';
import { buildSectionRenderGeometry } from './offsetPath';

export type { VideoSegmentInput } from '../types';

export type VideoPoint = { x: number; y: number };

export function isValidFlexibleOpenDate(raw: string): boolean {
  const value = (raw || '').trim();
  if (!value) return false;
  if (/^\d{4}$/.test(value)) {
    const year = Number(value);
    return year >= 1800 && year <= 2300;
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split('-').map(Number);
    return y >= 1800 && y <= 2300 && m >= 1 && m <= 12;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  return false;
}

export function normalizeSortableDateKey(raw: string): string {
  const value = (raw || '').trim();
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  return value;
}

/**
 * 将灵活开通日期解析为连续十进制年份（如 "2018" -> 2018.0, "2018-07" -> 2018.5, "2020-12-28" -> 2020.99）
 */
export function parseVideoDecimalYear(raw: string): number | null {
  const value = (raw || '').trim();
  if (/^\d{4}$/.test(value)) {
    return Number(value);
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split('-').map(Number);
    return y + Math.max(0, Math.min(11, m - 1)) / 12;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return y + (Math.max(0, m - 1) + Math.max(0, d - 1) / 31) / 12;
  }
  return null;
}

/**
 * 计算单段开通路径的物理里程（公里）：
 * - 若地理底图且节点具备有效经纬度，使用 Haversine 球面大圆真实距离；
 * - 否则使用画布世界坐标长度 × metersPerUnit（默认 25 米/单位）换算等效运营里程。
 */
export function computeVideoRouteKilometers(params: {
  edges: Array<{ section: Section; reversed: boolean }>;
  stationById: ReadonlyMap<string, Station>;
  worldLength: number;
  isGeoMode: boolean;
  metersPerUnit?: number;
}): number {
  const { edges, stationById, worldLength, isGeoMode, metersPerUnit } = params;
  if (isGeoMode && edges.length > 0) {
    const haversineKm = (lng1: number, lat1: number, lng2: number, lat2: number) => {
      const toRad = (deg: number) => (deg * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    };
    let geoKm = 0;
    let allValid = true;
    for (const { section } of edges) {
      const stA = stationById.get(section.startStationId);
      const stB = stationById.get(section.endStationId);
      const chain = [stA, ...(section.waypoints || []), stB];
      for (let i = 1; i < chain.length; i += 1) {
        const p0 = chain[i - 1];
        const p1 = chain[i];
        if (
          !p0 ||
          !p1 ||
          typeof p0.lng !== 'number' ||
          typeof p0.lat !== 'number' ||
          typeof p1.lng !== 'number' ||
          typeof p1.lat !== 'number'
        ) {
          allValid = false;
          break;
        }
        geoKm += haversineKm(p0.lng, p0.lat, p1.lng, p1.lat);
      }
      if (!allValid) break;
    }
    if (allValid && geoKm > 0.01) {
      return geoKm;
    }
  }
  const mpu = typeof metersPerUnit === 'number' && metersPerUnit > 0 ? metersPerUnit : 25;
  return Math.max(0.2, (worldLength * mpu) / 1000);
}

export interface ScheduledSegmentWindow {
  index: number;
  waveIndex: number;
  startFrame: number;
  endFrame: number;
  holdEndFrame: number;
  decimalYear: number | null;
}

export interface ScheduledWaveWindow {
  waveIndex: number;
  segmentIndices: number[];
  startFrame: number;
  endFrame: number;
  holdEndFrame: number;
  yearStart: number | null;
  yearEnd: number | null;
}

export interface VideoTimelineSchedule {
  mode: 'chronicle' | 'sequential';
  titleFrames: number;
  bodyFrames: number;
  outroFrames: number;
  totalFrames: number;
  segments: ScheduledSegmentWindow[];
  waves: ScheduledWaveWindow[];
  /** 给定全局帧号，返回当前连续滚动年份（如 2018.4 -> 显示 2018） */
  yearAtFrame: (frame: number) => number | null;
}

/**
 * 构建双模时间轴排程：
 * - chronicle（编年史连续年份流）：同一年/相近月份（<= 0.2 年）的多段归入同一批次微错峰齐开，多年空窗期自动做对数压缩快进；
 * - sequential（逐段精细解说流）：严格按列表顺序逐段播放。
 */
export function buildVideoTimelineSchedule(params: {
  mode: 'chronicle' | 'sequential';
  dateMode: VideoDateMode;
  fps: number;
  speedMultiplier: number;
  titleFrames: number;
  outroFrames: number;
  items: Array<{
    openDate: string;
    durationFrames: number;
    holdFrames: number;
  }>;
}): VideoTimelineSchedule {
  const { dateMode, fps, speedMultiplier, titleFrames, outroFrames, items } = params;
  const safeSpeed = Math.max(0.5, Math.min(3, speedMultiplier || 1));
  const parsedYears = items.map((it) => (dateMode === 'date' ? parseVideoDecimalYear(it.openDate) : null));
  const canChronicle =
    params.mode === 'chronicle' &&
    dateMode === 'date' &&
    items.length > 0 &&
    parsedYears.every((y): y is number => y !== null && Number.isFinite(y));

  if (!canChronicle) {
    let cursor = titleFrames;
    const segWindows: ScheduledSegmentWindow[] = [];
    const waves: ScheduledWaveWindow[] = [];
    items.forEach((it, idx) => {
      const startFrame = cursor;
      const endFrame = cursor + it.durationFrames;
      const holdEndFrame = endFrame + it.holdFrames;
      const yr = parsedYears[idx];
      segWindows.push({
        index: idx,
        waveIndex: idx,
        startFrame,
        endFrame,
        holdEndFrame,
        decimalYear: yr
      });
      waves.push({
        waveIndex: idx,
        segmentIndices: [idx],
        startFrame,
        endFrame,
        holdEndFrame,
        yearStart: yr,
        yearEnd: yr
      });
      cursor = holdEndFrame;
    });
    const bodyFrames = Math.max(1, cursor - titleFrames);
    const totalFrames = cursor + outroFrames;
    return {
      mode: 'sequential',
      titleFrames,
      bodyFrames,
      outroFrames,
      totalFrames,
      segments: segWindows,
      waves,
      yearAtFrame: (f: number) => {
        if (!waves.length) return null;
        if (f <= waves[0].startFrame) return waves[0].yearStart;
        for (let i = 0; i < waves.length; i += 1) {
          if (f <= waves[i].holdEndFrame) return waves[i].yearStart;
        }
        return waves[waves.length - 1].yearEnd;
      }
    };
  }

  // Chronicle 模式：按列表顺序（若已按日期增序则自动聚合同期批次；若用户故意打乱顺序则仅相邻同期聚合）
  const rawGroups: Array<{ indices: number[]; minYear: number; maxYear: number }> = [];
  items.forEach((_, idx) => {
    const yr = parsedYears[idx]!;
    const prev = rawGroups[rawGroups.length - 1];
    if (prev && Math.abs(yr - prev.maxYear) <= 0.22 && prev.indices.length < 5) {
      prev.indices.push(idx);
      prev.minYear = Math.min(prev.minYear, yr);
      prev.maxYear = Math.max(prev.maxYear, yr);
    } else {
      rawGroups.push({ indices: [idx], minYear: yr, maxYear: yr });
    }
  });

  const staggerStep = Math.max(4, Math.round((fps * 0.26) / safeSpeed));
  const segWindows: ScheduledSegmentWindow[] = new Array(items.length);
  const waves: ScheduledWaveWindow[] = [];
  const yearAnchors: Array<{ frame: number; year: number }> = [];

  let cursor = titleFrames;
  rawGroups.forEach((grp, wIdx) => {
    if (wIdx > 0) {
      const prevWave = waves[wIdx - 1];
      const deltaYears = grp.minYear - (prevWave.yearEnd ?? grp.minYear);
      // 多年建设空窗期：对数压缩时间桥（例如隔 5 年用 ~0.85s 快速滚过年份表，既有历史跨度感又不枯燥干等）
      if (deltaYears > 0.85) {
        const bridgeSec = Math.min(1.35, Math.max(0.42, 0.36 + Math.log2(deltaYears + 1) * 0.28)) / safeSpeed;
        cursor += Math.max(6, Math.round(bridgeSec * fps));
      }
    }

    const waveStart = cursor;
    let waveGrowEnd = waveStart;
    let maxHold = Math.max(8, Math.round((fps * 0.36) / Math.sqrt(safeSpeed)));

    grp.indices.forEach((segIdx, localOrder) => {
      const it = items[segIdx];
      // 同批次多线微错峰齐开，单段时长适度精炼避免拖沓
      const refinedDur =
        grp.indices.length > 1 ? Math.max(Math.round(fps * 1.25), Math.round(it.durationFrames * 0.86)) : it.durationFrames;
      const sFrame = waveStart + localOrder * staggerStep;
      const eFrame = sFrame + refinedDur;
      waveGrowEnd = Math.max(waveGrowEnd, eFrame);
      maxHold = Math.max(maxHold, Math.round(it.holdFrames * 0.85));
      segWindows[segIdx] = {
        index: segIdx,
        waveIndex: wIdx,
        startFrame: sFrame,
        endFrame: eFrame,
        holdEndFrame: waveGrowEnd + maxHold,
        decimalYear: parsedYears[segIdx]
      };
    });

    const waveHoldEnd = waveGrowEnd + maxHold;
    grp.indices.forEach((segIdx) => {
      segWindows[segIdx].holdEndFrame = waveHoldEnd;
    });

    const spanYears = Math.max(0.15, grp.maxYear - grp.minYear);
    waves.push({
      waveIndex: wIdx,
      segmentIndices: grp.indices,
      startFrame: waveStart,
      endFrame: waveGrowEnd,
      holdEndFrame: waveHoldEnd,
      yearStart: grp.minYear,
      yearEnd: grp.minYear + spanYears
    });

    yearAnchors.push({ frame: waveStart, year: grp.minYear });
    yearAnchors.push({ frame: waveHoldEnd, year: Math.max(grp.maxYear, grp.minYear + 0.08) });
    cursor = waveHoldEnd;
  });

  const bodyFrames = Math.max(1, cursor - titleFrames);
  const totalFrames = cursor + outroFrames;

  const yearAtFrame = (f: number): number | null => {
    if (!yearAnchors.length) return null;
    if (f <= yearAnchors[0].frame) return yearAnchors[0].year;
    const last = yearAnchors[yearAnchors.length - 1];
    if (f >= last.frame) return last.year;
    for (let i = 1; i < yearAnchors.length; i += 1) {
      const a = yearAnchors[i - 1];
      const b = yearAnchors[i];
      if (f <= b.frame) {
        const span = Math.max(1, b.frame - a.frame);
        const u = (f - a.frame) / span;
        return a.year + (b.year - a.year) * u;
      }
    }
    return last.year;
  };

  return {
    mode: 'chronicle',
    titleFrames,
    bodyFrames,
    outroFrames,
    totalFrames,
    segments: segWindows,
    waves,
    yearAtFrame
  };
}

export function formatVideoDateLabel(
  segment: Pick<VideoSegmentInput, 'openDate' | 'phaseLabel'>,
  index: number,
  dateMode: VideoDateMode = 'date'
): string {
  const phase = (segment.phaseLabel || '').trim();
  const raw = (segment.openDate || '').trim();
  if (dateMode === 'sequence') {
    return phase || raw || `第 ${index + 1} 阶段`;
  }
  let formatted = raw;
  if (/^\d{4}$/.test(raw)) {
    formatted = `${raw} 年`;
  } else if (/^\d{4}-\d{2}$/.test(raw)) {
    const [y, m] = raw.split('-');
    formatted = `${y} 年 ${Number(m)} 月`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-');
    formatted = `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
  }
  return phase ? `${formatted} · ${phase}` : formatted || `阶段 ${index + 1}`;
}

export function extractVideoEraBadge(
  segment: Pick<VideoSegmentInput, 'openDate' | 'phaseLabel'>,
  index: number,
  dateMode: VideoDateMode = 'date'
): string {
  const raw = (segment.openDate || '').trim();
  if (dateMode !== 'sequence') {
    const yearMatch = raw.match(/^(\d{4})/);
    if (yearMatch) return yearMatch[1];
  }
  const phase = (segment.phaseLabel || '').trim();
  if (phase) return phase.slice(0, 8);
  return `第 ${index + 1} 期`;
}

export function computeVideoDimensions(
  aspectRatio?: VideoAspectRatio,
  resolution: VideoResolution = '1080p',
  fallbackStageWidth = 1280,
  fallbackStageHeight = 720
): { width: number; height: number } {
  const roundEven = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const is720 = resolution === '720p';
  if (aspectRatio === '16:9') {
    return is720 ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
  }
  if (aspectRatio === '9:16') {
    return is720 ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
  }
  if (aspectRatio === '4:3') {
    return is720 ? { width: 960, height: 720 } : { width: 1440, height: 1080 };
  }
  if (aspectRatio === '1:1') {
    return is720 ? { width: 720, height: 720 } : { width: 1080, height: 1080 };
  }
  const stageRatio = Math.max(0.45, Math.min(2.4, Math.max(1, fallbackStageWidth) / Math.max(1, fallbackStageHeight)));
  const maxVideoEdge = is720 ? 1280 : 1920;
  const minVideoEdge = is720 ? 540 : 720;
  const width =
    stageRatio >= 1
      ? roundEven(maxVideoEdge)
      : roundEven(Math.max(minVideoEdge, maxVideoEdge * stageRatio));
  const height =
    stageRatio >= 1
      ? roundEven(Math.max(minVideoEdge, maxVideoEdge / stageRatio))
      : roundEven(maxVideoEdge);
  return { width, height };
}

export function generateAutoVideoSegments(
  lines: Line[],
  stations: Station[],
  sections: Section[],
  dateMode: VideoDateMode = 'date'
): VideoSegmentInput[] {
  const stationSet = new Set(stations.map((s) => s.id));
  const result: VideoSegmentInput[] = [];
  const baseYear = 2012;

  lines.forEach((line) => {
    const validIds = line.stationIds.filter((id) => stationSet.has(id));
    if (validIds.length < 2) return;

    const lineEdges = sections.filter(
      (sec) => sec.lineId === line.id && stationSet.has(sec.startStationId) && stationSet.has(sec.endStationId)
    );
    if (lineEdges.length === 0) return;

    const edgeBetween = (a: string, b: string) =>
      lineEdges.some(
        (e) =>
          (e.startStationId === a && e.endStationId === b) ||
          (e.startStationId === b && e.endStationId === a)
      );

    // 沿 line.stationIds 顺序提取连续已连通区间；若存在断开的两段也会各自生成一条步骤
    let runStart = validIds[0];
    let runPrev = validIds[0];

    const pushRun = (startId: string, endId: string) => {
      if (startId === endId) return;
      const stepIdx = result.length;
      const year = baseYear + stepIdx * 2;
      result.push({
        id: `auto_${line.id}_${stepIdx}_${Math.random().toString(36).slice(2, 6)}`,
        lineId: line.id,
        startStationId: startId,
        endStationId: endId,
        openDate: dateMode === 'sequence' ? '' : `${year}-06`
      });
    };

    for (let i = 1; i < validIds.length; i += 1) {
      const cur = validIds[i];
      if (edgeBetween(runPrev, cur)) {
        runPrev = cur;
      } else {
        pushRun(runStart, runPrev);
        runStart = cur;
        runPrev = cur;
      }
    }
    pushRun(runStart, runPrev);
  });

  // 如果某条线通过分支连接但不在相邻 stationIds 上，兜底用该线已连接的首尾端点
  if (result.length === 0) {
    lines.forEach((line) => {
      const lineEdges = sections.filter(
        (sec) => sec.lineId === line.id && stationSet.has(sec.startStationId) && stationSet.has(sec.endStationId)
      );
      if (!lineEdges.length) return;
      const startId = lineEdges[0].startStationId;
      const endId = lineEdges[lineEdges.length - 1].endStationId;
      if (startId !== endId) {
        const stepIdx = result.length;
        result.push({
          id: `auto_${line.id}_${stepIdx}_${Math.random().toString(36).slice(2, 6)}`,
          lineId: line.id,
          startStationId: startId,
          endStationId: endId,
          openDate: dateMode === 'sequence' ? '' : `${baseYear + stepIdx * 2}-06`
        });
      }
    });
  }

  return result;
}

export function resolveVideoRoute(
  segment: VideoSegmentInput,
  lines: Line[],
  stations: Station[],
  sections: Section[],
  options?: { dateMode?: VideoDateMode }
) {
  const line = lines.find((item) => item.id === segment.lineId);
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const start = stationById.get(segment.startStationId);
  const end = stationById.get(segment.endStationId);
  const dateMode = options?.dateMode || 'date';
  const validDate = dateMode === 'sequence' ? true : isValidFlexibleOpenDate(segment.openDate);

  if (
    !line ||
    !start ||
    !end ||
    start.id === end.id ||
    !line.stationIds.includes(start.id) ||
    !line.stationIds.includes(end.id) ||
    !validDate
  ) {
    throw new Error(`视频区间配置无效：${segment.openDate || '未填写日期或起终点无效'}`);
  }
  const edges = sections.filter(
    (section) =>
      section.lineId === line.id && stationById.has(section.startStationId) && stationById.has(section.endStationId)
  );
  const edgeBetween = (a: string, b: string) =>
    edges.find(
      (edge) =>
        (edge.startStationId === a && edge.endStationId === b) ||
        (edge.startStationId === b && edge.endStationId === a)
    );
  const startIndex = line.stationIds.indexOf(start.id);
  const endIndex = line.stationIds.indexOf(end.id);
  let stationIds =
    startIndex < endIndex
      ? line.stationIds.slice(startIndex, endIndex + 1)
      : line.stationIds.slice(endIndex, startIndex + 1).reverse();
  if (
    !stationIds.every((id, index) => stationById.has(id) && (index === 0 || !!edgeBetween(stationIds[index - 1], id)))
  ) {
    const adjacency = new Map<string, string[]>();
    edges.forEach((edge) => {
      adjacency.set(edge.startStationId, [...(adjacency.get(edge.startStationId) || []), edge.endStationId]);
      adjacency.set(edge.endStationId, [...(adjacency.get(edge.endStationId) || []), edge.startStationId]);
    });
    const queue = [start.id];
    const parent = new Map<string, string | null>([[start.id, null]]);
    for (let index = 0; index < queue.length && !parent.has(end.id); index += 1) {
      (adjacency.get(queue[index]) || []).forEach((next) => {
        if (!parent.has(next)) {
          parent.set(next, queue[index]);
          queue.push(next);
        }
      });
    }
    if (!parent.has(end.id)) throw new Error(`找不到视频路径：${line.name} ${start.name} - ${end.name}，请先连接站点`);
    stationIds = [];
    let cursor: string | null = end.id;
    while (cursor !== null) {
      stationIds.unshift(cursor);
      cursor = parent.get(cursor)!;
    }
  }
  return {
    segment,
    line,
    stationIds,
    edges: stationIds.slice(1).map((id, index) => ({
      section: edgeBetween(stationIds[index], id)!,
      reversed: edgeBetween(stationIds[index], id)!.startStationId !== stationIds[index]
    }))
  };
}

export function getVideoSectionPoints(
  section: Section,
  stationById: Map<string, Station>,
  project: (point: Station | Waypoint) => VideoPoint,
  radius: number,
  directedOffset = 0
) {
  const start = stationById.get(section.startStationId);
  const end = stationById.get(section.endStationId);
  if (!start || !end) return [];
  const controlPoints = [
    project(start),
    ...(section.waypoints || []).map((wp) => ({
      ...project(wp),
      ...(typeof wp.radius === 'number' ? { radius: wp.radius } : {}),
      ...(wp.mode ? { mode: wp.mode } : {})
    })),
    project(end)
  ];
  if (Math.abs(directedOffset) < 1e-6) {
    return roundCorners(controlPoints, radius);
  }
  return buildSectionRenderGeometry(controlPoints, directedOffset, radius).renderPoints;
}

export function buildVideoRouteGeometry(
  route: ReturnType<typeof resolveVideoRoute>,
  stationById: Map<string, Station>,
  project: (point: Station | Waypoint) => VideoPoint,
  radius: number,
  sectionOffsets?: ReadonlyMap<string, number>
) {
  const points: VideoPoint[] = [];
  const stationDistances = [0];
  let distance = 0;
  route.edges.forEach(({ section, reversed }) => {
    const offset = sectionOffsets?.get(section.id) || 0;
    const sectionPoints = getVideoSectionPoints(section, stationById, project, radius, offset);
    if (reversed) sectionPoints.reverse();
    if (sectionPoints.length === 0) return;
    if (points.length === 0) {
      points.push(sectionPoints[0]);
    } else {
      const joinDist = Math.hypot(
        sectionPoints[0].x - points[points.length - 1].x,
        sectionPoints[0].y - points[points.length - 1].y
      );
      if (joinDist > 0.25) {
        distance += joinDist;
        points.push(sectionPoints[0]);
      }
    }
    sectionPoints.slice(1).forEach((point) => {
      const previous = points[points.length - 1];
      distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      points.push(point);
    });
    stationDistances.push(distance);
  });
  if (points.length === 0) {
    points.push(project(stationById.get(route.stationIds[0])!));
  }
  if (distance <= 0) throw new Error(`区间 ${route.line.name} 的站点重合，无法生成动画`);
  return { points, stationDistances };
}

export function easeVideoProgress(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function videoArrivalProgress(distanceRatio: number) {
  const t = Math.max(0, Math.min(1, distanceRatio));
  return t < 0.5 ? Math.cbrt(t / 4) : 1 - Math.cbrt((1 - t) / 4);
}

export function videoFrameAtTime(elapsedMs: number, fps: number, totalFrames: number) {
  return {
    frame: Math.min(totalFrames - 1, Math.floor((Math.max(0, elapsedMs) * fps) / 1000)),
    done: elapsedMs >= (totalFrames * 1000) / fps
  };
}

export function mercatorProject(lng: number, lat: number, zoom: number): VideoPoint {
  const sin = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  const worldSize = 256 * Math.pow(2, zoom);
  return { x: ((lng + 180) / 360) * worldSize, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize };
}

export function staticMapViewport(width: number, height: number, zoom: number) {
  return { width: width / 2, height: height / 2, zoom: Math.max(1, Math.min(17, Math.round(zoom))), scale: 2 };
}

export function activeVideoStationLines(
  opened: Array<{ line: Line; stationIds: string[] }>,
  current?: { line: Line; stationIds: string[]; stationDistances: number[] },
  distance = 0
) {
  const memberships = new Map<string, Set<string>>();
  const add = (id: string, lineId: string) => {
    if (!memberships.has(id)) memberships.set(id, new Set());
    memberships.get(id)!.add(lineId);
  };
  opened.forEach((plan) => plan.stationIds.forEach((id) => add(id, plan.line.id)));
  current?.stationIds.forEach((id, index) => {
    if (current.stationDistances[index] <= distance + 1e-6) add(id, current.line.id);
  });
  return memberships;
}

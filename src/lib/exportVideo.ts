// 视频场景渲染与导出引擎 2.0（纪录片编年史质感版）：
// 1. 双时间轴排程：支持「编年史连续年份流（同期多线微错峰齐开 + 空窗年份滚表快进）」与「逐段精细解说流」；
// 2. 零跳变预平滑相机轨道（Gaussian-Smoothed Corridor Spline）：提前预判新开通走廊构图，支持 O(1) 任意帧拖动预览；
// 3. 无框大字排版 HUD：大号 Bahnschrift/DIN 等宽纪年 + 实时滚动的「线路 / 车站 / 里程 KM」计数器 + 左上角简办风开通事件流条带；
// 4. 制图级微动效：规划在建虚线、轨道桥式底衬、流光前锋（Comet Front）、站点弹性点亮、换乘合龙双环脉冲与整词上浮站名。

import {
  Line,
  MapSettings,
  Section,
  Station,
  VideoAspectRatio,
  VideoCameraMode,
  VideoDateMode,
  VideoFps,
  VideoResolution,
  VideoSpeedMultiplier,
  VideoTimelineMode,
  VideoUnopenedStyle,
  Waypoint
} from '../types';
import { getCityStylePreset } from '../stylePresets';
import { planInterchange, degToRad, fillCurvedArrowCanvas2d } from './interchange';
import { drawLightCityToCanvas2D, getLightCityPalette } from './lightCity';
import { computeNetworkParallelLayout } from './offsetPath';
import {
  buildVideoRouteGeometry,
  buildVideoTimelineSchedule,
  computeVideoDimensions,
  computeVideoRouteKilometers,
  easeVideoProgress,
  extractVideoEraBadge,
  formatVideoDateLabel,
  getVideoSectionPoints,
  mercatorProject,
  resolveVideoRoute,
  videoArrivalProgress,
  VideoSegmentInput
} from './videoModel';
import { amapVideoFilter, hasVideoGeoPoint, planAmapVideoMap } from './amapVideo';
import { checkVideoRecordingSupport, recordVideoCanvas, throwIfVideoAborted, VideoExportProgress } from './recordVideo';

export interface VideoSceneOptions {
  segments: VideoSegmentInput[];
  lines: Line[];
  stations: Station[];
  sections: Section[];
  settings: MapSettings;
  stageWidth?: number;
  stageHeight?: number;
  title?: string;
  subtitle?: string;
  titleDurationSec?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  fps?: VideoFps;
  speedMultiplier?: VideoSpeedMultiplier;
  cameraMode?: VideoCameraMode;
  unopenedStyle?: VideoUnopenedStyle;
  dateMode?: VideoDateMode;
  timelineMode?: VideoTimelineMode;
  showYearBadge?: boolean;
  showLineLegend?: boolean;
  metersPerUnit?: number;
  amapPlan?: ReturnType<typeof planAmapVideoMap> | null;
  amapImages?: Array<{
    patch: NonNullable<ReturnType<typeof planAmapVideoMap>>['patches'][number];
    image: CanvasImageSource;
  }>;
  isPreviewPlaceholderMap?: boolean;
}

export interface VideoSegmentMarker {
  index: number;
  label: string;
  color: string;
  startFrame: number;
  endFrame: number;
}

export interface VideoSceneRenderer {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  totalDurationSec: number;
  segmentMarkers: VideoSegmentMarker[];
  drawFrame: (ctx: CanvasRenderingContext2D, frame: number) => void;
}

export interface ExportVideoOptions {
  stage: any;
  segments: VideoSegmentInput[];
  lines: Line[];
  stations: Station[];
  sections: Section[];
  settings: MapSettings;
  title?: string;
  subtitle?: string;
  titleDurationSec?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  fps?: VideoFps;
  speedMultiplier?: VideoSpeedMultiplier;
  cameraMode?: VideoCameraMode;
  unopenedStyle?: VideoUnopenedStyle;
  dateMode?: VideoDateMode;
  timelineMode?: VideoTimelineMode;
  showYearBadge?: boolean;
  showLineLegend?: boolean;
  metersPerUnit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: VideoExportProgress) => void;
  fetchAmapStaticMap: (params: {
    center: [number, number];
    zoom: number;
    width: number;
    height: number;
    style?: string;
    scale?: 1 | 2;
    signal?: AbortSignal;
  }) => Promise<Blob>;
  onWarn?: (message: string) => void;
}

const SANS_STACK =
  '"HarmonyOS Sans SC", "Source Han Sans SC", "PingFang SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", Inter, -apple-system, sans-serif';
const NUM_STACK = '"Bahnschrift", "DIN Alternate", "Segoe UI", Inter, -apple-system, sans-serif';
const MONO_STACK = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const outCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const inOutCubic = (t: number) => {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};
const inOutQuint = (t: number) => {
  const u = clamp01(t);
  return u < 0.5 ? 16 * Math.pow(u, 5) : 1 - Math.pow(-2 * u + 2, 5) / 2;
};
const outBack = (t: number) => {
  const u = clamp01(t);
  const c1 = 1.56;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  radius: number
) {
  const r = Math.max(0, Math.min(radius, rectWidth / 2, rectHeight / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + rectWidth - r, y);
  ctx.quadraticCurveTo(x + rectWidth, y, x + rectWidth, y + r);
  ctx.lineTo(x + rectWidth, y + rectHeight - r);
  ctx.quadraticCurveTo(x + rectWidth, y + rectHeight, x + rectWidth - r, y + rectHeight);
  ctx.lineTo(x + r, y + rectHeight);
  ctx.quadraticCurveTo(x, y + rectHeight, x, y + rectHeight - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function smoothTrackArray(src: Float64Array, radius: number, passes = 3): Float64Array {
  const n = src.length;
  if (n <= 2 || radius <= 0) return src;
  let curr = new Float64Array(src);
  let next = new Float64Array(n);
  for (let p = 0; p < passes; p += 1) {
    let windowSum = 0;
    let windowCount = 0;
    for (let i = 0; i <= Math.min(n - 1, radius); i += 1) {
      windowSum += curr[i];
      windowCount += 1;
    }
    for (let i = 0; i < n; i += 1) {
      next[i] = windowSum / Math.max(1, windowCount);
      const addIdx = i + radius + 1;
      const remIdx = i - radius;
      if (addIdx < n) {
        windowSum += curr[addIdx];
        windowCount += 1;
      }
      if (remIdx >= 0) {
        windowSum -= curr[remIdx];
        windowCount -= 1;
      }
    }
    const tmp = curr;
    curr = next;
    next = tmp;
  }
  return curr;
}

export function createVideoSceneRenderer(opts: VideoSceneOptions): VideoSceneRenderer {
  const {
    segments,
    lines: inputLines,
    stations: inputStations,
    sections: inputSections,
    settings,
    stageWidth = 1280,
    stageHeight = 720,
    title: rawTitle,
    subtitle: rawSubtitle,
    titleDurationSec: rawTitleDurationSec,
    aspectRatio,
    resolution = '1080p',
    fps = 30,
    speedMultiplier = 1,
    cameraMode = 'gentle',
    unopenedStyle = 'ghost',
    dateMode = 'date',
    timelineMode = 'chronicle',
    showYearBadge = true,
    showLineLegend = true,
    metersPerUnit,
    amapImages = [],
    isPreviewPlaceholderMap = false
  } = opts;

  if (!segments.length) throw new Error('请至少填写一个开通区间');
  if (!inputStations.length) throw new Error('请先创建站点后再导出视频');

  const titleText = (rawTitle || '').trim() || '城市轨道线网历程';
  const userSubtitleText = (rawSubtitle || '').trim();
  const titleDurationSec = Math.max(1, Math.min(8, rawTitleDurationSec || 2.8));
  const { width, height } = computeVideoDimensions(aspectRatio, resolution, stageWidth, stageHeight);
  const isPortrait = height > width;
  const uiScale = Math.min(width, height) / 1080;

  const titleFrames = Math.round(fps * titleDurationSec);
  const outroFrames = Math.round(fps * 3.2);

  const preset = getCityStylePreset(settings);
  const isDarkCanvas = settings.canvasTheme === 'dark';
  const isAmapVideo = settings.baseMap.mode === 'amap';
  const isLightCityVideo = settings.baseMap.mode === 'light-city' && Boolean(settings.baseMap.lightCity);

  const animationSegments = segments.map((segment) =>
    resolveVideoRoute(segment, inputLines, inputStations, inputSections, { dateMode })
  );
  const routeStationIds = new Set(animationSegments.flatMap((route) => route.stationIds));
  const routeSectionIds = new Set(animationSegments.flatMap((route) => route.edges.map((edge) => edge.section.id)));
  const requiredGeoPoints = [
    ...inputStations.filter((station) => routeStationIds.has(station.id)),
    ...inputSections.filter((section) => routeSectionIds.has(section.id)).flatMap((section) => section.waypoints || [])
  ];

  const allStations = isAmapVideo ? inputStations.filter(hasVideoGeoPoint) : inputStations;
  const geographicStationIds = new Set(allStations.map((station) => station.id));
  const allSections = isAmapVideo
    ? inputSections.filter(
        (section) =>
          geographicStationIds.has(section.startStationId) &&
          geographicStationIds.has(section.endStationId) &&
          (section.waypoints || []).every(hasVideoGeoPoint)
      )
    : inputSections;
  const allLines = inputLines;

  const amapStyle = settings.baseMap.amap?.style || 'normal';
  const usesDarkVideoSurface = isAmapVideo ? amapStyle === 'dark' : isDarkCanvas;
  const surfaceCasingColor = usesDarkVideoSurface ? 'rgba(4, 9, 19, 0.92)' : 'rgba(246, 248, 252, 0.94)';
  const mutedLineColor = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.24)' : 'rgba(100, 116, 139, 0.20)';
  const mutedStationFill = usesDarkVideoSurface ? '#0b1324' : '#ffffff';
  const mutedStationStroke = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.42)' : '#cbd5e1';
  const primaryText = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';
  const secondaryText = usesDarkVideoSurface ? '#94a3b8' : '#475569';
  const kickerColor = usesDarkVideoSurface ? '#7dd3fc' : '#2563eb';
  const textHalo = usesDarkVideoSurface ? 'rgba(3, 7, 18, 0.94)' : 'rgba(255, 255, 255, 0.96)';
  const stationById = new Map(allStations.map((station) => [station.id, station]));

  const stationLineColors = new Map<string, string[]>();
  allLines.forEach((line) => {
    line.stationIds.forEach((id) => {
      const arr = stationLineColors.get(id);
      if (arr) arr.push(line.color);
      else stationLineColors.set(id, [line.color]);
    });
  });
  const stationLineCounts = allStations.reduce<Record<string, number>>((result, station) => {
    result[station.id] = stationLineColors.get(station.id)?.length || 0;
    return result;
  }, {});

  const allGeometryPoints = [...allStations, ...allSections.flatMap((section) => section.waypoints || [])];
  const amapPlan =
    opts.amapPlan ?? (isAmapVideo && requiredGeoPoints.length > 0 ? planAmapVideoMap(requiredGeoPoints, width, height) : null);

  const stationWorld = (station: Station | Waypoint) => {
    if (isAmapVideo && amapPlan && typeof station.lng === 'number' && typeof station.lat === 'number') {
      return mercatorProject(station.lng, station.lat, amapPlan.zoom);
    }
    return { x: station.x, y: station.y };
  };

  const projectedGeoPoints = allGeometryPoints.map(stationWorld);
  const minX = Math.min(...projectedGeoPoints.map((p) => p.x));
  const minY = Math.min(...projectedGeoPoints.map((p) => p.y));
  const maxX = Math.max(...projectedGeoPoints.map((p) => p.x));
  const maxY = Math.max(...projectedGeoPoints.map((p) => p.y));

  const padX = Math.round((isPortrait ? 78 : 118) * uiScale);
  const padTop = Math.round((isPortrait ? 128 : 112) * uiScale);
  const padBottom = Math.round((isPortrait ? 196 : 168) * uiScale);
  const mapWidth = Math.max(1, maxX - minX);
  const mapHeight = Math.max(1, maxY - minY);
  const plainMapScale = Math.min(
    (width - padX * 2) / mapWidth,
    (height - padTop - padBottom) / mapHeight,
    2.2 * uiScale
  );
  const mapScale = isAmapVideo
    ? Math.max(0.68, Math.min(1.35, Math.min(width, height) / 760))
    : Math.max(0.55, Math.min(1.35, plainMapScale));

  const verticalBiasWorld = isAmapVideo ? 0 : ((padBottom - padTop) * 0.34) / Math.max(0.05, plainMapScale);
  const defaultCamera = isAmapVideo && amapPlan
    ? amapPlan.camera
    : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 + verticalBiasWorld, scale: plainMapScale };

  const camera = { x: defaultCamera.x, y: defaultCamera.y, scale: defaultCamera.scale };

  const worldToCanvas = (p: { x: number; y: number }) => ({
    x: (p.x - camera.x) * camera.scale + width / 2,
    y: (p.y - camera.y) * camera.scale + height / 2
  });

  const worldToCanvasFitAll = (p: { x: number; y: number }) => ({
    x: (p.x - defaultCamera.x) * defaultCamera.scale + width / 2,
    y: (p.y - defaultCamera.y) * defaultCamera.scale + height / 2
  });

  const toCanvasPoint = (station: Station) => worldToCanvas(stationWorld(station));
  const toFitAllCanvasPoint = (station: Station) => worldToCanvasFitAll(stationWorld(station));

  const lineOrderMap = new Map<string, number>();
  allLines.forEach((line, index) => lineOrderMap.set(line.id, index));
  const videoParallelGapWorld =
    (Math.max(8.8, preset.lineWidth + 4) * mapScale) / Math.max(0.15, defaultCamera.scale);
  const videoParallelLayout = computeNetworkParallelLayout({
    sections: allSections
      .filter((sec) => stationById.has(sec.startStationId) && stationById.has(sec.endStationId))
      .map((sec) => ({
        id: sec.id,
        lineId: sec.lineId,
        startStationId: sec.startStationId,
        endStationId: sec.endStationId,
        points: [
          stationWorld(stationById.get(sec.startStationId)!),
          ...(sec.waypoints || []).map((wp) => stationWorld(wp)),
          stationWorld(stationById.get(sec.endStationId)!)
        ],
        parallelOrder: sec.parallelOrder
      })),
    lineOrderMap,
    gap: videoParallelGapWorld,
    stationLineCounts
  });
  const videoSectionOffsets = new Map<string, number>();
  videoParallelLayout.bySectionId.forEach((meta, secId) => {
    videoSectionOffsets.set(secId, meta.directedOffset);
  });

  const sectionPoints = new Map(
    allSections.map((section) => [
      section.id,
      getVideoSectionPoints(
        section,
        stationById,
        stationWorld,
        settings.cornerRadius,
        videoSectionOffsets.get(section.id) || 0
      )
    ])
  );

  type VideoPoint = { x: number; y: number };
  type RectBox = { x: number; y: number; width: number; height: number };
  type LabelPlacement = RectBox & { textX: number; textY: number };

  const getPathMetrics = (points: VideoPoint[]) => {
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    const cumulative = [0];
    lengths.forEach((length) => cumulative.push(cumulative[cumulative.length - 1] + length));
    return { points, lengths, cumulative, totalLength: cumulative[cumulative.length - 1] || 1 };
  };

  const getPointAtDistance = (metrics: ReturnType<typeof getPathMetrics>, distance: number) => {
    const clamped = Math.max(0, Math.min(metrics.totalLength, distance));
    for (let index = 1; index < metrics.points.length; index += 1) {
      const segmentStart = metrics.cumulative[index - 1];
      const segmentEnd = metrics.cumulative[index];
      if (clamped <= segmentEnd || index === metrics.points.length - 1) {
        const ratio = segmentEnd === segmentStart ? 0 : (clamped - segmentStart) / (segmentEnd - segmentStart);
        const previous = metrics.points[index - 1];
        const current = metrics.points[index];
        return {
          x: previous.x + (current.x - previous.x) * ratio,
          y: previous.y + (current.y - previous.y) * ratio
        };
      }
    }
    return metrics.points[metrics.points.length - 1];
  };

  const strokePathSlice = (
    ctx: CanvasRenderingContext2D,
    metrics: ReturnType<typeof getPathMetrics>,
    startDist: number,
    endDist: number
  ): boolean => {
    const s0 = clamp(Math.min(startDist, endDist), 0, metrics.totalLength);
    const s1 = clamp(Math.max(startDist, endDist), 0, metrics.totalLength);
    if (s1 - s0 < 0.25 || metrics.points.length < 2) return false;
    ctx.beginPath();
    const pStart = worldToCanvas(getPointAtDistance(metrics, s0));
    ctx.moveTo(pStart.x, pStart.y);
    for (let i = 1; i < metrics.points.length - 1; i += 1) {
      const d = metrics.cumulative[i];
      if (d > s0 && d < s1) {
        const p = worldToCanvas(metrics.points[i]);
        ctx.lineTo(p.x, p.y);
      }
    }
    const pEnd = worldToCanvas(getPointAtDistance(metrics, s1));
    ctx.lineTo(pEnd.x, pEnd.y);
    ctx.stroke();
    return true;
  };

  const rectsOverlap = (a: RectBox, b: RectBox) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const measureTextWidth = (text: string, font: string): number => {
    if (!measureCtx) return text.length * 14;
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  };

  const keyStationIds = new Set(
    animationSegments.flatMap((item) => [item.stationIds[0], item.stationIds[item.stationIds.length - 1]])
  );
  allStations.forEach((station) => {
    if (stationLineCounts[station.id] > 1) keyStationIds.add(station.id);
  });

  const labelFontSizeBase = Math.round(settings.dotLabelStyle.fontSize * Math.max(0.9, uiScale));
  const labelFontBase = `${settings.dotLabelStyle.fontWeight} ${labelFontSizeBase}px ${SANS_STACK}`;

  const createStationLabelPlacements = (stationIds: string[]) => {
    const uniqueStations = stationIds
      .map((id) => stationById.get(id))
      .filter(Boolean)
      .filter((station, index, list) => list.findIndex((item) => item!.id === station!.id) === index) as Station[];
    // 优先保证换乘枢纽与首末站占据最佳阅读方位
    uniqueStations.sort((a, b) => (keyStationIds.has(b.id) ? 1 : 0) - (keyStationIds.has(a.id) ? 1 : 0));

    const placements = new Map<string, LabelPlacement>();
    const occupied: RectBox[] = allStations.map((station) => {
      const point = toFitAllCanvasPoint(station);
      const radius =
        ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 5;
      return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
    });

    uniqueStations.forEach((station) => {
      if (station.labelPosition === 'hidden') return;
      const point = toFitAllCanvasPoint(station);
      const textWidth = Math.max(24, measureTextWidth(station.name, labelFontBase));
      const labelWidth = textWidth + 16;
      const labelHeight = labelFontSizeBase + 10;
      const stationRadius =
        ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale;
      const distance = stationRadius + 13;
      const candidates = [
        { x: point.x + distance, y: point.y - labelHeight / 2 },
        { x: point.x - distance - labelWidth, y: point.y - labelHeight / 2 },
        { x: point.x - labelWidth / 2, y: point.y - distance - labelHeight },
        { x: point.x - labelWidth / 2, y: point.y + distance },
        { x: point.x + distance * 0.78, y: point.y - distance * 0.78 - labelHeight },
        { x: point.x + distance * 0.78, y: point.y + distance * 0.78 },
        { x: point.x - distance * 0.78 - labelWidth, y: point.y + distance * 0.78 },
        { x: point.x - distance * 0.78 - labelWidth, y: point.y - distance * 0.78 - labelHeight }
      ];
      const posKeys = ['right', 'left', 'top', 'bottom', 'top-right', 'bottom-right', 'bottom-left', 'top-left'];
      const forcedPosition = posKeys.indexOf(station.labelPosition || 'auto');
      const best = candidates
        .filter((_, index) => forcedPosition < 0 || index === forcedPosition)
        .map((candidate, index) => {
          const rect = { ...candidate, width: labelWidth, height: labelHeight };
          let score = index * 1.5;
          occupied.forEach((other) => {
            if (rectsOverlap(rect, other)) score += 80;
          });
          if (rect.x < 16 || rect.y < 16 || rect.x + rect.width > width - 16 || rect.y + rect.height > height - 130) {
            score += 36;
          }
          return { ...rect, score };
        })
        .sort((a, b) => a.score - b.score)[0];
      if (!best) return;
      if (settings.labelDensity === 'adaptive' && forcedPosition < 0 && best.score >= 80 && !keyStationIds.has(station.id)) {
        return;
      }
      const placement = {
        x: best.x,
        y: best.y,
        width: best.width,
        height: best.height,
        textX: best.x + best.width / 2,
        textY: best.y + best.height / 2
      };
      placements.set(station.id, placement);
      occupied.push(placement);
    });

    return placements;
  };

  const labelPlacements = createStationLabelPlacements(allStations.map((station) => station.id));
  const safeSpeed = Math.max(0.5, Math.min(3, speedMultiplier || 1));

  const basePlans = animationSegments.map((item, idx) => {
    const { points: worldPoints, stationDistances } = buildVideoRouteGeometry(
      item,
      stationById,
      stationWorld,
      settings.cornerRadius,
      videoSectionOffsets
    );
    const metrics = getPathMetrics(worldPoints);
    const canvasLength = metrics.totalLength * defaultCamera.scale;
    const rawDurationSeconds = Math.min(9.5, Math.max(2.9, 2.2 + canvasLength / 280)) / safeSpeed;
    const durationFrames = Math.max(Math.round(fps * 1.25), Math.round(rawDurationSeconds * fps));
    const holdFrames = Math.max(Math.round(fps * 0.35), Math.round((fps * 0.52) / Math.sqrt(safeSpeed)));
    const routeKm = computeVideoRouteKilometers({
      edges: item.edges,
      stationById,
      worldLength: metrics.totalLength,
      isGeoMode: isAmapVideo,
      metersPerUnit
    });

    let bMinX = Infinity;
    let bMinY = Infinity;
    let bMaxX = -Infinity;
    let bMaxY = -Infinity;
    worldPoints.forEach((pt) => {
      if (pt.x < bMinX) bMinX = pt.x;
      if (pt.y < bMinY) bMinY = pt.y;
      if (pt.x > bMaxX) bMaxX = pt.x;
      if (pt.y > bMaxY) bMaxY = pt.y;
    });

    return {
      ...item,
      stepIndex: idx,
      points: worldPoints,
      stationDistances,
      metrics,
      routeKm,
      bounds: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY },
      durationFrames,
      holdFrames
    };
  });

  const schedule = buildVideoTimelineSchedule({
    mode: timelineMode,
    dateMode,
    fps,
    speedMultiplier: safeSpeed,
    titleFrames,
    outroFrames,
    items: basePlans.map((p) => ({
      openDate: p.segment.openDate,
      durationFrames: p.durationFrames,
      holdFrames: p.holdFrames
    }))
  });

  const segmentPlans = basePlans.map((p, idx) => {
    const win = schedule.segments[idx];
    return {
      ...p,
      startFrame: win.startFrame,
      endFrame: win.endFrame,
      holdEndFrame: win.holdEndFrame,
      waveIndex: win.waveIndex,
      scheduledDuration: Math.max(1, win.endFrame - win.startFrame)
    };
  });

  type SegmentPlan = (typeof segmentPlans)[number];

  const segmentMarkers: VideoSegmentMarker[] = segmentPlans.map((p, idx) => ({
    index: idx,
    label: p.line.name,
    color: p.line.color,
    startFrame: p.startFrame,
    endFrame: p.holdEndFrame
  }));

  const totalFrames = schedule.totalFrames;

  // 预计算每座车站被各条线路首次点亮的精确帧号（天然支持同年多线并行到达与换乘升级脉冲）
  interface StationLineArrival {
    lineId: string;
    color: string;
    frame: number;
  }
  const stationArrivalsMap = new Map<string, StationLineArrival[]>();
  segmentPlans.forEach((plan) => {
    plan.stationIds.forEach((stId, k) => {
      const distRatio = plan.stationDistances[k] / Math.max(1e-6, plan.metrics.totalLength);
      const arrFrame = plan.startFrame + videoArrivalProgress(distRatio) * plan.scheduledDuration;
      let list = stationArrivalsMap.get(stId);
      if (!list) {
        list = [];
        stationArrivalsMap.set(stId, list);
      }
      const existing = list.find((a) => a.lineId === plan.line.id);
      if (existing) {
        existing.frame = Math.min(existing.frame, arrFrame);
      } else {
        list.push({ lineId: plan.line.id, color: plan.line.color, frame: arrFrame });
      }
    });
  });
  stationArrivalsMap.forEach((list) => list.sort((a, b) => a.frame - b.frame));

  // 预计算每一批次（Opening Wave）的走廊构图框，并生成零跳变双向高斯平滑相机曲线（O(1) 随机预览定位）
  const waveCameras = schedule.waves.map((wave) => {
    let wMinX = Infinity;
    let wMinY = Infinity;
    let wMaxX = -Infinity;
    let wMaxY = -Infinity;
    let startSumX = 0;
    let startSumY = 0;
    let endSumX = 0;
    let endSumY = 0;
    wave.segmentIndices.forEach((segIdx) => {
      const p = segmentPlans[segIdx];
      wMinX = Math.min(wMinX, p.bounds.minX);
      wMinY = Math.min(wMinY, p.bounds.minY);
      wMaxX = Math.max(wMaxX, p.bounds.maxX);
      wMaxY = Math.max(wMaxY, p.bounds.maxY);
      startSumX += p.points[0].x;
      startSumY += p.points[0].y;
      endSumX += p.points[p.points.length - 1].x;
      endSumY += p.points[p.points.length - 1].y;
    });
    const k = Math.max(1, wave.segmentIndices.length);
    const spanW = Math.max(mapWidth * 0.28, (wMaxX - wMinX) * 1.55);
    const spanH = Math.max(mapHeight * 0.28, (wMaxY - wMinY) * 1.65);
    const fitWaveScale = Math.min((width - padX * 2) / Math.max(1, spanW), (height - padTop - padBottom) / Math.max(1, spanH));
    const corridorScale = clamp(fitWaveScale, defaultCamera.scale * 1.03, defaultCamera.scale * 1.38);
    const corridorCx = lerp(defaultCamera.x, (wMinX + wMaxX) / 2, 0.7);
    const corridorCy = lerp(defaultCamera.y, (wMinY + wMaxY) / 2 + verticalBiasWorld * 0.55, 0.7);
    return {
      cx: corridorCx,
      cy: corridorCy,
      scale: corridorScale,
      startAnchor: { x: startSumX / k, y: startSumY / k },
      endAnchor: { x: endSumX / k, y: endSumY / k }
    };
  });

  const rawCamX = new Float64Array(totalFrames);
  const rawCamY = new Float64Array(totalFrames);
  const rawLogS = new Float64Array(totalFrames);
  const bodyEndFrame = titleFrames + schedule.bodyFrames;

  for (let f = 0; f < totalFrames; f += 1) {
    if (cameraMode === 'overview') {
      // 全景纪录片微呼吸推镜（0.985x -> 1.028x -> 1.00x），让画面沉稳而不死板
      const filmU = f / Math.max(1, totalFrames - 1);
      const breath = f < bodyEndFrame ? lerp(0.986, 1.024, Math.sin(filmU * Math.PI * 0.85)) : lerp(1.024, 1.0, inOutQuint((f - bodyEndFrame) / Math.max(1, outroFrames)));
      rawCamX[f] = defaultCamera.x;
      rawCamY[f] = defaultCamera.y;
      rawLogS[f] = Math.log(Math.max(0.02, defaultCamera.scale * breath));
      continue;
    }

    if (f < titleFrames) {
      const introU = inOutCubic(f / Math.max(1, titleFrames));
      const w0 = waveCameras[0];
      rawCamX[f] = w0 ? lerp(defaultCamera.x, lerp(defaultCamera.x, w0.cx, 0.35), introU) : defaultCamera.x;
      rawCamY[f] = w0 ? lerp(defaultCamera.y, lerp(defaultCamera.y, w0.cy, 0.35), introU) : defaultCamera.y;
      rawLogS[f] = Math.log(Math.max(0.02, defaultCamera.scale * lerp(0.96, 1.02, introU)));
      continue;
    }

    if (f >= bodyEndFrame || waveCameras.length === 0) {
      rawCamX[f] = defaultCamera.x;
      rawCamY[f] = defaultCamera.y;
      rawLogS[f] = Math.log(Math.max(0.02, defaultCamera.scale));
      continue;
    }

    // 定位当前所处或相邻批次
    let activeWaveIdx = schedule.waves.findIndex((w) => f >= w.startFrame && f <= w.holdEndFrame);
    if (activeWaveIdx >= 0) {
      const w = schedule.waves[activeWaveIdx];
      const wc = waveCameras[activeWaveIdx];
      const waveU = clamp01((f - w.startFrame) / Math.max(1, w.endFrame - w.startFrame));
      const easedU = easeVideoProgress(waveU);
      if (cameraMode === 'gentle') {
        const driftX = lerp(wc.startAnchor.x, wc.endAnchor.x, easedU) - (wc.startAnchor.x + wc.endAnchor.x) * 0.5;
        const driftY = lerp(wc.startAnchor.y, wc.endAnchor.y, easedU) - (wc.startAnchor.y + wc.endAnchor.y) * 0.5;
        rawCamX[f] = wc.cx + driftX * 0.18;
        rawCamY[f] = wc.cy + driftY * 0.18;
        rawLogS[f] = Math.log(Math.max(0.02, wc.scale));
      } else {
        // follow：平滑追踪当期活跃线头重心
        let sumHx = 0;
        let sumHy = 0;
        let hCount = 0;
        w.segmentIndices.forEach((segIdx) => {
          const plan = segmentPlans[segIdx];
          const pU = clamp01((f - plan.startFrame) / plan.scheduledDuration);
          const pt = getPointAtDistance(plan.metrics, plan.metrics.totalLength * easeVideoProgress(pU));
          sumHx += pt.x;
          sumHy += pt.y;
          hCount += 1;
        });
        rawCamX[f] = hCount > 0 ? sumHx / hCount : wc.cx;
        rawCamY[f] = hCount > 0 ? sumHy / hCount : wc.cy;
        rawLogS[f] = Math.log(Math.max(0.02, defaultCamera.scale * 1.52));
      }
    } else {
      // 处于两个批次之间的年份快进桥：三次平滑移镜至下一走廊
      let nextIdx = schedule.waves.findIndex((w) => w.startFrame > f);
      if (nextIdx <= 0) nextIdx = 0;
      const prevIdx = Math.max(0, nextIdx - 1);
      const wPrev = schedule.waves[prevIdx];
      const wNext = schedule.waves[nextIdx];
      const bridgeU = inOutCubic((f - wPrev.holdEndFrame) / Math.max(1, wNext.startFrame - wPrev.holdEndFrame));
      const cPrev = waveCameras[prevIdx];
      const cNext = waveCameras[nextIdx];
      rawCamX[f] = lerp(cPrev.cx, cNext.cx, bridgeU);
      rawCamY[f] = lerp(cPrev.cy, cNext.cy, bridgeU);
      const sPrev = cameraMode === 'follow' ? defaultCamera.scale * 1.32 : cPrev.scale;
      const sNext = cameraMode === 'follow' ? defaultCamera.scale * 1.32 : cNext.scale;
      rawLogS[f] = Math.log(Math.max(0.02, lerp(sPrev, sNext, bridgeU)));
    }
  }

  const smoothRadius = cameraMode === 'overview' ? 2 : Math.max(4, Math.round(fps * 0.34));
  const smoothCamX = smoothTrackArray(rawCamX, smoothRadius, 3);
  const smoothCamY = smoothTrackArray(rawCamY, smoothRadius, 3);
  const smoothLogS = smoothTrackArray(rawLogS, smoothRadius, 3);

  // 自动生成的片头副标题（当用户未手填副标题时，展示纪年跨度与规模摘要，避免片头单薄）
  const totalUniqueLines = new Set(segmentPlans.map((p) => p.line.id)).size;
  const totalUniqueStations = new Set(segmentPlans.flatMap((p) => p.stationIds)).size;
  const firstBadge = extractVideoEraBadge(segmentPlans[0].segment, 0, dateMode);
  const lastBadge = extractVideoEraBadge(segmentPlans[segmentPlans.length - 1].segment, segmentPlans.length - 1, dateMode);
  const autoSubtitle =
    dateMode === 'date' && firstBadge !== lastBadge
      ? `${firstBadge} — ${lastBadge}  ·  ${totalUniqueLines} 条线路  ·  ${totalUniqueStations} 座车站`
      : `${totalUniqueLines} 条线路  ·  ${totalUniqueStations} 座车站`;
  const effectiveSubtitle = userSubtitleText || autoSubtitle;

  const popSpanFrames = Math.max(7, Math.round(fps * 0.38));
  const labelRevealFrames = Math.max(8, Math.round(fps * 0.42));
  const icRippleFrames = Math.max(12, Math.round(fps * 0.68));

  const drawFrame = (ctx: CanvasRenderingContext2D, rawFrame: number) => {
    const frame = Math.max(0, Math.min(totalFrames - 1, Math.floor(rawFrame)));
    camera.x = smoothCamX[frame];
    camera.y = smoothCamY[frame];
    camera.scale = Math.exp(smoothLogS[frame]);

    const camRatio = camera.scale / Math.max(0.02, defaultCamera.scale);
    const darkOutlineColor = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';
    const isOutro = frame >= bodyEndFrame;
    const outroProgress = isOutro ? clamp01((frame - bodyEndFrame) / Math.max(1, outroFrames * 0.45)) : 0;

    // 1. 绘制背景与底图
    const drawBackdrop = () => {
      ctx.clearRect(0, 0, width, height);
      if (isLightCityVideo) {
        const lcPal = getLightCityPalette(usesDarkVideoSurface);
        ctx.fillStyle = lcPal.canvasBg;
        ctx.fillRect(0, 0, width, height);
        drawLightCityToCanvas2D({
          ctx,
          lightCity: settings.baseMap.lightCity,
          isDark: usesDarkVideoSurface,
          worldToCanvas,
          worldScale: camera.scale,
          fontStack: SANS_STACK
        });
      } else {
        const bgGrad = ctx.createRadialGradient(
          width * 0.5,
          height * 0.44,
          width * 0.05,
          width * 0.5,
          height * 0.5,
          Math.max(width, height) * 0.78
        );
        if (usesDarkVideoSurface) {
          bgGrad.addColorStop(0, '#0b1426');
          bgGrad.addColorStop(0.58, '#060b16');
          bgGrad.addColorStop(1, '#03060d');
        } else {
          bgGrad.addColorStop(0, '#ffffff');
          bgGrad.addColorStop(0.65, '#f6f8fc');
          bgGrad.addColorStop(1, '#edf2f9');
        }
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        if (amapImages.length > 0) {
          amapImages.forEach(({ patch, image }) => {
            const topLeft = worldToCanvas({ x: patch.x, y: patch.y });
            const patchWidth = patch.coreWidth * camera.scale;
            const patchHeight = patch.coreHeight * camera.scale;
            if (topLeft.x > width || topLeft.y > height || topLeft.x + patchWidth < 0 || topLeft.y + patchHeight < 0) return;
            const origin = worldToCanvas({ x: patch.imageX, y: patch.imageY });
            ctx.save();
            ctx.beginPath();
            ctx.rect(topLeft.x, topLeft.y, patchWidth + 0.5, patchHeight + 0.5);
            ctx.clip();
            ctx.drawImage(image, origin.x, origin.y, patch.imageWidth * camera.scale, patch.imageHeight * camera.scale);
            ctx.restore();
          });
        } else {
          // 精密制图坐标微点阵
          const step = Math.max(26, Math.round(38 * uiScale));
          const offsetX = ((width / 2 - camera.x * camera.scale) % step + step) % step;
          const offsetY = ((height / 2 - camera.y * camera.scale) % step + step) % step;
          ctx.save();
          ctx.fillStyle = usesDarkVideoSurface ? 'rgba(148, 197, 253, 0.08)' : 'rgba(100, 116, 139, 0.13)';
          for (let gx = offsetX; gx < width; gx += step) {
            for (let gy = offsetY; gy < height; gy += step) {
              ctx.fillRect(gx - 0.9, gy - 0.9, 1.8, 1.8);
            }
          }
          ctx.restore();
        }
      }

      // 电影感柔和外暗角（Vignette），消除平涂 Excel 感
      const vig = ctx.createRadialGradient(
        width * 0.5,
        height * 0.48,
        Math.min(width, height) * 0.34,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.76
      );
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, usesDarkVideoSurface ? 'rgba(1, 3, 10, 0.56)' : 'rgba(15, 23, 42, 0.065)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);
    };

    const drawPolylinePoints = (
      pts: VideoPoint[],
      strokeStyle: string,
      pxWidth: number,
      alpha = 1,
      dashed = false,
      glowColor?: string,
      glowBlur = 0
    ) => {
      if (pts.length < 2 || alpha <= 0.005) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = pxWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (dashed) {
        ctx.setLineDash([Math.max(5, 7 * uiScale), Math.max(5, 6.5 * uiScale)]);
      }
      if (glowColor && glowBlur > 0) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
      }
      ctx.beginPath();
      const p0 = worldToCanvas(pts[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i += 1) {
        const p = worldToCanvas(pts[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    };

    // 流光前锋（Comet Glow Front）：尾迹高亮 + 柔和径向光晕核
    const drawCometFront = (metrics: ReturnType<typeof getPathMetrics>, currentDist: number, color: string) => {
      const tipWorld = getPointAtDistance(metrics, currentDist);
      const tip = worldToCanvas(tipWorld);
      const baseLw = preset.lineWidth * mapScale * camRatio;
      const tailLenWorld = Math.min(currentDist, (44 * uiScale) / Math.max(0.12, camera.scale));

      if (tailLenWorld > 0.5) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 16 * uiScale;
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.72;
        ctx.lineWidth = baseLw * 0.52;
        strokePathSlice(ctx, metrics, currentDist - tailLenWorld, currentDist);
        ctx.restore();
      }

      const glowR = Math.max(10, baseLw * 2.5);
      const rad = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, glowR);
      rad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
      rad.addColorStop(0.28, color);
      rad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.save();
      ctx.globalCompositeOperation = usesDarkVideoSurface ? 'lighter' : 'source-over';
      ctx.fillStyle = rad;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, baseLw * 0.36);
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, Math.max(3.5, baseLw * 0.68), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    const fillArcBand = (
      cx: number,
      cy: number,
      rOuter: number,
      rInner: number,
      startDeg: number,
      sweepDeg: number,
      color: string
    ) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, degToRad(startDeg), degToRad(startDeg + sweepDeg));
      ctx.arc(cx, cy, rInner, degToRad(startDeg + sweepDeg), degToRad(startDeg), true);
      ctx.closePath();
      ctx.fill();
    };

    const drawStationNode = (station: Station, evalFrame: number) => {
      const arrivals = stationArrivalsMap.get(station.id) || [];
      const activeArrivals = arrivals.filter((a) => evalFrame >= a.frame);
      const isActive = activeArrivals.length > 0;
      if (!isActive && unopenedStyle === 'hidden') return;

      const colors = activeArrivals.map((a) => a.color);
      const isInterchange = colors.length > 1;
      const singleLineNudge = !isInterchange ? videoParallelLayout.stationTrackNudges.get(station.id) : undefined;
      const baseWorld = stationWorld(station);
      const point = singleLineNudge
        ? worldToCanvas({ x: baseWorld.x + singleLineNudge.dx, y: baseWorld.y + singleLineNudge.dy })
        : toCanvasPoint(station);

      const firstArr = activeArrivals[0];
      const popScale = isActive ? outBack((evalFrame - firstArr.frame) / popSpanFrames) : 0.88;
      const stationScale = mapScale * camRatio * Math.max(0.05, popScale);
      const fallbackColor = colors[0] || mutedStationStroke;

      ctx.save();
      // 初次到站柔和单环涟漪
      if (isActive) {
        const firstElapsed = evalFrame - firstArr.frame;
        if (firstElapsed >= 0 && firstElapsed <= popSpanFrames * 1.25) {
          const u = firstElapsed / (popSpanFrames * 1.25);
          ctx.save();
          ctx.globalAlpha = 0.36 * (1 - u);
          ctx.strokeStyle = firstArr.color;
          ctx.lineWidth = Math.max(1.5, 2.6 * mapScale * camRatio);
          ctx.beginPath();
          ctx.arc(point.x, point.y, (preset.normalStationRadius + 3 + outCubic(u) * 15) * mapScale * camRatio, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // 升级为换乘枢纽瞬间的双环合龙脉冲
      if (isInterchange && activeArrivals[1]) {
        const icElapsed = evalFrame - activeArrivals[1].frame;
        if (icElapsed >= 0 && icElapsed <= icRippleFrames) {
          const u = icElapsed / icRippleFrames;
          ctx.save();
          ctx.globalAlpha = 0.52 * (1 - u);
          ctx.strokeStyle = activeArrivals[1].color;
          ctx.lineWidth = Math.max(2, 3.4 * mapScale * camRatio * (1 - u * 0.4));
          ctx.beginPath();
          ctx.arc(point.x, point.y, (preset.interchangeRadius + 4 + outCubic(u) * 24) * mapScale * camRatio, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      if (isInterchange) {
        const icMorph = outBack((evalFrame - activeArrivals[1].frame) / popSpanFrames);
        const plan = planInterchange(preset.interchangeShape, preset.interchangeOuterStroke, colors);
        const r = lerp(preset.normalStationRadius, preset.interchangeRadius, clamp(icMorph, 0, 1.16)) * mapScale * camRatio;
        const ringW = preset.interchangeStrokeWidth * mapScale * camRatio;

        if (plan.shape === 'curvedArrows') {
          const innerR = r * 0.42;
          const outerR = r * 0.72;
          ctx.fillStyle = mutedStationFill;
          ctx.beginPath();
          ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
          ctx.fill();
          plan.curvedArrows.forEach((arrow) => {
            fillCurvedArrowCanvas2d(ctx, point.x, point.y, innerR, outerR, arrow);
          });
          const strokeColor = plan.outerStroke === 'lineColor' ? colors[0] || fallbackColor : darkOutlineColor;
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = ringW;
          ctx.beginPath();
          ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
          ctx.stroke();
        } else if (plan.shape === 'lineColorArcs') {
          ctx.fillStyle = mutedStationFill;
          ctx.beginPath();
          ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
          ctx.fill();
          const rInner = Math.max(0, r - ringW);
          plan.sectors.forEach((s) => fillArcBand(point.x, point.y, r, rInner, s.startDeg, s.sweepDeg, s.color));
        } else {
          ctx.fillStyle = mutedStationFill;
          ctx.strokeStyle = darkOutlineColor;
          ctx.lineWidth = ringW;
          ctx.beginPath();
          ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.lineWidth = ringW * 0.5;
          ctx.beginPath();
          ctx.arc(point.x, point.y, preset.interchangeInnerRadius * mapScale * camRatio, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }

      const r = preset.normalStationRadius * stationScale;
      const sw = preset.normalStationStrokeWidth * stationScale;
      if (!isActive) {
        ctx.globalAlpha = 0.52;
        ctx.fillStyle = mutedStationFill;
        ctx.strokeStyle = mutedStationStroke;
        ctx.lineWidth = sw;
      } else if (preset.stationShape === 'ring') {
        ctx.fillStyle = mutedStationFill;
        ctx.strokeStyle = fallbackColor;
        ctx.lineWidth = sw;
      } else {
        ctx.fillStyle = fallbackColor;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = sw;
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(1.2, r), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    // 整词微上浮平滑渐显站名（废除半截字符蹦字）
    const drawStationLabelSmooth = (station: Station, placement: LabelPlacement, revealU: number, baseAlpha: number) => {
      const eased = outCubic(revealU);
      const finalAlpha = baseAlpha * eased;
      if (finalAlpha <= 0.02) return;

      const stationFitAll = toFitAllCanvasPoint(station);
      const stationNow = toCanvasPoint(station);
      const deltaX = (placement.textX - stationFitAll.x) * camRatio;
      const deltaY = (placement.textY - stationFitAll.y) * camRatio;
      const floatOffsetY = (1 - eased) * 5.5 * uiScale;
      const textX = stationNow.x + deltaX;
      const textY = stationNow.y + deltaY + floatOffsetY;
      const scaledFontPx = Math.round(labelFontSizeBase * Math.max(0.88, Math.min(1.38, Math.pow(camRatio, 0.68))));

      ctx.save();
      ctx.globalAlpha = finalAlpha;
      ctx.font = `${settings.dotLabelStyle.fontWeight} ${scaledFontPx}px ${SANS_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = (usesDarkVideoSurface ? 4.2 : 4.8) * Math.max(0.9, uiScale);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = textHalo;
      ctx.strokeText(station.name, textX, textY);
      ctx.fillStyle = usesDarkVideoSurface ? primaryText : settings.dotLabelStyle.color || primaryText;
      ctx.fillText(station.name, textX, textY);
      ctx.restore();
    };

    const drawLineEndpointBadges = (activeStationLines: Map<string, Set<string>>, alpha: number) => {
      if (!settings.showLineNameLabels || alpha <= 0.03) return;
      const occupied: RectBox[] = allStations.map((station) => {
        const point = toCanvasPoint(station);
        const radius =
          ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) *
            mapScale *
            camRatio +
          8;
        return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
      });
      const pillFontPx = Math.round(preset.lineLabelFontSize * Math.max(0.86, uiScale) * Math.pow(camRatio, 0.52));

      allLines.forEach((line) => {
        const ordered = line.stationIds
          .filter((id) => activeStationLines.get(id)?.has(line.id))
          .map((id) => stationById.get(id))
          .filter(Boolean) as Station[];
        if (ordered.length < 2) return;
        const label = line.name;
        ctx.font = `700 ${pillFontPx}px ${SANS_STACK}`;
        const labelWidth = Math.max(52 * uiScale, ctx.measureText(label).width + 18 * uiScale);
        const labelHeight = pillFontPx + 11 * uiScale;
        const terminalPairs = [
          { terminal: ordered[0], neighbor: ordered[1], preference: 0 },
          { terminal: ordered[ordered.length - 1], neighbor: ordered[ordered.length - 2], preference: 4 }
        ];
        const best = terminalPairs
          .flatMap(({ terminal, neighbor, preference }) => {
            if (!terminal || !neighbor) return [];
            const terminalPoint = toCanvasPoint(terminal);
            const neighborPoint = toCanvasPoint(neighbor);
            const dx = terminalPoint.x - neighborPoint.x;
            const dy = terminalPoint.y - neighborPoint.y;
            const len = Math.hypot(dx, dy) || 1;
            const outward = { x: dx / len, y: dy / len };
            const normal = { x: -outward.y, y: outward.x };
            const baseDistance = Math.max(24 * uiScale, preset.interchangeRadius * mapScale * camRatio + 16 * uiScale);
            return [0, labelHeight + 8, -(labelHeight + 8)].map((sideOffset, index) => {
              const centerX = terminalPoint.x + outward.x * (baseDistance + labelWidth / 2) + normal.x * sideOffset;
              const centerY = terminalPoint.y + outward.y * (baseDistance + labelHeight / 2) + normal.y * sideOffset;
              return {
                x: centerX - labelWidth / 2,
                y: centerY - labelHeight / 2,
                width: labelWidth,
                height: labelHeight,
                score: preference + index * 2
              };
            });
          })
          .map((candidate) => {
            let score = candidate.score;
            occupied.forEach((other) => {
              if (rectsOverlap(candidate, other)) score += 90;
            });
            if (candidate.x < 14 || candidate.y < 14 || candidate.x + candidate.width > width - 14 || candidate.y + candidate.height > height - 135) {
              score += 35;
            }
            return { ...candidate, score };
          })
          .sort((a, b) => a.score - b.score)[0];
        if (!best) return;
        occupied.push(best);
        ctx.save();
        ctx.globalAlpha = alpha;
        roundRect(ctx, best.x, best.y, best.width, best.height, best.height / 2);
        ctx.fillStyle = usesDarkVideoSurface ? 'rgba(15, 23, 42, 0.90)' : 'rgba(255, 255, 255, 0.94)';
        ctx.strokeStyle = line.color;
        ctx.lineWidth = Math.max(1.6, 2 * uiScale);
        ctx.fill();
        ctx.stroke();
        ctx.font = `700 ${pillFontPx}px ${SANS_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = usesDarkVideoSurface ? '#f8fafc' : line.color;
        ctx.fillText(label, best.x + best.width / 2, best.y + best.height / 2);
        ctx.restore();
      });
    };

    // 绘制指定时间帧的完整线网空间场景，并返回实时累计指标（供左下角滚轮计数器使用）
    const renderNetworkAtFrame = (evalFrame: number, introPreview = false) => {
      drawBackdrop();
      const baseLw = preset.lineWidth * mapScale * camRatio;
      const casingLw = baseLw + Math.max(2.2, 3.2 * uiScale * camRatio);

      // 1. 远期规划/在建虚线底轨（简办风）
      if (unopenedStyle === 'ghost') {
        allSections.forEach((section) => {
          drawPolylinePoints(
            sectionPoints.get(section.id) || [],
            mutedLineColor,
            Math.max(1.5, baseLw * 0.72),
            introPreview ? 0.55 : 0.85,
            true
          );
        });
      }

      if (introPreview) {
        allStations.forEach((st) => drawStationNode(st, -1));
        return { openedLineCount: 0, openedStationCount: 0, totalKm: 0, activePlans: [] as Array<{ plan: SegmentPlan; u: number }> };
      }

      const completedPlans: SegmentPlan[] = [];
      const growingPlans: Array<{ plan: SegmentPlan; easedRatio: number; dist: number }> = [];
      const activeBannerPlans: Array<{ plan: SegmentPlan; u: number }> = [];
      const openedLineSet = new Set<string>();
      let accumulatedKm = 0;

      segmentPlans.forEach((plan) => {
        if (evalFrame < plan.startFrame) return;
        openedLineSet.add(plan.line.id);
        if (evalFrame >= plan.endFrame) {
          completedPlans.push(plan);
          accumulatedKm += plan.routeKm;
          if (evalFrame <= plan.holdEndFrame) {
            activeBannerPlans.push({ plan, u: 1 });
          }
        } else {
          const rawU = clamp01((evalFrame - plan.startFrame) / plan.scheduledDuration);
          const eased = easeVideoProgress(rawU);
          const dist = plan.metrics.totalLength * eased;
          growingPlans.push({ plan, easedRatio: eased, dist });
          activeBannerPlans.push({ plan, u: eased });
          accumulatedKm += plan.routeKm * eased;
        }
      });

      // 当有新线正在生长时，既有老线微退至 0.84 沉稳亮度突出当期焦点；片尾总览全部恢复 1.0
      const settledAlpha = growingPlans.length > 0 ? 0.84 : lerp(0.9, 1.0, outroProgress);

      // 2. 已开通线路（带桥式底衬描边防交叉糊色）
      completedPlans.forEach((plan) => {
        drawPolylinePoints(plan.points, surfaceCasingColor, casingLw, settledAlpha * 0.9);
        drawPolylinePoints(plan.points, plan.line.color, baseLw, settledAlpha);
      });

      // 3. 当前正在破土延伸的新线（外层柔光晕 + 桥式底衬 + 100% 饱满主线）
      growingPlans.forEach(({ plan, dist }) => {
        if (dist <= 0.2) return;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = usesDarkVideoSurface ? 0.28 : 0.18;
        ctx.strokeStyle = plan.line.color;
        ctx.lineWidth = baseLw * 2.5;
        strokePathSlice(ctx, plan.metrics, 0, dist);
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.94;
        ctx.strokeStyle = surfaceCasingColor;
        ctx.lineWidth = casingLw;
        strokePathSlice(ctx, plan.metrics, 0, dist);
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = plan.line.color;
        ctx.lineWidth = baseLw * 1.08;
        strokePathSlice(ctx, plan.metrics, 0, dist);
        ctx.restore();
      });

      // 4. 站点圆点与换乘枢纽符号
      const activeStationLines = new Map<string, Set<string>>();
      let openedStationCount = 0;
      allStations.forEach((st) => {
        const arrs = (stationArrivalsMap.get(st.id) || []).filter((a) => evalFrame >= a.frame);
        if (arrs.length > 0) {
          openedStationCount += 1;
          activeStationLines.set(st.id, new Set(arrs.map((a) => a.lineId)));
        }
        drawStationNode(st, evalFrame);
      });

      // 5. 流光前锋（置顶于普通站点之上，更具推进力）
      growingPlans.forEach(({ plan, dist }) => {
        if (dist > 0.2) {
          drawCometFront(plan.metrics, dist, plan.line.color);
        }
      });

      // 6. 线路首末站胶囊徽标
      drawLineEndpointBadges(activeStationLines, growingPlans.length > 0 ? 0.78 : 0.94);

      // 7. 站名整词上浮平滑标注
      const canShowLabel = (id: string) =>
        settings.labelDensity !== 'key' ||
        (activeStationLines.get(id)?.size || 0) > 1 ||
        keyStationIds.has(id);

      allStations.forEach((st) => {
        if (!canShowLabel(st.id)) return;
        const arrs = stationArrivalsMap.get(st.id);
        if (!arrs || !arrs.length || evalFrame < arrs[0].frame) return;
        const placement = labelPlacements.get(st.id);
        if (!placement) return;
        const elapsed = evalFrame - arrs[0].frame;
        const revealU = clamp01(elapsed / labelRevealFrames);
        const isFresh = elapsed < fps * 1.6;
        const targetAlpha = isFresh || isOutro ? 1.0 : growingPlans.length > 0 ? 0.84 : 0.94;
        drawStationLabelSmooth(st, placement, revealU, targetAlpha);
      });

      return {
        openedLineCount: openedLineSet.size,
        openedStationCount,
        totalKm: accumulatedKm,
        activePlans: activeBannerPlans
      };
    };

    // 2. 绘制 promo-v3 同款左下角无框大数字纪年 + 实时滚轮统计表
    const drawChronicleBottomHud = (stats: { openedLineCount: number; openedStationCount: number; totalKm: number }) => {
      const marginX = Math.round((isPortrait ? 36 : 56) * uiScale);
      const bottomY = height - Math.round((isPortrait ? 44 : 48) * uiScale);

      // 左下角柔和径向护眼衬底（无生硬矩形框，保任何底图 100% 清晰可读）
      const shadeW = Math.round((isPortrait ? width * 0.95 : 880 * uiScale));
      const shadeH = Math.round((isPortrait ? 260 : 230) * uiScale);
      const shadeGrad = ctx.createRadialGradient(
        marginX + shadeW * 0.16,
        height,
        10,
        marginX + shadeW * 0.18,
        height,
        Math.max(shadeW, shadeH) * 0.86
      );
      if (usesDarkVideoSurface) {
        shadeGrad.addColorStop(0, 'rgba(3, 6, 15, 0.86)');
        shadeGrad.addColorStop(0.52, 'rgba(3, 6, 15, 0.46)');
        shadeGrad.addColorStop(1, 'rgba(3, 6, 15, 0)');
      } else {
        shadeGrad.addColorStop(0, 'rgba(246, 248, 252, 0.92)');
        shadeGrad.addColorStop(0.55, 'rgba(246, 248, 252, 0.56)');
        shadeGrad.addColorStop(1, 'rgba(246, 248, 252, 0)');
      }
      ctx.save();
      ctx.fillStyle = shadeGrad;
      ctx.fillRect(0, height - shadeH, shadeW + marginX, shadeH);

      let statsStartX = marginX;

      if (showYearBadge) {
        const rollingYear = schedule.yearAtFrame(frame);
        let heroText = '';
        if (dateMode === 'date' && rollingYear !== null) {
          heroText = String(Math.floor(rollingYear + 1e-4));
        } else {
          // 阶段模式：取最近已开启段标签
          let latestPlan = segmentPlans[0];
          for (let i = 0; i < segmentPlans.length; i += 1) {
            if (frame >= segmentPlans[i].startFrame) latestPlan = segmentPlans[i];
          }
          heroText = extractVideoEraBadge(latestPlan.segment, latestPlan.stepIndex, dateMode);
        }

        const isFourDigitYear = /^\d{4}$/.test(heroText);
        const yearPx = Math.round((isFourDigitYear ? (isPortrait ? 86 : 112) : isPortrait ? 46 : 58) * uiScale);
        const kickerPx = Math.max(10, Math.round(12.5 * uiScale));

        ctx.font = `600 ${kickerPx}px ${MONO_STACK}`;
        ctx.fillStyle = usesDarkVideoSurface ? '#8aa4c8' : '#64748b';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const kickerLabel = dateMode === 'date' ? 'OPENING YEAR · 开通纪年' : 'PHASE · 建设分期';
        ctx.fillText(kickerLabel, marginX, bottomY - yearPx - Math.round(8 * uiScale));

        ctx.font = `${isFourDigitYear ? 300 : 800} ${yearPx}px ${isFourDigitYear ? NUM_STACK : SANS_STACK}`;
        const yearGrad = ctx.createLinearGradient(0, bottomY - yearPx, 0, bottomY);
        if (usesDarkVideoSurface) {
          yearGrad.addColorStop(0, '#ffffff');
          yearGrad.addColorStop(1, '#b8ccf0');
        } else {
          yearGrad.addColorStop(0, '#0f172a');
          yearGrad.addColorStop(1, '#334155');
        }
        ctx.fillStyle = yearGrad;
        ctx.fillText(heroText, marginX, bottomY);

        const measuredHeroW = ctx.measureText(heroText).width;
        statsStartX = marginX + measuredHeroW + Math.round((isPortrait ? 28 : 44) * uiScale);

        // 竖向极细分割线
        const sepX = marginX + measuredHeroW + Math.round((isPortrait ? 14 : 22) * uiScale);
        ctx.strokeStyle = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.24)' : 'rgba(15, 23, 42, 0.14)';
        ctx.lineWidth = Math.max(1, 1.2 * uiScale);
        ctx.beginPath();
        ctx.moveTo(sepX, bottomY - Math.round(yearPx * 0.68));
        ctx.lineTo(sepX, bottomY - Math.round(6 * uiScale));
        ctx.stroke();
      }

      // 三列等宽动态计数器：线路 LINES / 车站 STATIONS / 里程 KM
      const numPx = Math.round((isPortrait ? 32 : 42) * uiScale);
      const unitPx = Math.max(10, Math.round(12 * uiScale));
      const colGap = Math.round((isPortrait ? 24 : 38) * uiScale);
      const items = [
        { val: String(stats.openedLineCount).padStart(2, '0'), lbl: '线路 LINES' },
        { val: String(stats.openedStationCount).padStart(3, '0'), lbl: '车站 STATIONS' },
        { val: stats.totalKm >= 100 ? stats.totalKm.toFixed(0) : stats.totalKm.toFixed(1), lbl: '里程 KM' }
      ];

      let cx = statsStartX;
      items.forEach((it) => {
        ctx.font = `400 ${numPx}px ${NUM_STACK}`;
        ctx.fillStyle = primaryText;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(it.val, cx, bottomY - Math.round(18 * uiScale));
        const valW = ctx.measureText(it.val).width;

        ctx.font = `600 ${unitPx}px ${MONO_STACK}`;
        ctx.fillStyle = usesDarkVideoSurface ? '#8aa4c8' : '#64748b';
        ctx.fillText(it.lbl, cx, bottomY - Math.round(2 * uiScale));
        const lblW = ctx.measureText(it.lbl).width;

        cx += Math.max(valW, lblW) + colGap;
      });

      ctx.restore();
    };

    // 3. 绘制左上角「简办动态演示」无框当期开通播报条 + 右上角紧凑已开通线路色标
    const drawTopChronicleOverlays = (activeBannerPlans: Array<{ plan: SegmentPlan; u: number }>) => {
      const margin = Math.round((isPortrait ? 28 : 42) * uiScale);

      if (isOutro) {
        // 片尾总览铭牌
        const fade = outCubic(outroProgress);
        ctx.save();
        ctx.globalAlpha = fade;
        const kickerPx = Math.max(10, Math.round(12.5 * uiScale));
        ctx.font = `600 ${kickerPx}px ${MONO_STACK}`;
        ctx.fillStyle = kickerColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('NETWORK COMPLETE · 线网竣工总览', margin, margin);

        const hPx = Math.max(18, Math.round(28 * uiScale));
        ctx.font = `800 ${hPx}px ${SANS_STACK}`;
        ctx.lineWidth = 4 * uiScale;
        ctx.strokeStyle = textHalo;
        ctx.strokeText(titleText, margin, margin + Math.round(20 * uiScale));
        ctx.fillStyle = primaryText;
        ctx.fillText(titleText, margin, margin + Math.round(20 * uiScale));
        ctx.restore();
      } else if (activeBannerPlans.length > 0) {
        // 最多并排展示当期同时开通的 3 条线路动态字幕条
        const visibleBanners = activeBannerPlans.slice(-3);
        const rowH = Math.round(38 * uiScale);
        const rowGap = Math.round(8 * uiScale);

        visibleBanners.forEach(({ plan }, idx) => {
          const enterFrames = Math.max(5, Math.round(fps * 0.26));
          const exitFrames = Math.max(5, Math.round(fps * 0.24));
          const enterU = outCubic((frame - plan.startFrame) / enterFrames);
          const exitU = outCubic((plan.holdEndFrame - frame) / exitFrames);
          const visAlpha = Math.min(enterU, exitU);
          if (visAlpha <= 0.02) return;

          const slideY = (1 - enterU) * -10 * uiScale + (1 - exitU) * -6 * uiScale;
          const ry = margin + idx * (rowH + rowGap) + slideY;
          const startSt = stationById.get(plan.stationIds[0]);
          const endSt = stationById.get(plan.stationIds[plan.stationIds.length - 1]);
          const dateTag = formatVideoDateLabel(plan.segment, plan.stepIndex, dateMode);
          const routeText = `${startSt?.name || '-'} — ${endSt?.name || '-'}`;
          const metaText = `+${plan.routeKm.toFixed(1)} km · ${plan.stationIds.length}站`;

          const badgeFontPx = Math.max(11, Math.round(13.5 * uiScale));
          const routeFontPx = Math.max(13, Math.round(16 * uiScale));
          const metaFontPx = Math.max(11, Math.round(12.5 * uiScale));

          ctx.save();
          ctx.globalAlpha = visAlpha;

          ctx.font = `700 ${badgeFontPx}px ${SANS_STACK}`;
          const badgeW = Math.round(ctx.measureText(plan.line.name).width + 20 * uiScale);
          ctx.font = `700 ${routeFontPx}px ${SANS_STACK}`;
          const routeW = ctx.measureText(routeText).width;
          ctx.font = `600 ${metaFontPx}px ${MONO_STACK}`;
          const dateAndMeta = `${dateTag}  ·  ${metaText}`;
          const metaW = ctx.measureText(dateAndMeta).width;

          const totalStripW = Math.min(
            width - margin * 2,
            Math.round(badgeW + 14 * uiScale + routeW + 16 * uiScale + metaW + 22 * uiScale)
          );

          // 轻盈毛玻璃胶囊底条（无重边框）
          roundRect(ctx, margin, ry, totalStripW, rowH, rowH / 2);
          ctx.fillStyle = usesDarkVideoSurface ? 'rgba(8, 15, 29, 0.78)' : 'rgba(255, 255, 255, 0.86)';
          ctx.shadowColor = usesDarkVideoSurface ? 'rgba(0, 0, 0, 0.32)' : 'rgba(15, 23, 42, 0.07)';
          ctx.shadowBlur = 14 * uiScale;
          ctx.fill();
          ctx.shadowBlur = 0;

          // 左侧线路彩色胶囊
          const innerPad = Math.round(4 * uiScale);
          const pillH = rowH - innerPad * 2;
          roundRect(ctx, margin + innerPad, ry + innerPad, badgeW, pillH, pillH / 2);
          ctx.fillStyle = plan.line.color;
          ctx.fill();

          ctx.font = `700 ${badgeFontPx}px ${SANS_STACK}`;
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(plan.line.name, margin + innerPad + badgeW / 2, ry + rowH / 2);

          // 起讫区间名
          const textLeft = margin + innerPad + badgeW + Math.round(12 * uiScale);
          ctx.font = `700 ${routeFontPx}px ${SANS_STACK}`;
          ctx.fillStyle = primaryText;
          ctx.textAlign = 'left';
          ctx.fillText(routeText, textLeft, ry + rowH / 2);

          // 日期与新增里程
          const metaLeft = textLeft + routeW + Math.round(14 * uiScale);
          if (metaLeft + 40 * uiScale < margin + totalStripW) {
            ctx.font = `500 ${metaFontPx}px ${MONO_STACK}`;
            ctx.fillStyle = secondaryText;
            ctx.fillText(dateAndMeta, metaLeft, ry + rowH / 2, margin + totalStripW - metaLeft - Math.round(14 * uiScale));
          }

          ctx.restore();
        });
      }

      // 右上角：紧凑低干扰已开通线路圆点图例条
      if (showLineLegend && !isPortrait) {
        const seen = new Set<string>();
        const openedLines: Line[] = [];
        segmentPlans.forEach((p) => {
          if (frame >= p.startFrame && !seen.has(p.line.id)) {
            seen.add(p.line.id);
            openedLines.push(p.line);
          }
        });
        if (openedLines.length > 0) {
          const pillH = Math.round(24 * uiScale);
          const fontPx = Math.max(10, Math.round(12 * uiScale));
          const maxSpanW = Math.round(width * 0.42);
          let rightCursor = width - margin;
          let rowY = margin;

          ctx.save();
          ctx.font = `600 ${fontPx}px ${SANS_STACK}`;
          openedLines.slice(0, 12).forEach((line) => {
            const tw = ctx.measureText(line.name).width;
            const pw = Math.round(tw + 22 * uiScale);
            if (width - margin - (rightCursor - pw) > maxSpanW && rightCursor < width - margin) {
              rightCursor = width - margin;
              rowY += pillH + Math.round(6 * uiScale);
            }
            const px = rightCursor - pw;
            const isGrowingNow = activeBannerPlans.some((b) => b.plan.line.id === line.id && b.u < 1);
            roundRect(ctx, px, rowY, pw, pillH, pillH / 2);
            ctx.fillStyle = isGrowingNow
              ? line.color
              : usesDarkVideoSurface
                ? 'rgba(15, 23, 42, 0.74)'
                : 'rgba(255, 255, 255, 0.82)';
            ctx.fill();

            if (!isGrowingNow) {
              ctx.fillStyle = line.color;
              ctx.beginPath();
              ctx.arc(px + Math.round(10 * uiScale), rowY + pillH / 2, Math.round(3.6 * uiScale), 0, Math.PI * 2);
              ctx.fill();
            }

            ctx.fillStyle = isGrowingNow ? '#ffffff' : primaryText;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(line.name, px + (isGrowingNow ? pw / 2 : pw / 2 + Math.round(4 * uiScale)), rowY + pillH / 2);
            rightCursor = px - Math.round(6 * uiScale);
          });
          ctx.restore();
        }
      }
    };

    // 4. 绘制 promo-v3 电影级片头（多色彩条分割线 + 呼吸感暗影蒙版）
    const drawCinematicIntro = (introFrame: number) => {
      renderNetworkAtFrame(0, true);

      const enterU = outCubic(introFrame / Math.max(1, titleFrames * 0.28));
      const exitU =
        introFrame > titleFrames * 0.74
          ? 1 - inOutCubic((introFrame - titleFrames * 0.74) / Math.max(1, titleFrames * 0.26))
          : 1;
      const alpha = clamp01(Math.min(enterU, exitU));

      ctx.save();
      const shade = ctx.createRadialGradient(
        width * 0.5,
        height * 0.5,
        width * 0.04,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.65
      );
      if (usesDarkVideoSurface) {
        shade.addColorStop(0, `rgba(2, 6, 15, ${0.86 * exitU})`);
        shade.addColorStop(0.65, `rgba(2, 6, 15, ${0.58 * exitU})`);
        shade.addColorStop(1, `rgba(2, 6, 15, ${0.28 * exitU})`);
      } else {
        shade.addColorStop(0, `rgba(248, 250, 252, ${0.92 * exitU})`);
        shade.addColorStop(0.68, `rgba(248, 250, 252, ${0.72 * exitU})`);
        shade.addColorStop(1, `rgba(248, 250, 252, ${0.35 * exitU})`);
      }
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);

      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const liftY = (1 - enterU) * 14 * uiScale;

      // 顶部等宽英文导语（Kicker）
      const kickerPx = Math.max(11, Math.round(14 * uiScale));
      ctx.font = `600 ${kickerPx}px ${MONO_STACK}`;
      ctx.fillStyle = kickerColor;
      ctx.fillText('URBAN RAIL TRANSIT CHRONICLE', width / 2, height / 2 - Math.round(74 * uiScale) + liftY);

      // 主标题
      let mainFontSize = Math.max(30, Math.round((isPortrait ? 64 : 84) * uiScale));
      ctx.font = `800 ${mainFontSize}px ${SANS_STACK}`;
      const maxTitleW = width - Math.round(112 * uiScale);
      const measuredMain = ctx.measureText(titleText).width;
      if (measuredMain > maxTitleW) {
        mainFontSize = Math.max(24, Math.floor((mainFontSize * maxTitleW) / measuredMain));
        ctx.font = `800 ${mainFontSize}px ${SANS_STACK}`;
      }
      ctx.fillStyle = primaryText;
      ctx.fillText(titleText, width / 2, height / 2 - Math.round(12 * uiScale) + liftY);

      // promo-v3 标志性多色轨道横条组（取当前地图真实线路色）
      const uniqueColors = Array.from(new Set(segmentPlans.map((p) => p.line.color))).slice(0, 5);
      if (uniqueColors.length > 0) {
        const barH = Math.max(4, Math.round(6 * uiScale));
        const barW = Math.round(52 * uiScale * (0.6 + 0.4 * enterU));
        const barGap = Math.round(10 * uiScale);
        const totalBarsW = uniqueColors.length * barW + (uniqueColors.length - 1) * barGap;
        const barY = height / 2 + Math.round(38 * uiScale) + liftY;
        uniqueColors.forEach((col, i) => {
          ctx.fillStyle = col;
          roundRect(ctx, width / 2 - totalBarsW / 2 + i * (barW + barGap), barY, barW, barH, barH / 2);
          ctx.fill();
        });
      }

      // 副标题（用户自定义或自动生成的年代里程摘要）
      if (effectiveSubtitle) {
        let subFontSize = Math.max(14, Math.round((isPortrait ? 21 : 25) * uiScale));
        ctx.font = `500 ${subFontSize}px ${SANS_STACK}`;
        const measuredSub = ctx.measureText(effectiveSubtitle).width;
        if (measuredSub > maxTitleW) {
          subFontSize = Math.max(13, Math.floor((subFontSize * maxTitleW) / measuredSub));
          ctx.font = `500 ${subFontSize}px ${SANS_STACK}`;
        }
        ctx.fillStyle = secondaryText;
        ctx.fillText(effectiveSubtitle, width / 2, height / 2 + Math.round(78 * uiScale) + liftY);
      }

      ctx.restore();
    };

    if (frame < titleFrames) {
      drawCinematicIntro(frame);
    } else {
      const stats = renderNetworkAtFrame(frame, false);
      drawTopChronicleOverlays(stats.activePlans);
      drawChronicleBottomHud(stats);
    }

    if (isAmapVideo) {
      ctx.save();
      const attrPx = Math.max(10, Math.round(12 * uiScale));
      ctx.font = `500 ${attrPx}px ${SANS_STACK}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = textHalo;
      ctx.fillStyle = secondaryText;
      const attrText = isPreviewPlaceholderMap ? '预览示意网格（导出时自动加载高清地理底图）' : '© 地图数据 · 静态底图';
      ctx.strokeText(attrText, width - Math.round(18 * uiScale), height - Math.round(10 * uiScale));
      ctx.fillText(attrText, width - Math.round(18 * uiScale), height - Math.round(10 * uiScale));
      ctx.restore();
    }
  };

  return {
    width,
    height,
    fps,
    totalFrames,
    totalDurationSec: totalFrames / fps,
    segmentMarkers,
    drawFrame
  };
}

export async function exportVideoFromStage(opts: ExportVideoOptions): Promise<Blob> {
  const {
    stage,
    segments,
    lines: inputLines,
    stations: inputStations,
    sections: inputSections,
    settings,
    title,
    subtitle,
    titleDurationSec,
    aspectRatio,
    resolution = '1080p',
    fps = 30,
    speedMultiplier = 1,
    cameraMode = 'gentle',
    unopenedStyle = 'ghost',
    dateMode = 'date',
    timelineMode = 'chronicle',
    showYearBadge = true,
    showLineLegend = true,
    metersPerUnit,
    fetchAmapStaticMap,
    signal,
    onProgress
  } = opts;

  if (!segments.length) throw new Error('请至少填写一个开通区间');
  if (!inputStations.length) throw new Error('请先创建站点后再导出视频');
  checkVideoRecordingSupport();
  throwIfVideoAborted(signal);
  onProgress?.({ phase: 'preparing', percent: 0, elapsedSec: 0, totalSec: 0 });

  const stageWidth = Math.max(1, Number(stage?.width?.() || 1280));
  const stageHeight = Math.max(1, Number(stage?.height?.() || 720));
  const { width, height } = computeVideoDimensions(aspectRatio, resolution, stageWidth, stageHeight);

  const isAmapVideo = settings.baseMap.mode === 'amap';
  const amapStyle = settings.baseMap.amap?.style || 'normal';
  const animationSegments = segments.map((segment) =>
    resolveVideoRoute(segment, inputLines, inputStations, inputSections, { dateMode })
  );
  const routeStationIds = new Set(animationSegments.flatMap((route) => route.stationIds));
  const routeSectionIds = new Set(animationSegments.flatMap((route) => route.edges.map((edge) => edge.section.id)));
  const requiredGeoPoints = [
    ...inputStations.filter((station) => routeStationIds.has(station.id)),
    ...inputSections.filter((section) => routeSectionIds.has(section.id)).flatMap((section) => section.waypoints || [])
  ];
  const amapPlan = isAmapVideo ? planAmapVideoMap(requiredGeoPoints, width, height) : null;

  const mapResources: Array<HTMLImageElement | HTMLCanvasElement> = [];
  const releaseMaps = () =>
    mapResources.forEach((image) => {
      if (image instanceof HTMLImageElement) image.src = '';
      else {
        image.width = 0;
        image.height = 0;
      }
    });

  const loadImageFromBlob = (blob: Blob, imageSignal: AbortSignal) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      throwIfVideoAborted(imageSignal);
      const url = URL.createObjectURL(blob);
      const image = new Image();
      const cleanup = () => {
        URL.revokeObjectURL(url);
        imageSignal.removeEventListener('abort', abort);
        image.onload = null;
        image.onerror = null;
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(new DOMException('已取消视频导出', 'AbortError'));
      };
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = () => {
        cleanup();
        reject(new Error('高德静态地图图片加载失败'));
      };
      imageSignal.addEventListener('abort', abort, { once: true });
      image.src = url;
    });

  const amapImages: Array<{ patch: NonNullable<typeof amapPlan>['patches'][number]; image: CanvasImageSource }> = [];
  if (amapPlan) {
    const mapController = new AbortController();
    const abortMaps = () => mapController.abort();
    signal?.addEventListener('abort', abortMaps, { once: true });
    let nextPatch = 0;
    let loaded = 0;
    let mapError: unknown;
    const loadPatches = async () => {
      try {
        while (nextPatch < amapPlan.patches.length) {
          throwIfVideoAborted(mapController.signal);
          const patch = amapPlan.patches[nextPatch++];
          const blob = await fetchAmapStaticMap({
            center: patch.center,
            zoom: patch.zoom,
            width: patch.width,
            height: patch.height,
            scale: 2,
            style: 'normal',
            signal: mapController.signal
          });
          const image = await loadImageFromBlob(blob, mapController.signal);
          mapResources.push(image);
          if (image.naturalWidth !== patch.imageWidth || image.naturalHeight !== patch.imageHeight) {
            throw new Error('高清地理底图返回尺寸与请求不一致，请重试');
          }
          let surface: CanvasImageSource = image;
          const filter = amapVideoFilter(amapStyle);
          if (filter !== 'none') {
            const styled = document.createElement('canvas');
            styled.width = patch.imageWidth;
            styled.height = patch.imageHeight;
            const styledContext = styled.getContext('2d');
            if (!styledContext) throw new Error('浏览器无法创建底图画布');
            styledContext.filter = filter;
            styledContext.drawImage(image, 0, 0);
            styledContext.filter = 'none';
            surface = styled;
            mapResources.push(styled);
            image.src = '';
          }
          amapImages.push({ patch, image: surface });
          loaded += 1;
          onProgress?.({
            phase: 'preparing',
            percent: Math.round((loaded / amapPlan.patches.length) * 100),
            elapsedSec: 0,
            totalSec: 0,
            detail: `正在加载高清底图 ${loaded} / ${amapPlan.patches.length}`
          });
        }
      } catch (error) {
        if (!mapError) mapError = error;
        mapController.abort();
      }
    };
    try {
      throwIfVideoAborted(signal);
      await Promise.all([loadPatches(), loadPatches()]);
      throwIfVideoAborted(signal);
      if (mapError) throw mapError;
    } catch (error) {
      releaseMaps();
      throwIfVideoAborted(signal);
      throw new Error(`地理底图加载失败，已停止导出：${error instanceof Error ? error.message : '请检查网络后重试'}`);
    } finally {
      signal?.removeEventListener('abort', abortMaps);
    }
  }
  throwIfVideoAborted(signal);

  const scene = createVideoSceneRenderer({
    segments,
    lines: inputLines,
    stations: inputStations,
    sections: inputSections,
    settings,
    stageWidth,
    stageHeight,
    title,
    subtitle,
    titleDurationSec,
    aspectRatio,
    resolution,
    fps,
    speedMultiplier,
    cameraMode,
    unopenedStyle,
    dateMode,
    timelineMode,
    showYearBadge,
    showLineLegend,
    metersPerUnit,
    amapPlan,
    amapImages
  });

  const canvas = document.createElement('canvas');
  canvas.width = scene.width;
  canvas.height = scene.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    releaseMaps();
    throw new Error('浏览器不支持导出视频');
  }

  try {
    return await recordVideoCanvas({
      canvas,
      fps: scene.fps,
      totalFrames: scene.totalFrames,
      drawFrame: (frame) => scene.drawFrame(ctx, frame),
      signal,
      onProgress
    });
  } finally {
    releaseMaps();
  }
}

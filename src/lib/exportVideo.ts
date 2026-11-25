// 视频场景渲染与导出引擎：
// 1. createVideoSceneRenderer：纯确定性随机帧渲染器（供弹窗实时拖动预览 + 正式导出共用，100% 所见即所得）
// 2. exportVideoFromStage：预加载高德高清底图（若开启）并通过 WebCodecs 极速合成 MP4（回退 MediaRecorder）

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
  VideoUnopenedStyle,
  Waypoint
} from '../types';
import { getCityStylePreset } from '../stylePresets';
import { planInterchange, degToRad, fillCurvedArrowCanvas2d } from './interchange';
import { drawLightCityToCanvas2D, getLightCityPalette } from './lightCity';
import {
  activeVideoStationLines,
  buildVideoRouteGeometry,
  computeVideoDimensions,
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
  showYearBadge?: boolean;
  showLineLegend?: boolean;
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
  showYearBadge?: boolean;
  showLineLegend?: boolean;
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

const FONT_STACK = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

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
    showYearBadge = true,
    showLineLegend = true,
    amapImages = [],
    isPreviewPlaceholderMap = false
  } = opts;

  if (!segments.length) throw new Error('请至少填写一个开通区间');
  if (!inputStations.length) throw new Error('请先创建站点后再导出视频');

  const titleText = (rawTitle || '').trim() || '城市轨道线网历程';
  const subtitleText = (rawSubtitle || '').trim();
  const titleDurationSec = Math.max(1, Math.min(8, rawTitleDurationSec || 3));
  const { width, height } = computeVideoDimensions(aspectRatio, resolution, stageWidth, stageHeight);
  const isPortrait = height > width;
  const uiScale = Math.min(width, height) / 1080;

  const titleFrames = Math.round(fps * titleDurationSec);
  const outroFrames = Math.round(fps * 2.8);

  const preset = getCityStylePreset(settings);
  const isDarkCanvas = settings.canvasTheme === 'dark';
  const isAmapVideo = settings.baseMap.mode === 'amap';

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
  const mutedLineColor = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.34)' : 'rgba(100, 116, 139, 0.22)';
  const mutedStationFill = usesDarkVideoSurface ? '#0f172a' : '#ffffff';
  const mutedStationStroke = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.55)' : '#cbd5e1';
  const primaryText = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';
  const secondaryText = usesDarkVideoSurface ? '#cbd5e1' : '#475569';
  const textHalo = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.94)' : 'rgba(255, 255, 255, 0.96)';
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
  const minX = Math.min(...allGeometryPoints.map((point) => point.x));
  const minY = Math.min(...allGeometryPoints.map((point) => point.y));
  const maxX = Math.max(...allGeometryPoints.map((point) => point.x));
  const maxY = Math.max(...allGeometryPoints.map((point) => point.y));
  const padX = Math.round((isPortrait ? 84 : 112) * uiScale);
  const padTop = Math.round(108 * uiScale);
  const padBottom = Math.round(156 * uiScale);
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
  const amapPlan = opts.amapPlan ?? (isAmapVideo && requiredGeoPoints.length > 0 ? planAmapVideoMap(requiredGeoPoints, width, height) : null);

  const stationWorld = (station: Station | Waypoint) => {
    if (isAmapVideo && amapPlan && typeof station.lng === 'number' && typeof station.lat === 'number') {
      return mercatorProject(station.lng, station.lat, amapPlan.zoom);
    }
    return { x: station.x, y: station.y };
  };

  // 将默认全图中心略微上移，避开底部信息面板视觉重心
  const verticalBiasWorld = isAmapVideo ? 0 : ((padBottom - padTop) * 0.35) / Math.max(0.05, plainMapScale);
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

  const sectionPoints = new Map(
    allSections.map((section) => [
      section.id,
      getVideoSectionPoints(section, stationById, stationWorld, settings.cornerRadius)
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

  const rectsOverlap = (a: RectBox, b: RectBox) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  // 离屏测量画布（仅构建场景时跑一次站名避让）
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
  const labelFontBase = `${settings.dotLabelStyle.fontWeight} ${labelFontSizeBase}px ${FONT_STACK}`;

  const createStationLabelPlacements = (stationIds: string[]) => {
    const uniqueStations = stationIds
      .map((id) => stationById.get(id))
      .filter(Boolean)
      .filter((station, index, list) => list.findIndex((item) => item!.id === station!.id) === index) as Station[];
    const placements = new Map<string, LabelPlacement>();
    const occupied: RectBox[] = allStations.map((station) => {
      const point = toFitAllCanvasPoint(station);
      const radius =
        ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 6;
      return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
    });

    uniqueStations.forEach((station) => {
      if (station.labelPosition === 'hidden') return;
      const point = toFitAllCanvasPoint(station);
      const textWidth = Math.max(24, measureTextWidth(station.name, labelFontBase));
      const labelWidth = textWidth + 18;
      const labelHeight = labelFontSizeBase + 12;
      const stationRadius =
        ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale;
      const distance = stationRadius + 16;
      const candidates = [
        { x: point.x - labelWidth / 2, y: point.y - distance - labelHeight },
        { x: point.x + distance, y: point.y - labelHeight / 2 },
        { x: point.x - labelWidth / 2, y: point.y + distance },
        { x: point.x - distance - labelWidth, y: point.y - labelHeight / 2 },
        { x: point.x + distance * 0.75, y: point.y - distance * 0.75 - labelHeight },
        { x: point.x + distance * 0.75, y: point.y + distance * 0.75 },
        { x: point.x - distance * 0.75 - labelWidth, y: point.y + distance * 0.75 },
        { x: point.x - distance * 0.75 - labelWidth, y: point.y - distance * 0.75 - labelHeight }
      ];
      const forcedPosition = ['top', 'right', 'bottom', 'left'].indexOf(station.labelPosition || 'auto');
      const best = candidates
        .filter((_, index) => forcedPosition < 0 || index === forcedPosition)
        .map((candidate, index) => {
          const rect = { ...candidate, width: labelWidth, height: labelHeight };
          let score = index;
          occupied.forEach((other) => {
            if (rectsOverlap(rect, other)) score += 80;
          });
          if (rect.x < 16 || rect.y < 16 || rect.x + rect.width > width - 16 || rect.y + rect.height > height - 110) {
            score += 40;
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

  let markerCursor = titleFrames;
  const segmentMarkers: VideoSegmentMarker[] = [];

  const segmentPlans = animationSegments.map((item, idx) => {
    const { points: worldPoints, stationDistances } = buildVideoRouteGeometry(
      item,
      stationById,
      stationWorld,
      settings.cornerRadius
    );
    const metrics = getPathMetrics(worldPoints);
    const canvasLength = metrics.totalLength * defaultCamera.scale;
    const rawDurationSeconds = Math.min(11, Math.max(3.6, 2.8 + canvasLength / 260)) / safeSpeed;
    const durationFrames = Math.max(Math.round(fps * 1.4), Math.round(rawDurationSeconds * fps));
    const holdFrames = Math.max(Math.round(fps * 0.35), Math.round((fps * 0.55) / Math.sqrt(safeSpeed)));
    const revealFrames = Math.max(6, Math.round(fps * 0.45));

    segmentMarkers.push({
      index: idx,
      label: item.line.name,
      color: item.line.color,
      startFrame: markerCursor,
      endFrame: markerCursor + durationFrames + holdFrames
    });
    markerCursor += durationFrames + holdFrames;

    return {
      ...item,
      stepIndex: idx,
      points: worldPoints,
      stationDistances,
      metrics,
      durationFrames,
      revealFrames,
      holdFrames,
      labelPlacements
    };
  });

  type SegmentPlan = (typeof segmentPlans)[number];

  const totalFrames =
    titleFrames + segmentPlans.reduce((sum, item) => sum + item.durationFrames + item.holdFrames, 0) + outroFrames;

  // 给定任意帧计算理想目标相机（支持随机跳转滑块预览与顺序编码 100% 一致）
  const getTargetCameraAtFrame = (f: number): { x: number; y: number; scale: number } => {
    if (cameraMode === 'overview' || f < titleFrames) {
      return { x: defaultCamera.x, y: defaultCamera.y, scale: defaultCamera.scale };
    }
    const animatedFrame = f - titleFrames;
    let cursor = 0;
    for (let i = 0; i < segmentPlans.length; i += 1) {
      const plan = segmentPlans[i];
      const span = plan.durationFrames + plan.holdFrames;
      if (animatedFrame >= cursor && animatedFrame < cursor + span) {
        const segFrame = animatedFrame - cursor;
        const progress = Math.min(1, segFrame / plan.durationFrames);
        const currentDist = plan.metrics.totalLength * easeVideoProgress(progress);
        const head = getPointAtDistance(plan.metrics, currentDist);
        if (cameraMode === 'gentle') {
          // 轻柔推镜：向动画头偏移 62%，保留周边线网空间参照感
          return {
            x: defaultCamera.x * 0.38 + head.x * 0.62,
            y: defaultCamera.y * 0.38 + head.y * 0.62,
            scale: defaultCamera.scale * 1.28
          };
        }
        return {
          x: head.x,
          y: head.y,
          scale: defaultCamera.scale * 1.55
        };
      }
      cursor += span;
    }
    return { x: defaultCamera.x, y: defaultCamera.y, scale: defaultCamera.scale };
  };

  let lastEvaluatedFrame = -999;
  const syncCameraToFrame = (frame: number) => {
    if (cameraMode === 'overview') {
      camera.x = defaultCamera.x;
      camera.y = defaultCamera.y;
      camera.scale = defaultCamera.scale;
      lastEvaluatedFrame = frame;
      return;
    }
    // 帧率无关缓动系数（等价 30fps 下 alpha = 0.12）
    const stepAlpha = 1 - Math.pow(0.88, 30 / fps);
    if (frame === 0) {
      const t0 = getTargetCameraAtFrame(0);
      camera.x = t0.x;
      camera.y = t0.y;
      camera.scale = t0.scale;
      lastEvaluatedFrame = 0;
      return;
    }
    if (frame === lastEvaluatedFrame + 1) {
      const target = getTargetCameraAtFrame(frame);
      camera.x += (target.x - camera.x) * stepAlpha;
      camera.y += (target.y - camera.y) * stepAlpha;
      camera.scale += (target.scale - camera.scale) * stepAlpha;
      lastEvaluatedFrame = frame;
      return;
    }
    // 随机拖动预览进度条：回溯最近 1.5 秒窗口平滑收敛，耗时 <0.02ms 且无跳变
    const lookback = Math.min(frame, Math.round(fps * 1.5));
    const startSim = frame - lookback;
    const initTarget = getTargetCameraAtFrame(startSim);
    camera.x = initTarget.x;
    camera.y = initTarget.y;
    camera.scale = initTarget.scale;
    for (let s = startSim + 1; s <= frame; s += 1) {
      const target = getTargetCameraAtFrame(s);
      camera.x += (target.x - camera.x) * stepAlpha;
      camera.y += (target.y - camera.y) * stepAlpha;
      camera.scale += (target.scale - camera.scale) * stepAlpha;
    }
    lastEvaluatedFrame = frame;
  };

  const drawFrame = (ctx: CanvasRenderingContext2D, rawFrame: number) => {
    const frame = Math.max(0, Math.min(totalFrames - 1, Math.floor(rawFrame)));
    syncCameraToFrame(frame);

    const camRatio = camera.scale / defaultCamera.scale;
    const darkOutlineColor = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';

    const drawBackdrop = () => {
      ctx.clearRect(0, 0, width, height);
      const isLightCityVideo = settings.baseMap.mode === 'light-city' && Boolean(settings.baseMap.lightCity);
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
          fontStack: FONT_STACK
        });
        return;
      }

      const gradient = ctx.createLinearGradient(0, 0, width, height);
      if (usesDarkVideoSurface) {
        gradient.addColorStop(0, '#07111f');
        gradient.addColorStop(1, '#0d1829');
      } else {
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(1, '#f4f7fc');
      }
      ctx.fillStyle = gradient;
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
          ctx.rect(topLeft.x, topLeft.y, patchWidth + 0.4, patchHeight + 0.4);
          ctx.clip();
          ctx.drawImage(image, origin.x, origin.y, patch.imageWidth * camera.scale, patch.imageHeight * camera.scale);
          ctx.restore();
        });
      } else {
        // 精致制图坐标点阵/网格肌理（纯画布模式或实时预览底图占位）
        const step = Math.max(24, Math.round(36 * uiScale));
        const offsetX = ((width / 2 - camera.x * camera.scale) % step + step) % step;
        const offsetY = ((height / 2 - camera.y * camera.scale) % step + step) % step;
        ctx.save();
        ctx.fillStyle = usesDarkVideoSurface ? 'rgba(148, 197, 253, 0.11)' : 'rgba(100, 116, 139, 0.15)';
        for (let gx = offsetX; gx < width; gx += step) {
          for (let gy = offsetY; gy < height; gy += step) {
            ctx.fillRect(gx - 1, gy - 1, 2, 2);
          }
        }
        ctx.restore();
      }
    };

    const drawLinePath = (
      worldPoints: VideoPoint[],
      color: string,
      progress = 1,
      alpha = 1,
      lineWidth = preset.lineWidth
    ) => {
      if (worldPoints.length < 2 || progress <= 0) return;
      const lengths = worldPoints.slice(1).map((point, index) =>
        Math.hypot(point.x - worldPoints[index].x, point.y - worldPoints[index].y)
      );
      const totalLength = lengths.reduce((sum, value) => sum + value, 0);
      let remaining = totalLength * Math.min(1, progress);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth * mapScale * camRatio;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = preset.lineShadowBlur * camRatio;
      ctx.beginPath();
      const start = worldToCanvas(worldPoints[0]);
      ctx.moveTo(start.x, start.y);
      for (let index = 1; index < worldPoints.length; index += 1) {
        const previous = worldPoints[index - 1];
        const current = worldPoints[index];
        const length = lengths[index - 1];
        if (remaining >= length) {
          const c = worldToCanvas(current);
          ctx.lineTo(c.x, c.y);
          remaining -= length;
        } else {
          const ratio = length === 0 ? 0 : remaining / length;
          const blend = worldToCanvas({
            x: previous.x + (current.x - previous.x) * ratio,
            y: previous.y + (current.y - previous.y) * ratio
          });
          ctx.lineTo(blend.x, blend.y);
          break;
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawMovingHead = (worldPoint: VideoPoint, color: string, pulse: number) => {
      const canvasPoint = worldToCanvas(worldPoint);
      const radius = (8.5 + Math.sin(pulse * Math.PI * 2) * 1.6) * mapScale * camRatio;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 20 * uiScale;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 4.5 * mapScale * camRatio;
      ctx.beginPath();
      ctx.arc(canvasPoint.x, canvasPoint.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(canvasPoint.x, canvasPoint.y, 3.4 * mapScale * camRatio, 0, Math.PI * 2);
      ctx.fill();
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

    const drawStation = (station: Station, colors: string[] = [], pulse = 0) => {
      const isActive = colors.length > 0;
      if (!isActive && unopenedStyle === 'hidden') return;

      const point = toCanvasPoint(station);
      const activeColor = colors[0];
      const isInterchange = colors.length > 1;
      const fallbackColor = activeColor || mutedStationStroke;
      const stationScale = mapScale * camRatio;

      ctx.save();
      ctx.shadowColor = activeColor || 'transparent';
      ctx.shadowBlur = activeColor ? 8 * uiScale : 0;

      if (pulse > 0 && pulse < 1) {
        ctx.save();
        ctx.globalAlpha = 0.38 * (1 - pulse);
        ctx.strokeStyle = fallbackColor;
        ctx.lineWidth = 3 * stationScale;
        ctx.beginPath();
        ctx.arc(point.x, point.y, (preset.interchangeRadius + 4 + pulse * 16) * stationScale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (isInterchange) {
        const plan = planInterchange(preset.interchangeShape, preset.interchangeOuterStroke, colors);
        const r = preset.interchangeRadius * stationScale;
        const ringW = preset.interchangeStrokeWidth * stationScale;

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
          ctx.arc(point.x, point.y, preset.interchangeInnerRadius * stationScale, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }

      const r = preset.normalStationRadius * stationScale;
      const sw = preset.normalStationStrokeWidth * stationScale;
      if (preset.stationShape === 'ring') {
        ctx.fillStyle = mutedStationFill;
        ctx.strokeStyle = fallbackColor;
        ctx.lineWidth = sw;
      } else {
        ctx.fillStyle = isActive ? fallbackColor : mutedStationFill;
        ctx.strokeStyle = isActive ? '#ffffff' : mutedStationStroke;
        ctx.lineWidth = sw;
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    // 修复镜头拉近时站名压进站点圆圈的 Bug：偏移距离与字号同步跟随 camRatio 缩放
    const drawStationLabel = (station: Station, placement: LabelPlacement, reveal: number, alpha: number) => {
      const visibleLength = Math.max(0, Math.min(station.name.length, Math.ceil(station.name.length * reveal)));
      if (visibleLength <= 0 || alpha <= 0) return;
      const text = station.name.slice(0, visibleLength);
      const stationFitAll = toFitAllCanvasPoint(station);
      const stationNow = toCanvasPoint(station);
      const deltaX = (placement.textX - stationFitAll.x) * camRatio;
      const deltaY = (placement.textY - stationFitAll.y) * camRatio;
      const textX = stationNow.x + deltaX;
      const textY = stationNow.y + deltaY;
      const scaledFontPx = Math.round(labelFontSizeBase * Math.max(0.88, Math.min(1.42, Math.pow(camRatio, 0.72))));

      ctx.save();
      ctx.globalAlpha = alpha * Math.max(0.18, reveal);
      ctx.font = `${settings.dotLabelStyle.fontWeight} ${scaledFontPx}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = (usesDarkVideoSurface ? 4 : 5) * Math.max(0.9, uiScale);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = textHalo;
      ctx.strokeText(text, textX, textY);
      ctx.fillStyle = usesDarkVideoSurface ? primaryText : settings.dotLabelStyle.color || primaryText;
      ctx.fillText(text, textX, textY);
      ctx.restore();
    };

    const drawLineLabels = (activeLines: Map<string, Set<string>>, alpha = 0.9) => {
      if (!settings.showLineNameLabels) return;
      const occupied: RectBox[] = allStations.map((station) => {
        const point = toCanvasPoint(station);
        const radius =
          ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) *
            mapScale *
            camRatio +
          8;
        return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
      });
      const pillFontPx = Math.round(preset.lineLabelFontSize * Math.max(0.88, uiScale) * Math.pow(camRatio, 0.55));

      allLines.forEach((line) => {
        const ordered = line.stationIds
          .filter((id) => activeLines.get(id)?.has(line.id))
          .map((id) => stationById.get(id))
          .filter(Boolean) as Station[];
        if (ordered.length < 2) return;
        const label = line.name;
        ctx.font = `700 ${pillFontPx}px ${FONT_STACK}`;
        const labelWidth = Math.max(54 * uiScale, ctx.measureText(label).width + 20 * uiScale);
        const labelHeight = pillFontPx + 12 * uiScale;
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
            const baseDistance = Math.max(26 * uiScale, preset.interchangeRadius * mapScale * camRatio + 18 * uiScale);
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
            if (candidate.x < 12 || candidate.y < 12 || candidate.x + candidate.width > width - 12 || candidate.y + candidate.height > height - 110) {
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
        ctx.fillStyle = usesDarkVideoSurface ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.95)';
        ctx.strokeStyle = line.color;
        ctx.lineWidth = Math.max(1.8, 2.2 * uiScale);
        ctx.fill();
        ctx.stroke();
        ctx.font = `700 ${pillFontPx}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = usesDarkVideoSurface ? '#f8fafc' : line.color;
        ctx.fillText(label, best.x + best.width / 2, best.y + best.height / 2);
        ctx.restore();
      });
    };

    const drawNetworkScene = (
      openedCount: number,
      currentPlan?: SegmentPlan,
      currentDistance = 0,
      segmentFrame = 0
    ) => {
      drawBackdrop();

      if (unopenedStyle === 'ghost') {
        allSections.forEach((section) => {
          drawLinePath(sectionPoints.get(section.id) || [], mutedLineColor, 1, 0.75, preset.lineWidth);
        });
      }

      segmentPlans.slice(0, openedCount).forEach((item) => {
        drawLinePath(item.points, item.line.color, 1, 0.88, preset.lineWidth);
      });

      if (currentPlan) {
        drawLinePath(
          currentPlan.points,
          currentPlan.line.color,
          currentDistance / currentPlan.metrics.totalLength,
          1,
          preset.lineWidth + 1
        );
      }

      const activeLines = activeVideoStationLines(segmentPlans.slice(0, openedCount), currentPlan, currentDistance);

      // 计算当前段刚刚抵达站点的涟漪脉冲
      const pulseByStation = new Map<string, number>();
      if (currentPlan) {
        const rippleSpanFrames = Math.max(8, Math.round(fps * 0.5));
        currentPlan.stationIds.forEach((id, idx) => {
          const arrivalDist = currentPlan.stationDistances[idx];
          if (currentDistance < arrivalDist) return;
          const arrivalFrame =
            videoArrivalProgress(arrivalDist / currentPlan.metrics.totalLength) * currentPlan.durationFrames;
          const elapsedFrames = segmentFrame - arrivalFrame;
          if (elapsedFrames >= 0 && elapsedFrames <= rippleSpanFrames) {
            pulseByStation.set(id, elapsedFrames / rippleSpanFrames);
          }
        });
      }

      allStations.forEach((station) => {
        const colors = allLines
          .filter((line) => activeLines.get(station.id)?.has(line.id))
          .map((line) => line.color);
        drawStation(station, colors, pulseByStation.get(station.id) || 0);
      });

      if (currentPlan) {
        const head = getPointAtDistance(currentPlan.metrics, currentDistance);
        drawMovingHead(head, currentPlan.line.color, segmentFrame / fps);
      }

      drawLineLabels(activeLines, currentPlan ? 0.72 : 0.92);

      const drawnLabels = new Set<string>();
      const canShowLabel = (id: string) =>
        settings.labelDensity !== 'key' ||
        (activeLines.get(id)?.size || 0) > 1 ||
        animationSegments.some((plan) => plan.stationIds[0] === id || plan.stationIds[plan.stationIds.length - 1] === id);

      segmentPlans.slice(0, openedCount).forEach((item) => {
        item.stationIds.forEach((id) => {
          if (drawnLabels.has(id) || !canShowLabel(id)) return;
          const station = stationById.get(id);
          const placement = item.labelPlacements.get(id);
          if (station && placement) {
            drawStationLabel(station, placement, 1, 0.78);
            drawnLabels.add(id);
          }
        });
      });

      if (currentPlan) {
        currentPlan.stationIds.forEach((id, index) => {
          const station = stationById.get(id);
          const placement = currentPlan.labelPlacements.get(id);
          if (!station || !placement || drawnLabels.has(id) || !canShowLabel(id)) return;
          const arrivalDistance = currentPlan.stationDistances[index];
          if (currentDistance < arrivalDistance) return;
          const arrivalProgressFrame =
            videoArrivalProgress(arrivalDistance / currentPlan.metrics.totalLength) * currentPlan.durationFrames;
          const reveal =
            index === 0 ? 1 : Math.max(0, Math.min(1, (segmentFrame - arrivalProgressFrame) / currentPlan.revealFrames));
          drawStationLabel(station, placement, reveal, 1);
        });
      }
    };

    const drawTopOverlays = (openedPlans: SegmentPlan[], activePlan?: SegmentPlan) => {
      const margin = Math.round(32 * uiScale);

      // 左上角：已开通线路色标胶囊条
      if (showLineLegend) {
        const seenLineIds = new Set<string>();
        const orderedOpenedLines: Line[] = [];
        openedPlans.forEach((p) => {
          if (!seenLineIds.has(p.line.id)) {
            seenLineIds.add(p.line.id);
            orderedOpenedLines.push(p.line);
          }
        });
        if (activePlan && !seenLineIds.has(activePlan.line.id)) {
          seenLineIds.add(activePlan.line.id);
          orderedOpenedLines.push(activePlan.line);
        }

        if (orderedOpenedLines.length > 0) {
          const pillH = Math.round(28 * uiScale);
          const fontPx = Math.max(11, Math.round(13 * uiScale));
          const maxRight = width - (showYearBadge ? Math.round(220 * uiScale) : margin);
          let curX = margin;
          let curY = margin;

          ctx.save();
          ctx.font = `700 ${fontPx}px ${FONT_STACK}`;
          orderedOpenedLines.slice(0, 14).forEach((line) => {
            const textW = ctx.measureText(line.name).width;
            const pillW = Math.round(textW + 22 * uiScale);
            if (curX + pillW > maxRight && curX > margin) {
              curX = margin;
              curY += pillH + Math.round(6 * uiScale);
            }
            const isCurrent = activePlan?.line.id === line.id;
            roundRect(ctx, curX, curY, pillW, pillH, pillH / 2);
            ctx.fillStyle = isCurrent
              ? line.color
              : usesDarkVideoSurface
                ? 'rgba(15, 23, 42, 0.84)'
                : 'rgba(255, 255, 255, 0.90)';
            ctx.fill();
            ctx.lineWidth = Math.max(1, 1.5 * uiScale);
            ctx.strokeStyle = isCurrent ? line.color : 'rgba(148, 163, 184, 0.30)';
            ctx.stroke();

            if (!isCurrent) {
              ctx.fillStyle = line.color;
              ctx.beginPath();
              ctx.arc(curX + Math.round(11 * uiScale), curY + pillH / 2, Math.round(4 * uiScale), 0, Math.PI * 2);
              ctx.fill();
            }

            ctx.fillStyle = isCurrent ? '#ffffff' : primaryText;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
              line.name,
              curX + (isCurrent ? pillW / 2 : pillW / 2 + Math.round(4 * uiScale)),
              curY + pillH / 2
            );
            curX += pillW + Math.round(7 * uiScale);
          });
          ctx.restore();
        }
      }

      // 右上角：大号动态年份 / 阶段角标
      const targetPlan = activePlan || openedPlans[openedPlans.length - 1];
      if (showYearBadge && targetPlan) {
        const badgeText = extractVideoEraBadge(targetPlan.segment, targetPlan.stepIndex, dateMode);
        const bigPx = Math.round((/^\d{4}$/.test(badgeText) ? 54 : 34) * uiScale);
        ctx.save();
        ctx.font = `900 ${bigPx}px ${FONT_STACK}`;
        const tw = ctx.measureText(badgeText).width;
        const boxPadX = Math.round(20 * uiScale);
        const boxW = tw + boxPadX * 2;
        const boxH = bigPx + Math.round(22 * uiScale);
        const bx = width - margin - boxW;
        const by = margin;

        roundRect(ctx, bx, by, boxW, boxH, Math.round(14 * uiScale));
        ctx.fillStyle = usesDarkVideoSurface ? 'rgba(15, 23, 42, 0.82)' : 'rgba(255, 255, 255, 0.88)';
        ctx.shadowColor = 'rgba(15, 23, 42, 0.10)';
        ctx.shadowBlur = 18 * uiScale;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.22)' : 'rgba(15, 23, 42, 0.07)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // 底部主题色强调横条
        ctx.fillStyle = targetPlan.line.color;
        roundRect(
          ctx,
          bx + boxPadX,
          by + boxH - Math.round(5 * uiScale),
          boxW - boxPadX * 2,
          Math.round(3.5 * uiScale),
          2
        );
        ctx.fill();

        ctx.fillStyle = primaryText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, bx + boxW / 2, by + boxH / 2 - Math.round(2 * uiScale));
        ctx.restore();
      }
    };

    const drawInfoPanel = (item: SegmentPlan, progress: number) => {
      const startStation = stationById.get(item.stationIds[0]);
      const endStation = stationById.get(item.stationIds[item.stationIds.length - 1]);
      const margin = Math.round((isPortrait ? 28 : 34) * uiScale);
      const panelWidth = isPortrait ? width - margin * 2 : Math.min(width - margin * 2, Math.round(540 * uiScale));
      const panelHeight = Math.round(108 * uiScale);
      const x = margin;
      const y = height - panelHeight - Math.round(28 * uiScale);

      ctx.save();
      ctx.shadowColor = usesDarkVideoSurface ? 'rgba(0, 0, 0, 0.38)' : 'rgba(15, 23, 42, 0.10)';
      ctx.shadowBlur = 24 * uiScale;
      roundRect(ctx, x, y, panelWidth, panelHeight, Math.round(16 * uiScale));
      ctx.fillStyle = usesDarkVideoSurface ? 'rgba(15, 23, 42, 0.90)' : 'rgba(255, 255, 255, 0.93)';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.22)' : 'rgba(15, 23, 42, 0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const chipFontPx = Math.max(11, Math.round(13.5 * uiScale));
      ctx.font = `700 ${chipFontPx}px ${FONT_STACK}`;
      const chipPadX = Math.round(14 * uiScale);
      const chipWidth = Math.min(Math.round(180 * uiScale), Math.max(Math.round(64 * uiScale), ctx.measureText(item.line.name).width + chipPadX * 2));
      const chipH = Math.round(28 * uiScale);
      const chipX = x + Math.round(18 * uiScale);
      const chipY = y + Math.round(18 * uiScale);

      ctx.fillStyle = item.line.color;
      roundRect(ctx, chipX, chipY, chipWidth, chipH, chipH / 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.line.name, chipX + chipWidth / 2, chipY + chipH / 2, chipWidth - 12);

      const dateLabel = formatVideoDateLabel(item.segment, item.stepIndex, dateMode);
      const datePx = Math.max(15, Math.round(20 * uiScale));
      ctx.fillStyle = primaryText;
      ctx.font = `800 ${datePx}px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.fillText(dateLabel, chipX + chipWidth + Math.round(12 * uiScale), chipY + chipH / 2, panelWidth - chipWidth - Math.round(48 * uiScale));

      const routePx = Math.max(12, Math.round(15.5 * uiScale));
      ctx.fillStyle = secondaryText;
      ctx.font = `600 ${routePx}px ${FONT_STACK}`;
      const routeSummary = `${startStation?.name || '-'}  →  ${endStation?.name || '-'}   ·   共 ${item.stationIds.length} 站`;
      ctx.fillText(routeSummary, chipX, y + Math.round(64 * uiScale), panelWidth - Math.round(36 * uiScale));

      const barX = chipX;
      const barY = y + panelHeight - Math.round(22 * uiScale);
      const barW = panelWidth - Math.round(36 * uiScale);
      const barH = Math.max(5, Math.round(6.5 * uiScale));
      ctx.fillStyle = usesDarkVideoSurface ? '#1e293b' : '#e2e8f0';
      roundRect(ctx, barX, barY, barW, barH, barH / 2);
      ctx.fill();
      if (progress > 0) {
        ctx.fillStyle = item.line.color;
        roundRect(ctx, barX, barY, Math.max(barH, barW * progress), barH, barH / 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const drawTitleOverlay = (titleFrame: number) => {
      const fadeFrames = Math.max(4, Math.round(titleFrames * 0.2));
      let alpha = 1;
      if (titleFrame < fadeFrames) {
        alpha = titleFrame / fadeFrames;
      } else if (titleFrame > titleFrames - fadeFrames) {
        alpha = Math.max(0, (titleFrames - titleFrame) / fadeFrames);
      }
      alpha = Math.max(0, Math.min(1, alpha));

      drawNetworkScene(0);
      ctx.save();
      ctx.globalAlpha = alpha * 0.78;
      ctx.fillStyle = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.86)' : 'rgba(255, 255, 255, 0.88)';
      ctx.fillRect(0, 0, width, height);

      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      let mainFontSize = Math.max(28, Math.round((isPortrait ? 60 : 72) * uiScale));
      let subFontSize = Math.max(16, Math.round((isPortrait ? 24 : 28) * uiScale));
      const gap = subtitleText ? Math.round(44 * uiScale) : 0;

      // 装饰色点条（取前 4 条线路颜色）
      const uniqueColors = Array.from(new Set(segmentPlans.map((p) => p.line.color))).slice(0, 5);
      if (uniqueColors.length > 0) {
        const dotGap = Math.round(16 * uiScale);
        const dotR = Math.round(5 * uiScale);
        const totalDotW = (uniqueColors.length - 1) * dotGap;
        uniqueColors.forEach((c, idx) => {
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(width / 2 - totalDotW / 2 + idx * dotGap, height / 2 - gap / 2 - Math.round(56 * uiScale), dotR, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      ctx.fillStyle = primaryText;
      ctx.font = `900 ${mainFontSize}px ${FONT_STACK}`;
      const maxTitleW = width - Math.round(96 * uiScale);
      const measuredMain = ctx.measureText(titleText).width;
      if (measuredMain > maxTitleW) {
        mainFontSize = Math.max(22, Math.floor((mainFontSize * maxTitleW) / measuredMain));
        ctx.font = `900 ${mainFontSize}px ${FONT_STACK}`;
      }
      ctx.fillText(titleText, width / 2, height / 2 - gap / 2);

      if (subtitleText) {
        ctx.fillStyle = secondaryText;
        ctx.font = `600 ${subFontSize}px ${FONT_STACK}`;
        const measuredSub = ctx.measureText(subtitleText).width;
        if (measuredSub > maxTitleW) {
          subFontSize = Math.max(14, Math.floor((subFontSize * maxTitleW) / measuredSub));
          ctx.font = `600 ${subFontSize}px ${FONT_STACK}`;
        }
        ctx.fillText(subtitleText, width / 2, height / 2 + gap * 0.75);
      }
      ctx.restore();
    };

    if (frame < titleFrames) {
      drawTitleOverlay(frame);
    } else {
      const animatedFrame = frame - titleFrames;
      let cursor = 0;
      const segmentIndex = segmentPlans.findIndex((item) => {
        const total = item.durationFrames + item.holdFrames;
        if (animatedFrame >= cursor && animatedFrame < cursor + total) return true;
        cursor += total;
        return false;
      });

      if (segmentIndex < 0) {
        drawNetworkScene(segmentPlans.length);
        drawTopOverlays(segmentPlans);
        const openedLines = new Set(segmentPlans.map((plan) => plan.line.id)).size;
        const openedStations = new Set(segmentPlans.flatMap((plan) => plan.stationIds)).size;
        const margin = Math.round((isPortrait ? 28 : 34) * uiScale);
        const boxW = isPortrait ? width - margin * 2 : Math.min(width - margin * 2, Math.round(480 * uiScale));
        const boxH = Math.round(62 * uiScale);
        const boxY = height - boxH - Math.round(28 * uiScale);

        ctx.save();
        ctx.shadowColor = usesDarkVideoSurface ? 'rgba(0, 0, 0, 0.35)' : 'rgba(15, 23, 42, 0.10)';
        ctx.shadowBlur = 20 * uiScale;
        ctx.fillStyle = usesDarkVideoSurface ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)';
        roundRect(ctx, margin, boxY, boxW, boxH, Math.round(14 * uiScale));
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.22)' : 'rgba(15, 23, 42, 0.08)';
        ctx.stroke();
        ctx.fillStyle = primaryText;
        ctx.font = `700 ${Math.max(14, Math.round(19 * uiScale))}px ${FONT_STACK}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`线网总览  ·  共 ${openedLines} 条线路 · ${openedStations} 座车站`, margin + Math.round(20 * uiScale), boxY + boxH / 2);
        ctx.restore();
      } else {
        const item = segmentPlans[segmentIndex];
        const segmentFrame = animatedFrame - cursor;
        const progress = Math.min(1, segmentFrame / item.durationFrames);
        const easedProgress = easeVideoProgress(progress);
        const currentDistance = item.metrics.totalLength * easedProgress;
        drawNetworkScene(segmentIndex, item, currentDistance, segmentFrame);
        drawTopOverlays(segmentPlans.slice(0, segmentIndex), item);
        drawInfoPanel(item, easedProgress);
      }
    }

    if (isAmapVideo) {
      ctx.save();
      const attrPx = Math.max(11, Math.round(13 * uiScale));
      ctx.font = `500 ${attrPx}px ${FONT_STACK}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = textHalo;
      ctx.fillStyle = secondaryText;
      const attrText = isPreviewPlaceholderMap ? '预览示意网格（导出时自动加载高德高清底图）' : '© 高德地图 · 静态底图';
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
    showYearBadge = true,
    showLineLegend = true,
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
    showYearBadge,
    showLineLegend,
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

// 视频导出模块：把"按开通时间逐段亮起线路"的动画在离屏 canvas 上渲染、
// 通过 MediaRecorder + canvas.captureStream 录成 WebM 并返回 Blob。
// 路径与时间轴由 videoModel 管理；录制、暂停与资源释放由 recordVideo 管理。

import { Line, MapSettings, Section, Station, Waypoint, DEFAULT_MAP_SETTINGS } from '../types';
import { getCityStylePreset } from '../stylePresets';
import { planInterchange, degToRad, fillCurvedArrowCanvas2d } from './interchange';
import { activeVideoStationLines, buildVideoRouteGeometry, easeVideoProgress, getVideoSectionPoints,
  mercatorProject, resolveVideoRoute, staticMapViewport, videoArrivalProgress, VideoSegmentInput } from './videoModel';
import { checkVideoRecordingSupport, recordVideoCanvas, throwIfVideoAborted, VideoExportProgress } from './recordVideo';

export interface ExportVideoOptions {
  stage: any; // Konva Stage instance (only width/height are read)
  segments: VideoSegmentInput[];
  lines: Line[];
  stations: Station[];
  sections: Section[];
  settings: MapSettings;
  // 片头（Phase 1）：用户可在 VideoExportModal 自定义。不传时退化到通用文案。
  title?: string;
  subtitle?: string;
  titleDurationSec?: number;
  signal?: AbortSignal;
  onProgress?: (progress: VideoExportProgress) => void;
  fetchAmapStaticMap: (params: {
    center: [number, number];
    zoom: number;
    width: number;
    height: number;
    style?: string;
    signal?: AbortSignal;
  }) => Promise<Blob>;
  onWarn?: (message: string) => void;
}

// 抛错代表"硬失败"（参数无效 / 浏览器不支持 / 录制为空），调用方应在 UI 上提示。
// 一些"软提示"通过 onWarn 透出去（例如部分站点缺经纬度）。
export async function exportVideoFromStage(opts: ExportVideoOptions): Promise<Blob> {
  const {
    stage,
    segments,
    lines: allLines,
    stations: allStations,
    sections: allSections,
    settings,
    title: rawTitle,
    subtitle: rawSubtitle,
    titleDurationSec: rawTitleDurationSec,
    fetchAmapStaticMap,
    onWarn, signal, onProgress
  } = opts;
  const titleText = (rawTitle || '').trim() || '城市轨道线网历程';
  const subtitleText = (rawSubtitle || '').trim();
  const titleDurationSec = Math.max(1, Math.min(8, rawTitleDurationSec || 3));

  if (!segments.length) throw new Error('请至少填写一个开通区间');
  if (!allStations.length) throw new Error('请先创建站点后再导出视频');
  checkVideoRecordingSupport();
  throwIfVideoAborted(signal);
  onProgress?.({ phase: 'preparing', percent: 0, elapsedSec: 0, totalSec: 0 });

  const fps = 30;
  const roundEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const stageWidth = Math.max(1, Number(stage?.width?.() || 1280));
  const stageHeight = Math.max(1, Number(stage?.height?.() || 720));
  const aspectRatio = Math.max(0.45, Math.min(2.4, stageWidth / stageHeight));
  // Phase 1：从 720p → 1080p。长边封顶 1920，短边 720。横屏 16:9 → 1920×1080。
  const maxVideoEdge = 1920;
  const minVideoEdge = 720;
  const width = aspectRatio >= 1
    ? roundEven(maxVideoEdge)
    : roundEven(Math.max(minVideoEdge, maxVideoEdge * aspectRatio));
  const height = aspectRatio >= 1
    ? roundEven(Math.max(minVideoEdge, maxVideoEdge / aspectRatio))
    : roundEven(maxVideoEdge);
  const titleFrames = Math.round(fps * titleDurationSec);
  const outroFrames = fps * 3;
  const sortedSegments = [...segments].sort((a, b) => a.openDate.localeCompare(b.openDate));
  const preset = getCityStylePreset(settings);
  const isDarkCanvas = settings.canvasTheme === 'dark';
  const hasGeoPoint = (point: Station | Waypoint) => Number.isFinite(point.lng) && Number.isFinite(point.lat);
  const wantsAmapVideo = settings.baseMap.mode === 'amap';
  const isAmapVideo = wantsAmapVideo && allStations.every(hasGeoPoint) &&
    allSections.every(section => (section.waypoints || []).every(hasGeoPoint));
  if (wantsAmapVideo && !isAmapVideo) onWarn?.('部分站点或折点缺少经纬度，视频将使用完整示意图，避免线路和高德底图错位');
  const amapStyle = settings.baseMap.amap?.style || 'normal';
  // 静态地图 API 使用标准样式，不能照搬 JS API 的深色样式参数。
  const usesDarkVideoSurface = !isAmapVideo && isDarkCanvas;
  const mutedLineColor = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.46)' : 'rgba(100, 116, 139, 0.28)';
  const mutedStationFill = usesDarkVideoSurface ? '#0f172a' : '#ffffff';
  const mutedStationStroke = usesDarkVideoSurface ? '#94a3b8' : '#cbd5e1';
  const primaryText = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';
  const secondaryText = usesDarkVideoSurface ? '#cbd5e1' : '#475569';
  const textHalo = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.95)' : 'rgba(255, 255, 255, 0.98)';
  const stationById = new Map(allStations.map(station => [station.id, station]));
  // 一次性建 station -> 经过它的线路颜色列表（用 allLines 数组顺序，等同 Canvas.tsx 里的 stationToLines）
  const stationLineColors = new Map<string, string[]>();
  allLines.forEach(line => {
    line.stationIds.forEach(id => {
      const arr = stationLineColors.get(id);
      if (arr) arr.push(line.color);
      else stationLineColors.set(id, [line.color]);
    });
  });
  const stationLineCounts = allStations.reduce<Record<string, number>>((result, station) => {
    result[station.id] = stationLineColors.get(station.id)?.length || 0;
    return result;
  }, {});

  const animationSegments = sortedSegments.map(segment => resolveVideoRoute(segment, allLines, allStations, allSections));
  const allGeometryPoints = [...allStations, ...allSections.flatMap(section => section.waypoints || [])];
  const minX = Math.min(...allGeometryPoints.map(point => point.x));
  const minY = Math.min(...allGeometryPoints.map(point => point.y));
  const maxX = Math.max(...allGeometryPoints.map(point => point.x));
  const maxY = Math.max(...allGeometryPoints.map(point => point.y));
  const padding = 96;
  const mapWidth = Math.max(1, maxX - minX);
  const mapHeight = Math.max(1, maxY - minY);
  const plainMapScale = Math.min((width - padding * 2) / mapWidth, (height - padding * 2) / mapHeight, 2.2);
  const mapScale = isAmapVideo ? Math.max(0.72, Math.min(1.35, Math.min(width, height) / 720)) : plainMapScale;
  const amapOptions = settings.baseMap.amap || DEFAULT_MAP_SETTINGS.baseMap.amap!;
  const amapViewport = staticMapViewport(width, height, amapOptions.zoom);
  const amapCenterPoint = mercatorProject(amapOptions.center[0], amapOptions.center[1], amapViewport.zoom);

  // ── Phase 2 相机模型 ───────────────────────────────────────────────────
  // 把"画布坐标"拆成两步：
  //   stationWorld(station)        → 世界坐标（与 camera 无关）
  //   worldToCanvas(point, camera) → 当前相机下的画布像素
  // toCanvasPoint(station) = worldToCanvas(stationWorld(station), 当前camera)
  //
  // 相机默认就是"全图居中" —— 跟 Phase 1 之前的视觉一致。
  // 单段绘制时相机会以 0.12 的系数 ease 到"当前动画头位置 + 1.6× 缩放"，
  // 完成段落跟随的平移效果。
  const stationWorld = (station: Station | Waypoint) => {
    if (isAmapVideo && typeof station.lng === 'number' && typeof station.lat === 'number') {
      const p = mercatorProject(station.lng, station.lat, amapViewport.zoom);
      return { x: p.x - amapCenterPoint.x, y: p.y - amapCenterPoint.y };
    }
    return { x: station.x, y: station.y };
  };

  const defaultCamera = isAmapVideo
    ? { x: 0, y: 0, scale: amapViewport.scale }
    : { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: plainMapScale };

  // 当前相机：可变；初始化为 default。AMap 模式下保持静态（不参与相机动画）。
  const camera = { x: defaultCamera.x, y: defaultCamera.y, scale: defaultCamera.scale };

  const worldToCanvas = (p: { x: number; y: number }) => ({
    x: (p.x - camera.x) * camera.scale + width / 2,
    y: (p.y - camera.y) * camera.scale + height / 2
  });

  // 占位 / 标签布局时需要拿"全图相机"下的位置（不受动画相机扰动），用这个版本。
  const worldToCanvasFitAll = (p: { x: number; y: number }) => ({
    x: (p.x - defaultCamera.x) * defaultCamera.scale + width / 2,
    y: (p.y - defaultCamera.y) * defaultCamera.scale + height / 2
  });

  const toCanvasPoint = (station: Station) => worldToCanvas(stationWorld(station));
  const toFitAllCanvasPoint = (station: Station) => worldToCanvasFitAll(stationWorld(station));

  // 段落路径用世界坐标存，每帧再投影 —— 这样相机平移 / 缩放都能正确反映在线条位置上
  const sectionPoints = new Map(allSections.map(section => [section.id,
    getVideoSectionPoints(section, stationById, stationWorld, settings.cornerRadius)]));

  const canvasThemeGradient = (ctx: CanvasRenderingContext2D) => {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    if (usesDarkVideoSurface) {
      gradient.addColorStop(0, '#07111f');
      gradient.addColorStop(1, '#0f172a');
    } else {
      gradient.addColorStop(0, '#fbfdff');
      gradient.addColorStop(1, '#eef6ff');
    }
    return gradient;
  };

  const roundRect = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
    radius: number
  ) => {
    const r = Math.min(radius, rectWidth / 2, rectHeight / 2);
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
  };

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('浏览器不支持导出视频');
  }

  const loadImageFromBlob = (blob: Blob) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      throwIfVideoAborted(signal);
      const url = URL.createObjectURL(blob);
      const image = new Image();
      const cleanup = () => {
        URL.revokeObjectURL(url);
        signal?.removeEventListener('abort', abort);
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
      signal?.addEventListener('abort', abort, { once: true });
      image.src = url;
    });

  // 高德静态地图：服务端要单独配 AMAP_WEB_SERVICE_KEY，不少自部署用户只配了浏览器 JS API key
  // 没配 / 配额超 / 网络不通时不再让整个视频导出失败，软退化到画布渐变背景 + 警告
  let amapBackgroundImage: HTMLImageElement | null = null;
  if (isAmapVideo) {
    try {
      const blob = await fetchAmapStaticMap({
        center: amapOptions.center,
        zoom: amapViewport.zoom,
        width: amapViewport.width,
        height: amapViewport.height,
        style: 'normal', signal
      });
      amapBackgroundImage = await loadImageFromBlob(blob);
      if (amapBackgroundImage.naturalWidth !== amapViewport.width ||
        amapBackgroundImage.naturalHeight !== amapViewport.height) {
        throw new Error('底图返回尺寸与请求不一致');
      }
      if (amapStyle !== 'normal') onWarn?.('视频中的高德静态底图使用标准样式');
    } catch (error: any) {
      throwIfVideoAborted(signal);
      onWarn?.(
        `无法加载高德静态地图作为视频底图${error?.message ? `（${error.message}）` : ''}，将使用纯色背景导出。如需带地图背景，请在服务端配置 AMAP_WEB_SERVICE_KEY。`
      );
      amapBackgroundImage = null;
    }
  }
  throwIfVideoAborted(signal);

  type VideoPoint = { x: number; y: number };
  type RectBox = { x: number; y: number; width: number; height: number };
  type LabelPlacement = RectBox & { textX: number; textY: number };

  const getPathMetrics = (points: VideoPoint[]) => {
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    const cumulative = [0];
    lengths.forEach(length => cumulative.push(cumulative[cumulative.length - 1] + length));
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

  // 入参 worldPoints 是世界坐标；内部用 worldToCanvas 投影。
  // 段长度 / progress 都基于世界距离（与相机无关，保证缓动可控）。
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
    // 相机缩放后线宽也按比例放大，保证视觉上线条厚度跟随
    ctx.lineWidth = lineWidth * (camera.scale / defaultCamera.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = preset.lineShadowBlur;
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

  // 入参 worldPoint 是世界坐标。
  const drawMovingHead = (worldPoint: VideoPoint, color: string, pulse: number) => {
    const canvasPoint = worldToCanvas(worldPoint);
    const scaleRatio = camera.scale / defaultCamera.scale;
    const radius = (8 + Math.sin(pulse * Math.PI * 2) * 1.5) * scaleRatio;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 5 * scaleRatio;
    ctx.beginPath();
    ctx.arc(canvasPoint.x, canvasPoint.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(canvasPoint.x, canvasPoint.y, 3.5 * scaleRatio, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const darkOutlineColor = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';

  // 画一段圆环上的弧带（外半径 ro 内半径 ri）。用于 lineColorArcs 形状
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
    const point = toCanvasPoint(station);
    const activeColor = colors[0];
    const isInterchange = colors.length > 1;
    const fallbackColor = activeColor || mutedStationStroke;
    const isActive = !!activeColor;
    // 站点尺寸跟随相机缩放：相机拉近时站点更大、外圈描边更显眼
    const stationScale = mapScale * (camera.scale / defaultCamera.scale);
    ctx.save();
    ctx.shadowColor = activeColor || 'transparent';
    ctx.shadowBlur = activeColor ? 8 : 0;
    if (pulse > 0) {
      ctx.globalAlpha = 0.25 * (1 - pulse);
      ctx.fillStyle = fallbackColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (preset.interchangeRadius + 10 + pulse * 12) * stationScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (isInterchange) {
      // 已激活的换乘站：按 preset.interchangeShape 走结构化画法
      // 未激活的：依然画一个 muted 圆，保留"准备亮起"的灰色提示
      if (!isActive) {
        ctx.fillStyle = mutedStationFill;
        ctx.strokeStyle = mutedStationStroke;
        ctx.lineWidth = preset.interchangeStrokeWidth * stationScale;
        ctx.beginPath();
        ctx.arc(point.x, point.y, preset.interchangeRadius * stationScale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        return;
      }

      const plan = planInterchange(preset.interchangeShape, preset.interchangeOuterStroke, colors);
      const r = preset.interchangeRadius * stationScale;
      const ringW = preset.interchangeStrokeWidth * stationScale;

      if (plan.shape === 'curvedArrows') {
        // 弧形互锁箭头（refresh icon 风）：白圆底 + 每条线一个弧形箭头 + 外圈细深环
        // 比例和 Canvas.tsx 保持一致：内 0.42 / 外 0.72（往内收，不顶外圈）
        const innerR = r * 0.42;
        const outerR = r * 0.72;
        ctx.fillStyle = mutedStationFill;
        ctx.beginPath();
        ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
        ctx.fill();
        plan.curvedArrows.forEach(arrow => {
          fillCurvedArrowCanvas2d(ctx, point.x, point.y, innerR, outerR, arrow);
        });
        const strokeColor =
          plan.outerStroke === 'lineColor' ? (colors[0] || fallbackColor) : darkOutlineColor;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = ringW;
        ctx.beginPath();
        ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (plan.shape === 'lineColorArcs') {
        // 白圆底
        ctx.fillStyle = mutedStationFill;
        ctx.beginPath();
        ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
        ctx.fill();
        // 周长上的彩色弧段
        const rInner = Math.max(0, r - ringW);
        plan.sectors.forEach(s => fillArcBand(point.x, point.y, r, rInner, s.startDeg, s.sweepDeg, s.color));
      } else {
        // concentricRing: 双圆环 + 白心
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

    // 普通单线站
    const r = preset.normalStationRadius * stationScale;
    const sw = preset.normalStationStrokeWidth * stationScale;
    if (preset.stationShape === 'ring') {
      // 白填 + 线路色描边
      ctx.fillStyle = mutedStationFill;
      ctx.strokeStyle = fallbackColor;
      ctx.lineWidth = sw;
    } else {
      // dot：实心 + 浅描边
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

  const drawLineLabels = (activeLines: Map<string, Set<string>>, alpha = 0.82) => {
    if (!settings.showLineNameLabels) return;
    const occupied: RectBox[] = allStations.map(station => {
      const point = toCanvasPoint(station);
      const radius = ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 8;
      return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
    });
    allLines.forEach(line => {
      const ordered = line.stationIds.filter(id => activeLines.get(id)?.has(line.id))
        .map(id => stationById.get(id)).filter(Boolean) as Station[];
      if (ordered.length < 2) return;
      const label = line.name;
      ctx.font = `${preset.lineLabelFontWeight} ${preset.lineLabelFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
      const labelWidth = Math.max(52, ctx.measureText(label).width + preset.lineLabelPaddingX * 2);
      const labelHeight = preset.lineLabelFontSize + preset.lineLabelPaddingY * 2 + 2;
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
          const baseDistance = Math.max(28, preset.interchangeRadius * mapScale + 18);
          return [0, labelHeight + 8, -(labelHeight + 8), labelHeight * 2 + 16, -(labelHeight * 2 + 16)].map(
            (sideOffset, index) => {
              const centerX = terminalPoint.x + outward.x * (baseDistance + labelWidth / 2) + normal.x * sideOffset;
              const centerY = terminalPoint.y + outward.y * (baseDistance + labelHeight / 2) + normal.y * sideOffset;
              return {
                x: centerX - labelWidth / 2,
                y: centerY - labelHeight / 2,
                width: labelWidth,
                height: labelHeight,
                score: preference + index * 2
              };
            }
          );
        })
        .map(candidate => {
          let score = candidate.score;
          occupied.forEach(other => {
            if (
              candidate.x < other.x + other.width &&
              candidate.x + candidate.width > other.x &&
              candidate.y < other.y + other.height &&
              candidate.y + candidate.height > other.y
            ) {
              score += 90;
            }
          });
          if (candidate.x < 0 || candidate.y < 0 || candidate.x + candidate.width > width || candidate.y + candidate.height > height) {
            score += 35;
          }
          return { ...candidate, score };
        })
        .sort((a, b) => a.score - b.score)[0];
      if (!best) return;
      occupied.push(best);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${preset.lineLabelFontWeight} ${preset.lineLabelFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = usesDarkVideoSurface ? 4 : 5;
      ctx.strokeStyle = textHalo;
      ctx.shadowColor = textHalo;
      ctx.shadowBlur = 4;
      ctx.strokeText(label, best.x + best.width / 2, best.y + best.height / 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = line.color;
      ctx.fillText(label, best.x + best.width / 2, best.y + best.height / 2);
      ctx.restore();
    });
  };

  // 标签位置在"全图相机"下计算（不受动画相机影响），
  // 返回的 placement 存的是 station→label 的"画布像素 delta"。
  // 绘制时再加上 stations 在当前相机下的位置，得到最终落点。
  // 这样镜头平移 / 缩放，标签始终以固定像素偏移跟随站点。
  const createStationLabelPlacements = (stationIds: string[]) => {
    const uniqueStations = stationIds
      .map(id => stationById.get(id))
      .filter(Boolean)
      .filter((station, index, list) => list.findIndex(item => item!.id === station!.id) === index) as Station[];
    const placements = new Map<string, LabelPlacement>();
    const occupied: RectBox[] = allStations.map(station => {
      const point = toFitAllCanvasPoint(station);
      const radius = ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 6;
      return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
    });

    ctx.font = `${settings.dotLabelStyle.fontWeight} ${settings.dotLabelStyle.fontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
    uniqueStations.forEach(station => {
      if (station.labelPosition === 'hidden') return;
      const point = toFitAllCanvasPoint(station);
      const textWidth = Math.max(24, ctx.measureText(station.name).width);
      const labelWidth = textWidth + 18;
      const labelHeight = settings.dotLabelStyle.fontSize + 12;
      const stationRadius =
        ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale;
      const distance = stationRadius + 20;
      const candidates = [
        { x: point.x - labelWidth / 2, y: point.y - distance - labelHeight },
        { x: point.x + distance, y: point.y - labelHeight / 2 },
        { x: point.x - labelWidth / 2, y: point.y + distance },
        { x: point.x - distance - labelWidth, y: point.y - labelHeight / 2 },
        { x: point.x + distance * 0.72, y: point.y - distance * 0.72 - labelHeight },
        { x: point.x + distance * 0.72, y: point.y + distance * 0.72 },
        { x: point.x - distance * 0.72 - labelWidth, y: point.y + distance * 0.72 },
        { x: point.x - distance * 0.72 - labelWidth, y: point.y - distance * 0.72 - labelHeight }
      ];
      const forcedPosition = ['top', 'right', 'bottom', 'left'].indexOf(station.labelPosition || 'auto');
      const best = candidates.filter((_, index) => forcedPosition < 0 || index === forcedPosition)
        .map((candidate, index) => {
          const rect = { ...candidate, width: labelWidth, height: labelHeight };
          let score = index;
          occupied.forEach(other => {
            if (rectsOverlap(rect, other)) score += 80;
          });
          if (rect.x < 16 || rect.y < 16 || rect.x + rect.width > width - 16 || rect.y + rect.height > height - 88) {
            score += 40;
          }
          return { ...rect, score };
        })
        .sort((a, b) => a.score - b.score)[0];
      if (!best) return;
      if (settings.labelDensity === 'adaptive' && forcedPosition < 0 && best.score >= 80 &&
        !keyStationIds.has(station.id)) return;
      // 存的 textX/Y 这里仍然是"全图相机下的绝对画布像素"。绘制时换算成 delta（见 drawStationLabel）。
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

  const keyStationIds = new Set(animationSegments.flatMap(item => [item.stationIds[0], item.stationIds[item.stationIds.length - 1]]));
  allStations.forEach(station => { if (stationLineCounts[station.id] > 1) keyStationIds.add(station.id); });
  const labelPlacements = createStationLabelPlacements(allStations.map(station => station.id));
  const segmentPlans = animationSegments.map(item => {
    // 路径用世界坐标存；metrics.totalLength 也是世界单位
    const { points: worldPoints, stationDistances } = buildVideoRouteGeometry(item, stationById, stationWorld, settings.cornerRadius);
    const metrics = getPathMetrics(worldPoints);
    // 把世界长度换算成"全图相机下的画布像素"，跟 Phase 1 之前的视觉长度对齐，
    // 这样旧的 duration 经验值依然有意义。Phase 2 把上限放宽到 12s（之前 8s）。
    const canvasLength = metrics.totalLength * defaultCamera.scale;
    const durationSeconds = Math.min(12, Math.max(4.5, 3.4 + canvasLength / 240));
    return {
      ...item,
      points: worldPoints,
      stationDistances,
      metrics,
      durationFrames: Math.round(durationSeconds * fps),
      revealFrames: Math.round(fps * 0.55),
      holdFrames: Math.round(fps * 0.55),
      labelPlacements
    };
  });

  type SegmentPlan = typeof segmentPlans[number];

  // 标签 placement 存的是"全图相机下的画布像素"。绘制时换算成 station→label 的 delta，
  // 再加上 station 在"当前相机"下的画布位置，得到正确落点 —— 相机平移 / 缩放时标签跟随站点。
  const drawStationLabel = (station: Station, placement: LabelPlacement, reveal: number, alpha: number) => {
    const visibleLength = Math.max(0, Math.min(station.name.length, Math.ceil(station.name.length * reveal)));
    if (visibleLength <= 0 || alpha <= 0) return;
    const text = station.name.slice(0, visibleLength);
    const stationFitAll = toFitAllCanvasPoint(station);
    const stationNow = toCanvasPoint(station);
    const textX = stationNow.x + (placement.textX - stationFitAll.x);
    const textY = stationNow.y + (placement.textY - stationFitAll.y);
    ctx.save();
    ctx.globalAlpha = alpha * Math.max(0.15, reveal);
    ctx.font = `${settings.dotLabelStyle.fontWeight} ${settings.dotLabelStyle.fontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = usesDarkVideoSurface ? 4 : 5;
    ctx.strokeStyle = textHalo;
    ctx.shadowColor = textHalo;
    ctx.shadowBlur = 4;
    ctx.strokeText(text, textX, textY);
    ctx.shadowBlur = 0;
    ctx.fillStyle = usesDarkVideoSurface ? primaryText : settings.dotLabelStyle.color || primaryText;
    ctx.fillText(text, textX, textY);
    ctx.restore();
  };

  // Phase 2 相机控制：每帧调用一次。
  // 没有当前段落时 → 回到全图视角；
  // 有当前段落时 → 把相机 ease 到"当前动画头位置 + 1.6× 放大"。
  // AMap 模式相机保持静态。
  let cameraInitialized = false;
  let cameraFrameDelta = 1;
  const updateCameraForFrame = (currentPlan?: SegmentPlan, currentDistance = 0) => {
    if (isAmapVideo) {
      camera.x = defaultCamera.x;
      camera.y = defaultCamera.y;
      camera.scale = defaultCamera.scale;
      cameraInitialized = true;
      return;
    }
    let targetX = defaultCamera.x;
    let targetY = defaultCamera.y;
    let targetScale = defaultCamera.scale;
    if (currentPlan) {
      const head = getPointAtDistance(currentPlan.metrics, currentDistance);
      targetX = head.x;
      targetY = head.y;
      targetScale = defaultCamera.scale * 1.6;
    }
    if (!cameraInitialized) {
      camera.x = targetX;
      camera.y = targetY;
      camera.scale = targetScale;
      cameraInitialized = true;
      return;
    }
    // ease 系数 0.12：30fps 下 half-life ≈ 5.4 帧（180ms），既跟得上动画头又不抖
    const t = 1 - Math.pow(0.88, cameraFrameDelta);
    camera.x += (targetX - camera.x) * t;
    camera.y += (targetY - camera.y) * t;
    camera.scale += (targetScale - camera.scale) * t;
  };

  const drawBaseMap = (
    openedCount: number,
    currentPlan?: SegmentPlan,
    currentDistance = 0,
    segmentFrame = 0
  ) => {
    // Phase 2：每帧先 ease 相机 → 后续所有绘制都用最新相机
    updateCameraForFrame(currentPlan, currentDistance);
    ctx.clearRect(0, 0, width, height);
    if (amapBackgroundImage) {
      ctx.drawImage(amapBackgroundImage, 0, 0, width, height);
    } else {
      ctx.fillStyle = canvasThemeGradient(ctx);
      ctx.fillRect(0, 0, width, height);
    }

    allSections.forEach(section => {
      drawLinePath(sectionPoints.get(section.id) || [], mutedLineColor, 1, 0.8, preset.lineWidth);
    });

    segmentPlans.slice(0, openedCount).forEach(item => {
      drawLinePath(item.points, item.line.color, 1, 0.78, preset.lineWidth);
    });

    if (currentPlan) {
      drawLinePath(currentPlan.points, currentPlan.line.color, currentDistance / currentPlan.metrics.totalLength, 1, preset.lineWidth + 1);
    }

    const activeLines = activeVideoStationLines(segmentPlans.slice(0, openedCount), currentPlan, currentDistance);
    allStations.forEach(station => drawStation(station,
      allLines.filter(line => activeLines.get(station.id)?.has(line.id)).map(line => line.color)));
    if (currentPlan) {
      const head = getPointAtDistance(currentPlan.metrics, currentDistance);
      drawMovingHead(head, currentPlan.line.color, segmentFrame / fps);
    }
    drawLineLabels(activeLines, currentPlan ? 0.5 : 0.82);

    const drawnLabels = new Set<string>();
    const canShowLabel = (id: string) => settings.labelDensity !== 'key' ||
      (activeLines.get(id)?.size || 0) > 1 || animationSegments.some(plan =>
        plan.stationIds[0] === id || plan.stationIds[plan.stationIds.length - 1] === id);
    segmentPlans.slice(0, openedCount).forEach(item => {
      item.stationIds.forEach(id => {
        if (drawnLabels.has(id) || !canShowLabel(id)) return;
        const station = stationById.get(id);
        const placement = item.labelPlacements.get(id);
        if (station && placement) {
          drawStationLabel(station, placement, 1, 0.7);
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
        const arrivalProgressFrame = videoArrivalProgress(arrivalDistance / currentPlan.metrics.totalLength) * currentPlan.durationFrames;
        const reveal = index === 0 ? 1 : Math.max(0, Math.min(1, (segmentFrame - arrivalProgressFrame) / currentPlan.revealFrames));
        drawStationLabel(station, placement, reveal, 1);
      });
    }
  };

  const drawInfoPanel = (item: SegmentPlan, progress: number) => {
    const startStation = stationById.get(item.stationIds[0]);
    const endStation = stationById.get(item.stationIds[item.stationIds.length - 1]);
    const panelWidth = Math.min(width - 68, 520);
    const panelHeight = 104;
    const x = 34;
    const y = height - panelHeight - 28;
    ctx.save();
    roundRect(ctx, x, y, panelWidth, panelHeight, 14);
    ctx.fillStyle = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.86)' : 'rgba(255, 255, 255, 0.9)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.34)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 13px "Microsoft YaHei", "PingFang SC", Arial';
    const chipWidth = Math.min(180, Math.max(62, ctx.measureText(item.line.name).width + 24));
    const textLeft = x + chipWidth + 32;
    ctx.fillStyle = item.line.color;
    roundRect(ctx, x + 18, y + 20, chipWidth, 28, 14);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 13px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.line.name, x + 18 + chipWidth / 2, y + 34, chipWidth - 16);
    ctx.fillStyle = primaryText;
    ctx.font = '800 22px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.textAlign = 'left';
    ctx.fillText(item.segment.openDate, textLeft, y + 32);
    ctx.fillStyle = secondaryText;
    ctx.font = '500 16px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.fillText(`${startStation?.name || '-'}  →  ${endStation?.name || '-'}`, x + 20, y + 64, panelWidth - 40);
    ctx.fillStyle = usesDarkVideoSurface ? '#1e293b' : '#e2e8f0';
    roundRect(ctx, x + 20, y + 78, panelWidth - 40, 7, 4);
    ctx.fill();
    ctx.fillStyle = item.line.color;
    roundRect(ctx, x + 20, y + 78, (panelWidth - 40) * progress, 7, 4);
    ctx.fill();
    ctx.restore();
  };

  const drawTitle = (titleFrame: number) => {
    // 淡入 / 淡出：分别取片头总时长的 20%（最少 4 帧）。中段满 alpha。
    const fadeFrames = Math.max(4, Math.round(titleFrames * 0.2));
    let alpha = 1;
    if (titleFrame < fadeFrames) {
      alpha = titleFrame / fadeFrames;
    } else if (titleFrame > titleFrames - fadeFrames) {
      alpha = Math.max(0, (titleFrames - titleFrame) / fadeFrames);
    }
    alpha = Math.max(0, Math.min(1, alpha));

    drawBaseMap(0);
    ctx.save();
    // 半透明遮罩：让底图变暗 / 变浅，突出标题
    ctx.globalAlpha = alpha * 0.72;
    ctx.fillStyle = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.85)' : 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = primaryText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 字号按视频宽度比例缩放，1920px 宽时取 76px。
    const scale = width / 1920;
    let mainFontSize = Math.max(30, Math.round(76 * scale));
    let subFontSize = Math.max(18, Math.round(30 * scale));
    const gap = subtitleText ? Math.round(46 * scale) : 0;

    ctx.font = `900 ${mainFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
    mainFontSize = Math.min(mainFontSize, mainFontSize * (width - 120) / Math.max(1, ctx.measureText(titleText).width));
    ctx.font = `900 ${mainFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
    ctx.fillText(titleText, width / 2, height / 2 - gap / 2);

    if (subtitleText) {
      ctx.fillStyle = secondaryText;
      ctx.font = `500 ${subFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
      subFontSize = Math.min(subFontSize, subFontSize * (width - 120) / Math.max(1, ctx.measureText(subtitleText).width));
      ctx.font = `500 ${subFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
      ctx.fillText(subtitleText, width / 2, height / 2 + gap);
    }
    ctx.restore();
  };

  let previousFrame = -1;
  const drawFrame = (frame: number) => {
    cameraFrameDelta = Math.max(1, frame - previousFrame);
    previousFrame = frame;
    if (frame < titleFrames) {
      drawTitle(frame);
      return;
    }
    const animatedFrame = frame - titleFrames;
    let cursor = 0;
    const segmentIndex = segmentPlans.findIndex(item => {
      const total = item.durationFrames + item.holdFrames;
      if (animatedFrame >= cursor && animatedFrame < cursor + total) return true;
      cursor += total;
      return false;
    });
    if (segmentIndex < 0) {
      // 片尾直接回到完整线网，留足三秒查看结果。
      Object.assign(camera, defaultCamera);
      drawBaseMap(segmentPlans.length);
      const openedLines = new Set(segmentPlans.map(plan => plan.line.id)).size;
      const openedStations = new Set(segmentPlans.flatMap(plan => plan.stationIds)).size;
      ctx.save();
      ctx.fillStyle = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.9)' : 'rgba(255, 255, 255, 0.94)';
      roundRect(ctx, 34, height - 84, Math.min(width - 68, 520), 56, 14);
      ctx.fill();
      ctx.fillStyle = primaryText;
      ctx.font = '600 20px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.textBaseline = 'middle';
      ctx.fillText(`已展示 ${openedLines} 条线路 · ${openedStations} 座车站`, 54, height - 56);
      ctx.restore();
      return;
    }
    const item = segmentPlans[segmentIndex];
    const segmentFrame = animatedFrame - cursor;
    const progress = Math.min(1, segmentFrame / item.durationFrames);
    const easedProgress = easeVideoProgress(progress);
    const currentDistance = item.metrics.totalLength * easedProgress;
    drawBaseMap(segmentIndex, item, currentDistance, segmentFrame);
    drawInfoPanel(item, easedProgress);
  };

  const totalFrames = titleFrames + segmentPlans.reduce((sum, item) => sum + item.durationFrames + item.holdFrames, 0) + outroFrames;
  return recordVideoCanvas({
    canvas, fps, totalFrames, drawFrame, signal, onProgress
  });
}

// 视频导出模块：把"按开通时间逐段亮起线路"的动画在离屏 canvas 上渲染、
// 通过 MediaRecorder + canvas.captureStream 录成 WebM 并返回 Blob。
//
// 设计要点：
// - 纯函数 + 注入依赖（fetchAmapStaticMap）。模块不依赖 React / AntD。
// - 帧调度从原先的 setInterval(1000/fps) 改成 rAF + performance.now() 累计帧号：
//   * 避免 setInterval 在长任务或后台标签时严重漂移；
//   * 渲染落后时按真实时间一次补多帧，保证视频总时长稳定；
//   * 至少保证每个 rAF tick 推进 1 帧，慢机器也不会卡住。

import { Line, MapSettings, Section, Station, DEFAULT_MAP_SETTINGS } from '../types';
import { getCityStylePreset } from '../stylePresets';
import type { VideoSegmentInput } from '../components/VideoExportModal';

export interface ExportVideoOptions {
  stage: any; // Konva Stage instance (only width/height are read)
  segments: VideoSegmentInput[];
  lines: Line[];
  stations: Station[];
  sections: Section[];
  settings: MapSettings;
  fetchAmapStaticMap: (params: {
    center: [number, number];
    zoom: number;
    width: number;
    height: number;
    style?: string;
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
    fetchAmapStaticMap,
    onWarn
  } = opts;

  if (!segments.length) throw new Error('请至少填写一个开通区间');
  if (!allStations.length) throw new Error('请先创建站点后再导出视频');

  const fps = 30;
  const frameDurationMs = 1000 / fps;
  const roundEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const stageWidth = Math.max(1, Number(stage?.width?.() || 1280));
  const stageHeight = Math.max(1, Number(stage?.height?.() || 720));
  const aspectRatio = Math.max(0.45, Math.min(2.4, stageWidth / stageHeight));
  const maxVideoEdge = 1280;
  const minVideoEdge = 540;
  const width = aspectRatio >= 1
    ? roundEven(maxVideoEdge)
    : roundEven(Math.max(minVideoEdge, maxVideoEdge * aspectRatio));
  const height = aspectRatio >= 1
    ? roundEven(Math.max(minVideoEdge, maxVideoEdge / aspectRatio))
    : roundEven(maxVideoEdge);
  const titleFrames = Math.round(fps * 0.8);
  const outroFrames = fps;
  const sortedSegments = [...segments].sort((a, b) => a.openDate.localeCompare(b.openDate));
  const preset = getCityStylePreset(settings);
  const isDarkCanvas = settings.canvasTheme === 'dark';
  const isAmapVideo = settings.baseMap.mode === 'amap';
  const amapStyle = settings.baseMap.amap?.style || 'normal';
  const isMutedAmapStyle = isAmapVideo && (amapStyle === 'dark' || amapStyle === 'grey');
  const usesDarkVideoSurface = isDarkCanvas || isMutedAmapStyle;
  const mutedLineColor = usesDarkVideoSurface ? 'rgba(148, 163, 184, 0.46)' : 'rgba(100, 116, 139, 0.28)';
  const mutedStationFill = usesDarkVideoSurface ? '#0f172a' : '#ffffff';
  const mutedStationStroke = usesDarkVideoSurface ? '#94a3b8' : '#cbd5e1';
  const primaryText = usesDarkVideoSurface ? '#f8fafc' : '#0f172a';
  const secondaryText = usesDarkVideoSurface ? '#cbd5e1' : '#475569';
  const textHalo = usesDarkVideoSurface ? 'rgba(2, 6, 23, 0.95)' : 'rgba(255, 255, 255, 0.98)';
  const stationById = new Map(allStations.map(station => [station.id, station]));
  const stationLineCounts = allStations.reduce<Record<string, number>>((result, station) => {
    result[station.id] = allLines.filter(line => line.stationIds.includes(station.id)).length;
    return result;
  }, {});

  const resolveSegmentPath = (segment: VideoSegmentInput) => {
    const line = allLines.find(item => item.id === segment.lineId);
    const startStation = stationById.get(segment.startStationId);
    const endStation = stationById.get(segment.endStationId);
    if (!line || !startStation || !endStation || startStation.id === endStation.id) {
      throw new Error(`视频区间配置无效：${segment.openDate || '未填写日期'}`);
    }

    const startIndex = line.stationIds.indexOf(startStation.id);
    const endIndex = line.stationIds.indexOf(endStation.id);
    if (startIndex >= 0 && endIndex >= 0 && startIndex !== endIndex) {
      const orderedIds =
        startIndex < endIndex
          ? line.stationIds.slice(startIndex, endIndex + 1)
          : line.stationIds.slice(endIndex, startIndex + 1).reverse();
      if (orderedIds.every(id => stationById.has(id))) {
        return { segment, line, stationIds: orderedIds };
      }
    }

    const adjacency = new Map<string, string[]>();
    allSections
      .filter(section => section.lineId === line.id)
      .forEach(section => {
        adjacency.set(section.startStationId, [...(adjacency.get(section.startStationId) || []), section.endStationId]);
        adjacency.set(section.endStationId, [...(adjacency.get(section.endStationId) || []), section.startStationId]);
      });

    const queue: string[][] = [[startStation.id]];
    const visited = new Set([startStation.id]);
    while (queue.length) {
      const path = queue.shift()!;
      const tail = path[path.length - 1];
      if (tail === endStation.id) return { segment, line, stationIds: path };
      (adjacency.get(tail) || []).forEach(next => {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([...path, next]);
        }
      });
    }

    throw new Error(`找不到视频路径：${line.name} ${startStation.name} - ${endStation.name}`);
  };

  const animationSegments = sortedSegments.map(resolveSegmentPath);
  const lngLatStations = allStations.filter(station => typeof station.lng === 'number' && typeof station.lat === 'number');
  if (isAmapVideo && lngLatStations.length !== allStations.length) {
    onWarn?.('部分站点缺少经纬度，视频中会使用画布坐标兜底，可能无法完全贴合高德底图');
  }
  const minX = Math.min(...allStations.map(station => station.x));
  const minY = Math.min(...allStations.map(station => station.y));
  const maxX = Math.max(...allStations.map(station => station.x));
  const maxY = Math.max(...allStations.map(station => station.y));
  const padding = 96;
  const mapWidth = Math.max(1, maxX - minX);
  const mapHeight = Math.max(1, maxY - minY);
  const plainMapScale = Math.min((width - padding * 2) / mapWidth, (height - padding * 2) / mapHeight, 2.2);
  const mapScale = isAmapVideo ? Math.max(0.72, Math.min(1.35, Math.min(width, height) / 720)) : plainMapScale;
  const mapOffset = {
    x: (width - mapWidth * plainMapScale) / 2 - minX * plainMapScale,
    y: (height - mapHeight * plainMapScale) / 2 - minY * plainMapScale - 10
  };
  const amapOptions = settings.baseMap.amap || DEFAULT_MAP_SETTINGS.baseMap.amap!;
  const mercatorProject = (lng: number, lat: number, zoom: number) => {
    const sin = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
    const worldSize = 256 * Math.pow(2, zoom);
    return {
      x: ((lng + 180) / 360) * worldSize,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize
    };
  };
  const amapCenterPoint = mercatorProject(amapOptions.center[0], amapOptions.center[1], amapOptions.zoom);
  const toCanvasPoint = (station: Station) => {
    if (isAmapVideo && typeof station.lng === 'number' && typeof station.lat === 'number') {
      const point = mercatorProject(station.lng, station.lat, amapOptions.zoom);
      return {
        x: width / 2 + point.x - amapCenterPoint.x,
        y: height / 2 + point.y - amapCenterPoint.y
      };
    }
    return {
      x: station.x * plainMapScale + mapOffset.x,
      y: station.y * plainMapScale + mapOffset.y
    };
  };
  const pathToPoints = (stationIds: string[]) =>
    stationIds.map(id => stationById.get(id)).filter(Boolean).map(station => toCanvasPoint(station!));

  const canvasThemeGradient = (ctx: CanvasRenderingContext2D) => {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    if (isDarkCanvas) {
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
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('高德静态地图图片加载失败'));
      };
      image.src = url;
    });

  // 高德静态地图：服务端要单独配 AMAP_WEB_SERVICE_KEY，不少自部署用户只配了浏览器 JS API key
  // 没配 / 配额超 / 网络不通时不再让整个视频导出失败，软退化到画布渐变背景 + 警告
  let amapBackgroundImage: HTMLImageElement | null = null;
  if (isAmapVideo) {
    try {
      const blob = await fetchAmapStaticMap({
        center: amapOptions.center,
        zoom: amapOptions.zoom,
        width,
        height,
        style: amapOptions.style
      });
      amapBackgroundImage = await loadImageFromBlob(blob);
    } catch (error: any) {
      onWarn?.(
        `无法加载高德静态地图作为视频底图${error?.message ? `（${error.message}）` : ''}，将使用纯色背景导出。如需带地图背景，请在服务端配置 AMAP_WEB_SERVICE_KEY。`
      );
      amapBackgroundImage = null;
    }
  }

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

  const easeInOut = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
  };

  const rectsOverlap = (a: RectBox, b: RectBox) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  const drawLinePath = (
    points: VideoPoint[],
    color: string,
    progress = 1,
    alpha = 1,
    lineWidth = preset.lineWidth
  ) => {
    if (points.length < 2 || progress <= 0) return;
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    const totalLength = lengths.reduce((sum, value) => sum + value, 0);
    let remaining = totalLength * Math.min(1, progress);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = preset.lineShadowBlur;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const length = lengths[index - 1];
      if (remaining >= length) {
        ctx.lineTo(current.x, current.y);
        remaining -= length;
      } else {
        const ratio = length === 0 ? 0 : remaining / length;
        ctx.lineTo(previous.x + (current.x - previous.x) * ratio, previous.y + (current.y - previous.y) * ratio);
        break;
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  const drawMovingHead = (point: VideoPoint, color: string, pulse: number) => {
    const radius = 8 + Math.sin(pulse * Math.PI * 2) * 1.5;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawStation = (station: Station, activeColor?: string, pulse = 0) => {
    const point = toCanvasPoint(station);
    const isInterchange = (stationLineCounts[station.id] || 0) > 1;
    const color = activeColor || mutedStationStroke;
    ctx.save();
    ctx.shadowColor = activeColor || 'transparent';
    ctx.shadowBlur = activeColor ? 8 : 0;
    if (pulse > 0) {
      ctx.globalAlpha = 0.25 * (1 - pulse);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (preset.interchangeRadius + 10 + pulse * 12) * mapScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = activeColor ? '#ffffff' : mutedStationFill;
    ctx.strokeStyle = color;
    ctx.lineWidth = (isInterchange ? preset.interchangeStrokeWidth : preset.normalStationStrokeWidth) * mapScale;
    ctx.beginPath();
    ctx.arc(
      point.x,
      point.y,
      (isInterchange ? preset.interchangeRadius : preset.normalStationRadius) * mapScale,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();
    if (isInterchange && activeColor) {
      ctx.fillStyle = activeColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, preset.interchangeInnerRadius * mapScale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const drawLineLabels = (alpha = 0.82) => {
    if (!settings.showLineNameLabels) return;
    const occupied: RectBox[] = allStations.map(station => {
      const point = toCanvasPoint(station);
      const radius = ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 8;
      return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
    });
    allLines.forEach(line => {
      const ordered = line.stationIds.map(id => stationById.get(id)).filter(Boolean) as Station[];
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

  const createStationLabelPlacements = (stationIds: string[]) => {
    const uniqueStations = stationIds
      .map(id => stationById.get(id))
      .filter(Boolean)
      .filter((station, index, list) => list.findIndex(item => item!.id === station!.id) === index) as Station[];
    const placements = new Map<string, LabelPlacement>();
    const occupied: RectBox[] = allStations.map(station => {
      const point = toCanvasPoint(station);
      const radius = ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 6;
      return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
    });

    ctx.font = `${settings.dotLabelStyle.fontWeight} ${settings.dotLabelStyle.fontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
    uniqueStations.forEach(station => {
      const point = toCanvasPoint(station);
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
      const best = candidates
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

  const segmentPlans = animationSegments.map(item => {
    const points = pathToPoints(item.stationIds);
    const metrics = getPathMetrics(points);
    const durationSeconds = Math.min(8, Math.max(3.8, 2.6 + metrics.totalLength / 260));
    return {
      ...item,
      points,
      metrics,
      durationFrames: Math.round(durationSeconds * fps),
      revealFrames: Math.round(fps * 0.55),
      holdFrames: Math.round(fps * 0.55),
      labelPlacements: createStationLabelPlacements(item.stationIds)
    };
  });

  type SegmentPlan = typeof segmentPlans[number];

  const drawStationLabel = (station: Station, placement: LabelPlacement, reveal: number, alpha: number) => {
    const visibleLength = Math.max(0, Math.min(station.name.length, Math.ceil(station.name.length * reveal)));
    if (visibleLength <= 0 || alpha <= 0) return;
    const text = station.name.slice(0, visibleLength);
    ctx.save();
    ctx.globalAlpha = alpha * Math.max(0.15, reveal);
    ctx.font = `${settings.dotLabelStyle.fontWeight} ${settings.dotLabelStyle.fontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = usesDarkVideoSurface ? 4 : 5;
    ctx.strokeStyle = textHalo;
    ctx.shadowColor = textHalo;
    ctx.shadowBlur = 4;
    ctx.strokeText(text, placement.textX, placement.textY);
    ctx.shadowBlur = 0;
    ctx.fillStyle = isMutedAmapStyle ? '#ffffff' : settings.dotLabelStyle.color || primaryText;
    ctx.fillText(text, placement.textX, placement.textY);
    ctx.restore();
  };

  const drawBaseMap = (
    openedCount: number,
    currentPlan?: SegmentPlan,
    currentDistance = 0,
    segmentFrame = 0
  ) => {
    ctx.clearRect(0, 0, width, height);
    if (amapBackgroundImage) {
      ctx.drawImage(amapBackgroundImage, 0, 0, width, height);
    } else {
      ctx.fillStyle = canvasThemeGradient(ctx);
      ctx.fillRect(0, 0, width, height);
    }

    allSections.forEach(section => {
      const start = stationById.get(section.startStationId);
      const end = stationById.get(section.endStationId);
      if (!start || !end) return;
      drawLinePath([toCanvasPoint(start), toCanvasPoint(end)], mutedLineColor, 1, 0.8, preset.lineWidth);
    });

    segmentPlans.slice(0, openedCount).forEach(item => {
      drawLinePath(item.points, item.line.color, 1, 0.78, preset.lineWidth);
    });

    if (currentPlan) {
      drawLinePath(currentPlan.points, currentPlan.line.color, currentDistance / currentPlan.metrics.totalLength, 1, preset.lineWidth + 1);
    }

    const activeStationColors = new Map<string, string>();
    segmentPlans.slice(0, openedCount).forEach(item => {
      item.stationIds.forEach(id => activeStationColors.set(id, item.line.color));
    });
    if (currentPlan) {
      currentPlan.stationIds.forEach((id, index) => {
        if ((currentPlan.metrics.cumulative[index] || 0) <= currentDistance + 1) {
          activeStationColors.set(id, currentPlan.line.color);
        }
      });
    }

    allStations.forEach(station => drawStation(station, activeStationColors.get(station.id)));
    if (currentPlan) {
      const head = getPointAtDistance(currentPlan.metrics, currentDistance);
      drawMovingHead(head, currentPlan.line.color, segmentFrame / fps);
    }
    drawLineLabels(currentPlan ? 0.5 : 0.82);

    segmentPlans.slice(0, openedCount).forEach(item => {
      item.stationIds.forEach(id => {
        const station = stationById.get(id);
        const placement = item.labelPlacements.get(id);
        if (station && placement) drawStationLabel(station, placement, 1, 0.52);
      });
    });

    if (currentPlan) {
      currentPlan.stationIds.forEach((id, index) => {
        const station = stationById.get(id);
        const placement = currentPlan.labelPlacements.get(id);
        if (!station || !placement) return;
        const arrivalDistance = currentPlan.metrics.cumulative[index] || 0;
        const arrivalProgressFrame = Math.round((arrivalDistance / currentPlan.metrics.totalLength) * currentPlan.durationFrames);
        const reveal = index === 0 ? 1 : Math.max(0, Math.min(1, (segmentFrame - arrivalProgressFrame) / currentPlan.revealFrames));
        drawStationLabel(station, placement, reveal, 1);
      });
    }
  };

  const drawInfoPanel = (item: SegmentPlan, progress: number) => {
    const startStation = stationById.get(item.stationIds[0]);
    const endStation = stationById.get(item.stationIds[item.stationIds.length - 1]);
    const panelWidth = 390;
    const panelHeight = 104;
    const x = 34;
    const y = height - panelHeight - 28;
    ctx.save();
    roundRect(ctx, x, y, panelWidth, panelHeight, 14);
    ctx.fillStyle = isDarkCanvas ? 'rgba(2, 6, 23, 0.86)' : 'rgba(255, 255, 255, 0.9)';
    ctx.strokeStyle = isDarkCanvas ? 'rgba(148, 163, 184, 0.32)' : 'rgba(148, 163, 184, 0.34)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = item.line.color;
    roundRect(ctx, x + 18, y + 20, 62, 28, 14);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 13px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.line.name, x + 49, y + 34);
    ctx.fillStyle = primaryText;
    ctx.font = '800 22px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.textAlign = 'left';
    ctx.fillText(item.segment.openDate, x + 96, y + 32);
    ctx.fillStyle = secondaryText;
    ctx.font = '500 16px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.fillText(`${startStation?.name || '-'}  →  ${endStation?.name || '-'}`, x + 96, y + 64);
    ctx.fillStyle = isDarkCanvas ? '#1e293b' : '#e2e8f0';
    roundRect(ctx, x + 20, y + 78, panelWidth - 40, 7, 4);
    ctx.fill();
    ctx.fillStyle = item.line.color;
    roundRect(ctx, x + 20, y + 78, (panelWidth - 40) * progress, 7, 4);
    ctx.fill();
    ctx.restore();
  };

  const drawTitle = () => {
    drawBaseMap(0);
    ctx.save();
    ctx.fillStyle = isDarkCanvas ? 'rgba(2, 6, 23, 0.54)' : 'rgba(255, 255, 255, 0.56)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = primaryText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 44px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.fillText('线路开通演示', width / 2, height / 2 - 18);
    ctx.fillStyle = secondaryText;
    ctx.font = '500 18px "Microsoft YaHei", "PingFang SC", Arial';
    ctx.fillText('按开通日期逐步点亮城市轨道网络', width / 2, height / 2 + 30);
    ctx.restore();
  };

  const drawFrame = (frame: number) => {
    if (frame < titleFrames) {
      drawTitle();
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
      drawBaseMap(segmentPlans.length);
      return;
    }
    const item = segmentPlans[segmentIndex];
    const segmentFrame = animatedFrame - cursor;
    const progress = Math.min(1, segmentFrame / item.durationFrames);
    const easedProgress = easeInOut(progress);
    const currentDistance = item.metrics.totalLength * easedProgress;
    drawBaseMap(segmentIndex, item, currentDistance, segmentFrame);
    drawInfoPanel(item, easedProgress);
  };

  const stream = canvas.captureStream(fps);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: BlobPart[] = [];
  const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack & { requestFrame?: () => void };
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const totalFrames = titleFrames + segmentPlans.reduce((sum, item) => sum + item.durationFrames + item.holdFrames, 0) + outroFrames;
  const stopPromise: Promise<Blob> = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  });

  recorder.start(100);

  // 用 rAF 驱动帧推进，按真实经过时间计算应当渲染到第几帧。
  // 优点：后台标签页/慢机器不会让总时长漂走；落后时一次补多帧赶上时间轴；
  //       哪怕浏览器没有调度 rAF（标签后台），每次 tick 也至少推进 1 帧。
  await new Promise<void>((resolve) => {
    let frameIndex = 0;
    const startTime = performance.now();
    let rafId = 0;
    const tick = () => {
      const elapsed = performance.now() - startTime;
      const targetFrame = Math.min(totalFrames - 1, Math.floor(elapsed / frameDurationMs));
      do {
        drawFrame(frameIndex);
        videoTrack?.requestFrame?.();
        frameIndex += 1;
      } while (frameIndex <= targetFrame && frameIndex < totalFrames);
      if (frameIndex >= totalFrames) {
        cancelAnimationFrame(rafId);
        recorder.stop();
        resolve();
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  });

  const blob = await stopPromise;
  if (blob.size === 0) {
    throw new Error('视频生成失败：浏览器没有录制到有效画面');
  }
  return blob;
}

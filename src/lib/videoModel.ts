import { Line, Section, Station, VideoSegmentInput, Waypoint } from '../types';
import { roundCorners } from './roundedPath';

export type { VideoSegmentInput } from '../types';

export type VideoPoint = { x: number; y: number };

export function resolveVideoRoute(segment: VideoSegmentInput, lines: Line[], stations: Station[], sections: Section[]) {
  const line = lines.find(item => item.id === segment.lineId);
  const stationById = new Map(stations.map(station => [station.id, station]));
  const start = stationById.get(segment.startStationId);
  const end = stationById.get(segment.endStationId);
  const date = new Date(`${segment.openDate}T00:00:00Z`);
  if (!line || !start || !end || start.id === end.id ||
    !line.stationIds.includes(start.id) || !line.stationIds.includes(end.id) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(segment.openDate) ||
    !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== segment.openDate) {
    throw new Error(`视频区间配置无效：${segment.openDate || '未填写日期'}`);
  }
  const edges = sections.filter(section => section.lineId === line.id &&
    stationById.has(section.startStationId) && stationById.has(section.endStationId));
  const edgeBetween = (a: string, b: string) => edges.find(edge =>
    (edge.startStationId === a && edge.endStationId === b) ||
    (edge.startStationId === b && edge.endStationId === a));
  const startIndex = line.stationIds.indexOf(start.id);
  const endIndex = line.stationIds.indexOf(end.id);
  let stationIds = startIndex < endIndex
    ? line.stationIds.slice(startIndex, endIndex + 1)
    : line.stationIds.slice(endIndex, startIndex + 1).reverse();
  // stationIds 是编辑顺序；只有相邻站确实连通时才能直接作为路径。
  if (!stationIds.every((id, index) => stationById.has(id) &&
    (index === 0 || !!edgeBetween(stationIds[index - 1], id)))) {
    const adjacency = new Map<string, string[]>();
    edges.forEach(edge => {
      adjacency.set(edge.startStationId, [...(adjacency.get(edge.startStationId) || []), edge.endStationId]);
      adjacency.set(edge.endStationId, [...(adjacency.get(edge.endStationId) || []), edge.startStationId]);
    });
    const queue = [start.id];
    const parent = new Map<string, string | null>([[start.id, null]]);
    for (let index = 0; index < queue.length && !parent.has(end.id); index += 1) {
      (adjacency.get(queue[index]) || []).forEach(next => {
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
    segment, line, stationIds,
    edges: stationIds.slice(1).map((id, index) => ({
      section: edgeBetween(stationIds[index], id)!,
      reversed: edgeBetween(stationIds[index], id)!.startStationId !== stationIds[index]
    }))
  };
}

export function getVideoSectionPoints(
  section: Section, stationById: Map<string, Station>,
  project: (point: Station | Waypoint) => VideoPoint, radius: number
) {
  const start = stationById.get(section.startStationId);
  const end = stationById.get(section.endStationId);
  if (!start || !end) return [];
  return roundCorners([project(start), ...(section.waypoints || []).map(project), project(end)], radius);
}

export function buildVideoRouteGeometry(
  route: ReturnType<typeof resolveVideoRoute>, stationById: Map<string, Station>,
  project: (point: Station | Waypoint) => VideoPoint, radius: number
) {
  const points: VideoPoint[] = [project(stationById.get(route.stationIds[0])!)];
  const stationDistances = [0];
  let distance = 0;
  route.edges.forEach(({ section, reversed }) => {
    const sectionPoints = getVideoSectionPoints(section, stationById, project, radius);
    if (reversed) sectionPoints.reverse();
    sectionPoints.slice(1).forEach(point => {
      const previous = points[points.length - 1];
      distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      points.push(point);
    });
    stationDistances.push(distance);
  });
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
    frame: Math.min(totalFrames - 1, Math.floor(Math.max(0, elapsedMs) * fps / 1000)),
    done: elapsedMs >= totalFrames * 1000 / fps
  };
}

export function mercatorProject(lng: number, lat: number, zoom: number): VideoPoint {
  const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  const worldSize = 256 * Math.pow(2, zoom);
  return { x: (lng + 180) / 360 * worldSize, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize };
}

export function staticMapViewport(width: number, height: number, zoom: number) {
  // 请求 scale=1 的半尺寸图片；底图和经纬度投影统一放大两倍。
  // 不独立夹紧宽高，避免把地图拉伸。导出尺寸均为偶数且最长边 1920。
  return { width: width / 2, height: height / 2, zoom: Math.max(1, Math.min(17, Math.round(zoom))), scale: 2 };
}

export function activeVideoStationLines(
  opened: Array<{ line: Line; stationIds: string[] }>,
  current?: { line: Line; stationIds: string[]; stationDistances: number[] }, distance = 0
) {
  const memberships = new Map<string, Set<string>>();
  const add = (id: string, lineId: string) => {
    if (!memberships.has(id)) memberships.set(id, new Set());
    memberships.get(id)!.add(lineId);
  };
  opened.forEach(plan => plan.stationIds.forEach(id => add(id, plan.line.id)));
  current?.stationIds.forEach((id, index) => {
    if (current.stationDistances[index] <= distance + 1e-6) add(id, current.line.id);
  });
  return memberships;
}

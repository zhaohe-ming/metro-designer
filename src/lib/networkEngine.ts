// 统一线网指令执行与智能几何布局底座（CLI 2.0 + AI 2.0 共用唯一事务引擎）：
// 1. 彻底收拢建线（直线/多锚点走廊/正圆环线）、首尾闭环、Y 型支线、批量命名、站点合流、途经点与轻城市配置；
// 2. 所有拓扑变更统一经过 graphOps（reconcileGraph / connectStationsOnLine / mergeStationsIntoInterchange），保证数据零撕裂；
// 3. 为 AI 生成紧凑空间感知快照（含整数坐标、默认站识别、环/支线拓扑与轻城市水系片区摘要）。

import { AIMapStatePayload, AIOperation, BranchDirection } from '../api';
import {
  LightCityArchetype,
  Line,
  MapSettings,
  Section,
  Station,
  Waypoint,
  normalizeMapSettings
} from '../types';
import {
  connectStationsOnLine,
  deleteStationFromGraph,
  deriveLineTopology,
  MapGraph,
  mergeStationsIntoInterchange,
  reconcileGraph
} from './graphOps';
import { generateLightCity, LIGHT_CITY_ARCHETYPES } from './lightCity';

const DEFAULT_STATION_NAME_RE = /^(站点|新站点|Station)\s*\d+$/i;

export function isDefaultPlaceholderStationName(name: string): boolean {
  return DEFAULT_STATION_NAME_RE.test((name || '').trim());
}

const defaultCreateId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

const DIRECTION_VECTORS: Record<BranchDirection, { ux: number; uy: number }> = {
  east_west: { ux: 1, uy: 0 },
  north_south: { ux: 0, uy: 1 },
  nw_se: { ux: Math.SQRT1_2, uy: Math.SQRT1_2 },
  sw_ne: { ux: Math.SQRT1_2, uy: -Math.SQRT1_2 },
  east: { ux: 1, uy: 0 },
  west: { ux: -1, uy: 0 },
  north: { ux: 0, uy: -1 },
  south: { ux: 0, uy: 1 }
};

export interface NetworkEngineState {
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  currentLineId: string | null;
}

export interface ApplyOperationsOptions {
  createId?: () => string;
  viewportCenter?: { x: number; y: number };
  language?: 'zh-CN' | 'en-US';
}

export interface ApplyOperationsResult extends NetworkEngineState {
  applied: number;
}

function computeNetworkCentroid(
  stations: ReadonlyArray<Station>,
  fallback: { x: number; y: number }
): { x: number; y: number; lng?: number; lat?: number } {
  if (stations.length === 0) return { x: fallback.x, y: fallback.y };
  let sx = 0;
  let sy = 0;
  let sLng = 0;
  let sLat = 0;
  let geoCount = 0;
  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    sx += st.x;
    sy += st.y;
    if (typeof st.lng === 'number' && typeof st.lat === 'number') {
      sLng += st.lng;
      sLat += st.lat;
      geoCount += 1;
    }
  }
  return {
    x: sx / stations.length,
    y: sy / stations.length,
    ...(geoCount > 0 ? { lng: sLng / geoCount, lat: sLat / geoCount } : {})
  };
}

/**
 * 推断某既有站点上已有线路的主切向；用于新线在单换乘锚点处自动取正交 90° 方向形成十字换乘。
 */
function inferOrthogonalDirectionAtStation(
  stationId: string,
  stations: ReadonlyArray<Station>,
  sections: ReadonlyArray<Section>
): { ux: number; uy: number } | null {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const center = byId.get(stationId);
  if (!center) return null;
  const incident = sections.filter(
    (sec) => sec.startStationId === stationId || sec.endStationId === stationId
  );
  if (incident.length === 0) return null;
  const sec = incident[0];
  const otherId = sec.startStationId === stationId ? sec.endStationId : sec.startStationId;
  const other = byId.get(otherId);
  if (!other) return null;
  const dx = other.x - center.x;
  const dy = other.y - center.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  // 取顺时针 90° 法向，并保证尽量朝向正东或正南易读方向
  let nx = -dy / len;
  let ny = dx / len;
  if (Math.abs(nx) >= Math.abs(ny) ? nx < 0 : ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { ux: nx, uy: ny };
}

/**
 * 执行一组结构化线网操作（AI 与 CLI 共用），返回原子更新后的完整状态。
 */
export function applyNetworkOperations(
  initial: NetworkEngineState,
  operations: ReadonlyArray<AIOperation>,
  options: ApplyOperationsOptions = {}
): ApplyOperationsResult {
  const createId = options.createId || defaultCreateId;
  const viewportCenter = options.viewportCenter || { x: 540, y: 360 };
  const language = options.language || 'zh-CN';

  let graph: MapGraph = {
    lines: initial.lines.map((l) => ({ ...l, stationIds: [...l.stationIds], sectionIds: [...l.sectionIds] })),
    stations: initial.stations.map((s) => ({ ...s })),
    sections: initial.sections.map((s) => ({
      ...s,
      ...(s.waypoints ? { waypoints: s.waypoints.map((w) => ({ ...w })) } : {}),
      ...(s.parallelOrder ? { parallelOrder: [...s.parallelOrder] } : {})
    }))
  };
  let nextSettings = initial.mapSettings;
  let nextCurrentLineId = initial.currentLineId;
  let applied = 0;

  for (const op of operations) {
    const isAmap = nextSettings.baseMap.mode === 'amap';
    const amapCenter = nextSettings.baseMap.amap?.center || [116.391276, 39.907335];
    const stepLng = 0.014;
    const stepLat = 0.0115;

    switch (op.type) {
      case 'create_new_line_with_stations': {
        const rawNames = (op.stationNames || [])
          .map((n) => (typeof n === 'string' ? n.trim() : ''))
          .filter(Boolean);
        if (rawNames.length < 2) break;

        // 若首尾站名相同且总长度 >= 4，自动识别为闭环首尾相接
        const autoCloseLoop = rawNames.length >= 4 && rawNames[0] === rawNames[rawNames.length - 1];
        const cleanNames = autoCloseLoop ? rawNames.slice(0, -1) : rawNames;
        if (cleanNames.length < 2) break;

        const existingByName = new Map<string, Station>();
        graph.stations.forEach((st) => {
          const key = st.name.trim();
          if (!existingByName.has(key)) existingByName.set(key, st);
        });

        const anchorIndices: number[] = [];
        cleanNames.forEach((name, idx) => {
          if (existingByName.has(name)) anchorIndices.push(idx);
        });

        const lineStations: Station[] = new Array(cleanNames.length);
        const createdStations: Station[] = [];

        const makeNewStation = (
          name: string,
          x: number,
          y: number,
          lng?: number,
          lat?: number
        ): Station => {
          const existing = existingByName.get(name);
          if (existing) return existing;
          const st: Station = {
            id: createId(),
            name,
            x: round1(x),
            y: round1(y),
            ...(isAmap && typeof lng === 'number' && typeof lat === 'number' ? { lng, lat } : {})
          };
          existingByName.set(name, st);
          createdStations.push(st);
          return st;
        };

        if (anchorIndices.length >= 2) {
          // ── 多锚点走廊平滑插值排布（Multi-Anchor Corridor Interpolation）──
          anchorIndices.forEach((idx) => {
            lineStations[idx] = existingByName.get(cleanNames[idx])!;
          });

          // 1) 相邻锚点之间等距线性插值
          for (let m = 0; m < anchorIndices.length - 1; m += 1) {
            const iA = anchorIndices[m];
            const iB = anchorIndices[m + 1];
            const stA = lineStations[iA];
            const stB = lineStations[iB];
            const span = iB - iA;
            for (let k = iA + 1; k < iB; k += 1) {
              const t = (k - iA) / span;
              const lng =
                typeof stA.lng === 'number' && typeof stB.lng === 'number'
                  ? stA.lng + (stB.lng - stA.lng) * t
                  : undefined;
              const lat =
                typeof stA.lat === 'number' && typeof stB.lat === 'number'
                  ? stA.lat + (stB.lat - stA.lat) * t
                  : undefined;
              lineStations[k] = makeNewStation(
                cleanNames[k],
                stA.x + (stB.x - stA.x) * t,
                stA.y + (stB.y - stA.y) * t,
                lng,
                lat
              );
            }
          }

          // 2) 首锚点之前向后切向外推
          const firstAnchorIdx = anchorIndices[0];
          if (firstAnchorIdx > 0) {
            const st0 = lineStations[firstAnchorIdx];
            const st1 = lineStations[anchorIndices[1]];
            const span = Math.max(1, anchorIndices[1] - firstAnchorIdx);
            const rawDx = (st1.x - st0.x) / span;
            const rawDy = (st1.y - st0.y) / span;
            const rawStep = Math.hypot(rawDx, rawDy);
            const stepLen = Math.max(72, Math.min(115, rawStep || 92));
            const ux = rawStep > 1 ? rawDx / rawStep : 1;
            const uy = rawStep > 1 ? rawDy / rawStep : 0;
            for (let k = firstAnchorIdx - 1; k >= 0; k -= 1) {
              const d = firstAnchorIdx - k;
              lineStations[k] = makeNewStation(
                cleanNames[k],
                st0.x - ux * stepLen * d,
                st0.y - uy * stepLen * d,
                typeof st0.lng === 'number' ? st0.lng - ux * stepLng * d : undefined,
                typeof st0.lat === 'number' ? st0.lat + uy * stepLat * d : undefined
              );
            }
          }

          // 3) 末锚点之后向前切向外推
          const lastAnchorIdx = anchorIndices[anchorIndices.length - 1];
          if (lastAnchorIdx < cleanNames.length - 1) {
            const prevAnchorIdx = anchorIndices[anchorIndices.length - 2];
            const stPrev = lineStations[prevAnchorIdx];
            const stLast = lineStations[lastAnchorIdx];
            const span = Math.max(1, lastAnchorIdx - prevAnchorIdx);
            const rawDx = (stLast.x - stPrev.x) / span;
            const rawDy = (stLast.y - stPrev.y) / span;
            const rawStep = Math.hypot(rawDx, rawDy);
            const stepLen = Math.max(72, Math.min(115, rawStep || 92));
            const ux = rawStep > 1 ? rawDx / rawStep : 1;
            const uy = rawStep > 1 ? rawDy / rawStep : 0;
            for (let k = lastAnchorIdx + 1; k < cleanNames.length; k += 1) {
              const d = k - lastAnchorIdx;
              lineStations[k] = makeNewStation(
                cleanNames[k],
                stLast.x + ux * stepLen * d,
                stLast.y + uy * stepLen * d,
                typeof stLast.lng === 'number' ? stLast.lng + ux * stepLng * d : undefined,
                typeof stLast.lat === 'number' ? stLast.lat - uy * stepLat * d : undefined
              );
            }
          }
        } else {
          // ── 0 或 1 个换乘锚点：自动正交选向 / 目标片区中心排布 ──
          const dirOrder = ['east_west', 'north_south', 'nw_se', 'sw_ne'] as const;
          let vec = op.direction ? DIRECTION_VECTORS[op.direction] : null;
          const stepPx = 92;

          let pivotIdx = anchorIndices.length === 1 ? anchorIndices[0] : (cleanNames.length - 1) / 2;
          const centroid = computeNetworkCentroid(graph.stations, viewportCenter);
          let originX = op.targetCenter?.x ?? centroid.x;
          let originY = op.targetCenter?.y ?? centroid.y;
          let originLng = centroid.lng ?? amapCenter[0];
          let originLat = centroid.lat ?? amapCenter[1];

          if (anchorIndices.length === 1) {
            const pivotStation = existingByName.get(cleanNames[pivotIdx])!;
            originX = pivotStation.x;
            originY = pivotStation.y;
            if (typeof pivotStation.lng === 'number' && typeof pivotStation.lat === 'number') {
              originLng = pivotStation.lng;
              originLat = pivotStation.lat;
            }
            if (!vec) {
              vec =
                inferOrthogonalDirectionAtStation(pivotStation.id, graph.stations, graph.sections) ||
                DIRECTION_VECTORS[dirOrder[graph.lines.length % dirOrder.length]];
            }
          } else {
            if (!vec) {
              vec = DIRECTION_VECTORS[dirOrder[graph.lines.length % dirOrder.length]];
            }
            if (!op.targetCenter && graph.stations.length > 0) {
              const perpShift = ((graph.lines.length % 3) - 1) * 58;
              originX += -vec.uy * perpShift;
              originY += vec.ux * perpShift;
              originLng += -vec.uy * 0.008;
              originLat += -vec.ux * 0.0065;
            }
          }

          cleanNames.forEach((stName, idx) => {
            const existing = existingByName.get(stName);
            if (existing) {
              lineStations[idx] = existing;
              return;
            }
            const delta = idx - pivotIdx;
            lineStations[idx] = makeNewStation(
              stName,
              originX + vec!.ux * stepPx * delta,
              originY + vec!.uy * stepPx * delta,
              originLng + vec!.ux * stepLng * delta,
              originLat - vec!.uy * stepLat * delta
            );
          });
        }

        const lineId = createId();
        const newSectionList: Section[] = [];
        for (let i = 0; i < lineStations.length - 1; i += 1) {
          if (lineStations[i].id === lineStations[i + 1].id) continue;
          newSectionList.push({
            id: createId(),
            lineId,
            startStationId: lineStations[i].id,
            endStationId: lineStations[i + 1].id
          });
        }
        if (autoCloseLoop && lineStations.length >= 3) {
          const first = lineStations[0];
          const last = lineStations[lineStations.length - 1];
          if (first.id !== last.id) {
            newSectionList.push({
              id: createId(),
              lineId,
              startStationId: last.id,
              endStationId: first.id
            });
          }
        }

        graph = reconcileGraph({
          lines: [
            ...graph.lines,
            {
              id: lineId,
              name: op.name.trim(),
              color: op.color,
              stationIds: lineStations.map((s) => s.id),
              sectionIds: newSectionList.map((s) => s.id)
            }
          ],
          stations: [...graph.stations, ...createdStations],
          sections: [...graph.sections, ...newSectionList]
        });
        if (!nextCurrentLineId) nextCurrentLineId = lineId;
        applied += 1;
        break;
      }

      case 'create_loop_line': {
        const rawNames = (op.stationNames || [])
          .map((n) => (typeof n === 'string' ? n.trim() : ''))
          .filter(Boolean);
        const cleanNames =
          rawNames.length >= 4 && rawNames[0] === rawNames[rawNames.length - 1]
            ? rawNames.slice(0, -1)
            : rawNames;
        if (cleanNames.length < 3) break;

        const centroid = computeNetworkCentroid(graph.stations, viewportCenter);
        const cx = typeof op.centerX === 'number' && Number.isFinite(op.centerX) ? op.centerX : centroid.x;
        const cy = typeof op.centerY === 'number' && Number.isFinite(op.centerY) ? op.centerY : centroid.y;
        const amapLng = centroid.lng ?? amapCenter[0];
        const amapLat = centroid.lat ?? amapCenter[1];

        let defaultR = Math.max(155, Math.min(310, cleanNames.length * 28));
        if (graph.stations.length >= 4 && typeof op.radius !== 'number') {
          let maxDist = 0;
          graph.stations.forEach((s) => {
            maxDist = Math.max(maxDist, Math.hypot(s.x - cx, s.y - cy));
          });
          if (maxDist > 120) {
            defaultR = Math.max(150, Math.min(340, maxDist * 0.64));
          }
        }
        const radius =
          typeof op.radius === 'number' && Number.isFinite(op.radius)
            ? Math.max(80, Math.min(600, op.radius))
            : defaultR;

        const existingByName = new Map<string, Station>();
        graph.stations.forEach((st) => {
          const k = st.name.trim();
          if (!existingByName.has(k)) existingByName.set(k, st);
        });

        // 若首个匹配的既有换乘站存在，将环线起始角对齐到该站方位角，使环线顺滑串联既有放射线
        let baseAngle = -Math.PI / 2;
        const firstExistingIdx = cleanNames.findIndex((n) => existingByName.has(n));
        if (firstExistingIdx >= 0) {
          const anchor = existingByName.get(cleanNames[firstExistingIdx])!;
          const ang = Math.atan2(anchor.y - cy, anchor.x - cx);
          baseAngle = ang - (2 * Math.PI * firstExistingIdx) / cleanNames.length;
        }

        const N = cleanNames.length;
        const ringStations: Station[] = [];
        const createdStations: Station[] = [];
        const usedExistingFlags: boolean[] = [];

        for (let i = 0; i < N; i += 1) {
          const name = cleanNames[i];
          const existing = existingByName.get(name);
          if (existing) {
            ringStations.push(existing);
            usedExistingFlags.push(true);
            continue;
          }
          const theta = baseAngle + (2 * Math.PI * i) / N;
          const sx = round1(cx + radius * Math.cos(theta));
          const sy = round1(cy + radius * Math.sin(theta));
          const st: Station = {
            id: createId(),
            name,
            x: sx,
            y: sy,
            ...(isAmap
              ? {
                  lng: amapLng + (radius / 92) * stepLng * Math.cos(theta),
                  lat: amapLat - (radius / 92) * stepLat * Math.sin(theta)
                }
              : {})
          };
          existingByName.set(name, st);
          createdStations.push(st);
          ringStations.push(st);
          usedExistingFlags.push(false);
        }

        const lineId = createId();
        const ringSections: Section[] = [];
        const useSmoothArc = !isAmap && N <= 10 && usedExistingFlags.every((u) => !u);

        for (let i = 0; i < N; i += 1) {
          const nextIdx = (i + 1) % N;
          const a = ringStations[i];
          const b = ringStations[nextIdx];
          if (a.id === b.id) continue;

          let waypoints: Waypoint[] | undefined;
          if (useSmoothArc) {
            const midTheta = baseAngle + (2 * Math.PI * (i + 0.5)) / N;
            waypoints = [
              {
                x: round1(cx + radius * Math.cos(midTheta)),
                y: round1(cy + radius * Math.sin(midTheta)),
                mode: 'arc',
                hidden: true
              }
            ];
          }
          ringSections.push({
            id: createId(),
            lineId,
            startStationId: a.id,
            endStationId: b.id,
            ...(waypoints ? { waypoints } : {})
          });
        }

        graph = reconcileGraph({
          lines: [
            ...graph.lines,
            {
              id: lineId,
              name: op.name.trim(),
              color: op.color,
              stationIds: ringStations.map((s) => s.id),
              sectionIds: ringSections.map((s) => s.id)
            }
          ],
          stations: [...graph.stations, ...createdStations],
          sections: [...graph.sections, ...ringSections]
        });
        if (!nextCurrentLineId) nextCurrentLineId = lineId;
        applied += 1;
        break;
      }

      case 'close_line_loop': {
        const line = graph.lines.find((l) => l.id === op.lineId);
        if (!line) break;
        const lineSecs = graph.sections.filter((s) => s.lineId === line.id);
        const topo = deriveLineTopology(line, lineSecs);
        if (topo.isLoop || topo.terminalStationIds.length < 2) break;
        const startTerminal = topo.terminalStationIds[0];
        const endTerminal = topo.terminalStationIds[topo.terminalStationIds.length - 1];
        const res = connectStationsOnLine(graph, {
          lineId: line.id,
          fromStationId: endTerminal,
          toStationId: startTerminal,
          makeId: createId
        });
        if (res.sectionId) {
          graph = res.graph;
          applied += 1;
        }
        break;
      }

      case 'create_branch_line': {
        const line = graph.lines.find((l) => l.id === op.lineId);
        const anchor = graph.stations.find((s) => s.id === op.branchFromStationId);
        const rawNames = (op.newStationNames || [])
          .map((n) => (typeof n === 'string' ? n.trim() : ''))
          .filter(Boolean);
        if (!line || !anchor || rawNames.length === 0) break;

        let vec = op.direction ? DIRECTION_VECTORS[op.direction] : null;
        if (!vec) {
          // 自动沿主线切向偏转 ±45° 分叉（优先朝远离全网重心一侧展开，避免扎回密集核心区）
          const byId = new Map(graph.stations.map((s) => [s.id, s]));
          const lineSecs = graph.sections.filter(
            (s) => s.lineId === line.id && (s.startStationId === anchor.id || s.endStationId === anchor.id)
          );
          let tx = 1;
          let ty = 0;
          if (lineSecs.length > 0) {
            const neighborId =
              lineSecs[0].startStationId === anchor.id ? lineSecs[0].endStationId : lineSecs[0].startStationId;
            const neighbor = byId.get(neighborId);
            if (neighbor) {
              const dx = anchor.x - neighbor.x;
              const dy = anchor.y - neighbor.y;
              const len = Math.hypot(dx, dy) || 1;
              tx = dx / len;
              ty = dy / len;
            }
          }
          const c45 = Math.SQRT1_2;
          const candA = { ux: tx * c45 - ty * c45, uy: tx * c45 + ty * c45 };
          const candB = { ux: tx * c45 + ty * c45, uy: -tx * c45 + ty * c45 };
          const centroid = computeNetworkCentroid(graph.stations, viewportCenter);
          const distA = Math.hypot(anchor.x + candA.ux * 90 - centroid.x, anchor.y + candA.uy * 90 - centroid.y);
          const distB = Math.hypot(anchor.x + candB.ux * 90 - centroid.x, anchor.y + candB.uy * 90 - centroid.y);
          vec = distA >= distB ? candA : candB;
        }

        const stepPx = 88;
        const existingByName = new Map<string, Station>();
        graph.stations.forEach((st) => existingByName.set(st.name.trim(), st));

        let prevId = anchor.id;
        const addedStations: Station[] = [];
        rawNames.forEach((name, idx) => {
          let target = existingByName.get(name);
          if (!target) {
            const step = idx + 1;
            target = {
              id: createId(),
              name,
              x: round1(anchor.x + vec!.ux * stepPx * step),
              y: round1(anchor.y + vec!.uy * stepPx * step),
              ...(isAmap && typeof anchor.lng === 'number' && typeof anchor.lat === 'number'
                ? {
                    lng: anchor.lng + vec!.ux * stepLng * step,
                    lat: anchor.lat - vec!.uy * stepLat * step
                  }
                : {})
            };
            existingByName.set(name, target);
            addedStations.push(target);
          }
          prevId = target.id;
        });

        graph = { ...graph, stations: [...graph.stations, ...addedStations] };
        let currFromId = anchor.id;
        for (let i = 0; i < rawNames.length; i += 1) {
          const st = existingByName.get(rawNames[i])!;
          if (st.id !== currFromId) {
            graph = connectStationsOnLine(graph, {
              lineId: line.id,
              fromStationId: currFromId,
              toStationId: st.id,
              makeId: createId
            }).graph;
            currFromId = st.id;
          }
        }
        void prevId;
        applied += 1;
        break;
      }

      case 'batch_rename_stations': {
        if (!Array.isArray(op.renames) || op.renames.length === 0) break;
        const renameMap = new Map<string, string>();
        op.renames.forEach((item) => {
          if (!item || typeof item.stationId !== 'string' || typeof item.name !== 'string') return;
          const trimmed = item.name.trim();
          if (trimmed && Array.from(trimmed).length <= 32) {
            renameMap.set(item.stationId, trimmed);
          }
        });
        if (renameMap.size === 0) break;
        let changed = 0;
        graph = {
          ...graph,
          stations: graph.stations.map((st) => {
            const nextName = renameMap.get(st.id);
            if (nextName && nextName !== st.name) {
              changed += 1;
              return { ...st, name: nextName };
            }
            return st;
          })
        };
        if (changed > 0) applied += 1;
        break;
      }

      case 'merge_stations': {
        if (!op.sourceStationId || !op.targetStationId || op.sourceStationId === op.targetStationId) break;
        const beforeCount = graph.stations.length;
        graph = mergeStationsIntoInterchange(graph, op.sourceStationId, op.targetStationId);
        if (graph.stations.length < beforeCount) applied += 1;
        break;
      }

      case 'configure_map': {
        let updated = { ...nextSettings };
        if (op.canvasTheme === 'light' || op.canvasTheme === 'dark') {
          updated.canvasTheme = op.canvasTheme;
        }
        if (
          op.cityStyle === 'standard' ||
          op.cityStyle === 'beijing' ||
          op.cityStyle === 'shanghai' ||
          op.cityStyle === 'mtr'
        ) {
          updated.cityStyle = op.cityStyle;
        }
        if (typeof op.cornerRadius === 'number' && Number.isFinite(op.cornerRadius)) {
          updated.cornerRadius = Math.max(0, Math.min(40, Math.round(op.cornerRadius)));
        }
        if (typeof op.hideWaypoints === 'boolean') {
          updated.hideWaypoints = op.hideWaypoints;
        }
        if (op.lightCityArchetype) {
          const curArch = updated.baseMap.lightCity?.archetype;
          const arch: LightCityArchetype =
            op.lightCityArchetype === 'shuffle'
              ? curArch && curArch !== 'custom'
                ? curArch
                : 'river'
              : op.lightCityArchetype;
          const seed = Math.floor(100000 + Math.random() * 899999);
          const generated = generateLightCity({
            archetype: arch,
            seed,
            stations: graph.stations,
            language
          });
          updated = {
            ...updated,
            baseMap: {
              ...updated.baseMap,
              mode: 'light-city',
              lightCity: {
                ...generated,
                opacity: updated.baseMap.lightCity?.opacity ?? 1,
                layerVisibility: updated.baseMap.lightCity?.layerVisibility || generated.layerVisibility
              }
            }
          };
        }
        nextSettings = normalizeMapSettings(updated);
        applied += 1;
        break;
      }

      case 'create_line': {
        if (!Array.isArray(op.stationIds) || op.stationIds.length < 2) break;
        const lineId = createId();
        const newSections: Section[] = [];
        for (let i = 0; i < op.stationIds.length - 1; i += 1) {
          if (op.stationIds[i] === op.stationIds[i + 1]) continue;
          newSections.push({
            id: createId(),
            lineId,
            startStationId: op.stationIds[i],
            endStationId: op.stationIds[i + 1]
          });
        }
        graph = reconcileGraph({
          lines: [
            ...graph.lines,
            {
              id: lineId,
              name: op.name.trim(),
              color: op.color,
              stationIds: [...op.stationIds],
              sectionIds: newSections.map((s) => s.id)
            }
          ],
          stations: graph.stations,
          sections: [...graph.sections, ...newSections]
        });
        if (!nextCurrentLineId) nextCurrentLineId = lineId;
        applied += 1;
        break;
      }

      case 'create_line_via_extension': {
        const anchor = graph.stations.find((s) => s.id === op.anchorStationId);
        if (!anchor) break;
        const newNames = (op.newStationNames || [])
          .map((n) => (typeof n === 'string' ? n.trim() : ''))
          .filter(Boolean);
        if (newNames.length === 0) break;

        let reference: Station | null = null;
        if (op.directionAwayFromStationId) {
          reference = graph.stations.find((s) => s.id === op.directionAwayFromStationId) || null;
        }
        if (!reference) {
          for (const candidateLine of graph.lines) {
            const idx = candidateLine.stationIds.indexOf(anchor.id);
            if (idx < 0) continue;
            const neighborId = candidateLine.stationIds[idx - 1] || candidateLine.stationIds[idx + 1];
            if (neighborId) {
              reference = graph.stations.find((s) => s.id === neighborId) || null;
              if (reference) break;
            }
          }
        }

        let dx = 88;
        let dy = 0;
        let dLng: number | null = null;
        let dLat: number | null = null;
        if (reference) {
          dx = anchor.x - reference.x;
          dy = anchor.y - reference.y;
          if (typeof anchor.lng === 'number' && typeof reference.lng === 'number') {
            dLng = anchor.lng - reference.lng;
          }
          if (typeof anchor.lat === 'number' && typeof reference.lat === 'number') {
            dLat = anchor.lat - reference.lat;
          }
          const mag = Math.hypot(dx, dy);
          if (mag < 40 || mag > 150) {
            const targetStep = 88;
            dx = mag === 0 ? targetStep : (dx / mag) * targetStep;
            dy = mag === 0 ? 0 : (dy / mag) * targetStep;
          }
        }

        const newStationsList: Station[] = newNames.map((name, i) => {
          const step = i + 1;
          return {
            id: createId(),
            name,
            x: round1(anchor.x + dx * step),
            y: round1(anchor.y + dy * step),
            ...(dLng !== null ? { lng: anchor.lng! + dLng * step } : {}),
            ...(dLat !== null ? { lat: anchor.lat! + dLat * step } : {})
          };
        });
        const chain = [anchor, ...newStationsList];
        const lineId = createId();
        const newSectionList: Section[] = [];
        for (let i = 0; i < chain.length - 1; i += 1) {
          newSectionList.push({
            id: createId(),
            lineId,
            startStationId: chain[i].id,
            endStationId: chain[i + 1].id
          });
        }
        graph = reconcileGraph({
          lines: [
            ...graph.lines,
            {
              id: lineId,
              name: op.name.trim(),
              color: op.color,
              stationIds: chain.map((s) => s.id),
              sectionIds: newSectionList.map((s) => s.id)
            }
          ],
          stations: [...graph.stations, ...newStationsList],
          sections: [...graph.sections, ...newSectionList]
        });
        if (!nextCurrentLineId) nextCurrentLineId = lineId;
        applied += 1;
        break;
      }

      case 'recolor_line': {
        if (!graph.lines.some((l) => l.id === op.lineId)) break;
        graph = {
          ...graph,
          lines: graph.lines.map((l) => (l.id === op.lineId ? { ...l, color: op.color } : l))
        };
        applied += 1;
        break;
      }

      case 'rename_line': {
        if (!graph.lines.some((l) => l.id === op.lineId)) break;
        graph = {
          ...graph,
          lines: graph.lines.map((l) => (l.id === op.lineId ? { ...l, name: op.name.trim() } : l))
        };
        applied += 1;
        break;
      }

      case 'delete_line': {
        if (!graph.lines.some((l) => l.id === op.lineId)) break;
        graph = reconcileGraph({
          lines: graph.lines.filter((l) => l.id !== op.lineId),
          stations: graph.stations,
          sections: graph.sections.filter((s) => s.lineId !== op.lineId)
        });
        if (nextCurrentLineId === op.lineId) {
          nextCurrentLineId = graph.lines[0]?.id || null;
        }
        applied += 1;
        break;
      }

      case 'attach_station_to_line': {
        const line = graph.lines.find((l) => l.id === op.lineId);
        if (!line || line.stationIds.length === 0) break;
        const isStart = op.position === 'start';
        const endpointId = isStart ? line.stationIds[0] : line.stationIds[line.stationIds.length - 1];
        if (!endpointId || endpointId === op.stationId) break;
        const res = connectStationsOnLine(graph, {
          lineId: line.id,
          fromStationId: endpointId,
          toStationId: op.stationId,
          makeId: createId
        });
        if (res.sectionId) {
          graph = res.graph;
          applied += 1;
        }
        break;
      }

      case 'create_station_between': {
        const line = graph.lines.find((l) => l.id === op.lineId);
        if (!line) break;
        const targetSec = graph.sections.find(
          (s) =>
            s.lineId === op.lineId &&
            ((s.startStationId === op.afterStationId && s.endStationId === op.beforeStationId) ||
              (s.startStationId === op.beforeStationId && s.endStationId === op.afterStationId))
        );
        const stationA = graph.stations.find((s) => s.id === op.afterStationId);
        const stationB = graph.stations.find((s) => s.id === op.beforeStationId);
        const names = (op.names || []).map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
        if (!targetSec || !stationA || !stationB || names.length === 0) break;

        const aIdx = line.stationIds.indexOf(op.afterStationId);
        const bIdx = line.stationIds.indexOf(op.beforeStationId);
        const aIsFirst = aIdx >= 0 && bIdx >= 0 ? aIdx <= bIdx : targetSec.startStationId === op.afterStationId;
        const fromStation = aIsFirst ? stationA : stationB;
        const toStation = aIsFirst ? stationB : stationA;
        const orderedNames = aIsFirst ? names : [...names].reverse();

        const newStations: Station[] = orderedNames.map((name, i) => {
          const t = (i + 1) / (orderedNames.length + 1);
          return {
            id: createId(),
            name,
            x: round1(fromStation.x + (toStation.x - fromStation.x) * t),
            y: round1(fromStation.y + (toStation.y - fromStation.y) * t),
            ...(typeof fromStation.lng === 'number' && typeof toStation.lng === 'number'
              ? { lng: fromStation.lng + (toStation.lng - fromStation.lng) * t }
              : {}),
            ...(typeof fromStation.lat === 'number' && typeof toStation.lat === 'number'
              ? { lat: fromStation.lat + (toStation.lat - fromStation.lat) * t }
              : {})
          };
        });

        const chainIds = [fromStation.id, ...newStations.map((s) => s.id), toStation.id];
        const splitSections: Section[] = [];
        for (let i = 0; i < chainIds.length - 1; i += 1) {
          splitSections.push({
            id: createId(),
            lineId: op.lineId,
            startStationId: chainIds[i],
            endStationId: chainIds[i + 1]
          });
        }

        const insertPos = aIdx >= 0 && bIdx >= 0 ? Math.min(aIdx, bIdx) : -1;
        const hintedLines = graph.lines.map((l) => {
          if (l.id !== op.lineId || insertPos < 0) return l;
          return {
            ...l,
            stationIds: [
              ...l.stationIds.slice(0, insertPos + 1),
              ...newStations.map((s) => s.id),
              ...l.stationIds.slice(insertPos + 1)
            ]
          };
        });

        graph = reconcileGraph({
          lines: hintedLines,
          stations: [...graph.stations, ...newStations],
          sections: graph.sections.filter((s) => s.id !== targetSec.id).concat(splitSections)
        });
        applied += 1;
        break;
      }

      case 'create_station_at_line_end': {
        const line = graph.lines.find((l) => l.id === op.lineId);
        if (!line || line.stationIds.length < 2) break;
        const names = (op.names || []).map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
        if (names.length === 0) break;
        const isStart = op.position === 'start';
        const endStationId = isStart ? line.stationIds[0] : line.stationIds[line.stationIds.length - 1];
        const beforeEndId = isStart ? line.stationIds[1] : line.stationIds[line.stationIds.length - 2];
        const endStation = graph.stations.find((s) => s.id === endStationId);
        const beforeEnd = graph.stations.find((s) => s.id === beforeEndId);
        if (!endStation || !beforeEnd) break;

        let dx = endStation.x - beforeEnd.x;
        let dy = endStation.y - beforeEnd.y;
        const mag = Math.hypot(dx, dy);
        if (mag < 40 || mag > 160) {
          const targetStep = 88;
          dx = mag === 0 ? targetStep : (dx / mag) * targetStep;
          dy = mag === 0 ? 0 : (dy / mag) * targetStep;
        }
        const dLng =
          typeof endStation.lng === 'number' && typeof beforeEnd.lng === 'number'
            ? endStation.lng - beforeEnd.lng
            : null;
        const dLat =
          typeof endStation.lat === 'number' && typeof beforeEnd.lat === 'number'
            ? endStation.lat - beforeEnd.lat
            : null;

        const newStations: Station[] = names.map((name, i) => {
          const step = i + 1;
          return {
            id: createId(),
            name,
            x: round1(endStation.x + dx * step),
            y: round1(endStation.y + dy * step),
            ...(dLng !== null ? { lng: endStation.lng! + dLng * step } : {}),
            ...(dLat !== null ? { lat: endStation.lat! + dLat * step } : {})
          };
        });

        graph = { ...graph, stations: [...graph.stations, ...newStations] };
        let currFromId = endStation.id;
        for (let i = 0; i < newStations.length; i += 1) {
          graph = connectStationsOnLine(graph, {
            lineId: op.lineId,
            fromStationId: currFromId,
            toStationId: newStations[i].id,
            makeId: createId
          }).graph;
          currFromId = newStations[i].id;
        }
        applied += 1;
        break;
      }

      case 'rename_station': {
        if (!graph.stations.some((s) => s.id === op.stationId)) break;
        graph = {
          ...graph,
          stations: graph.stations.map((s) => (s.id === op.stationId ? { ...s, name: op.name.trim() } : s))
        };
        applied += 1;
        break;
      }

      case 'delete_station': {
        if (!graph.stations.some((s) => s.id === op.stationId)) break;
        graph = deleteStationFromGraph(op.stationId, graph, createId);
        applied += 1;
        break;
      }
    }
  }

  return {
    lines: graph.lines,
    stations: graph.stations,
    sections: graph.sections,
    mapSettings: nextSettings,
    currentLineId: nextCurrentLineId,
    applied
  };
}

/**
 * 把任意 AIOperation 格式化为人类可读的中文操作预览摘要。
 */
export function summarizeAIOperation(
  op: AIOperation,
  lines: ReadonlyArray<Pick<Line, 'id' | 'name'>>,
  stations: ReadonlyArray<Pick<Station, 'id' | 'name'>>
): string {
  const lineName = (id: string) => lines.find((l) => l.id === id)?.name || `#${id.slice(0, 6)}`;
  const stationName = (id: string) => stations.find((s) => s.id === id)?.name || `#${id.slice(0, 6)}`;

  switch (op.type) {
    case 'create_new_line_with_stations':
      return `新建线路「${op.name}」（${op.color}），包含 ${op.stationNames.length} 站：${op.stationNames.join('、')}`;
    case 'create_loop_line':
      return `新建环线「${op.name}」（${op.color}），串联 ${op.stationNames.length} 座环线站：${op.stationNames.join('、')}`;
    case 'close_line_loop':
      return `将「${lineName(op.lineId)}」首尾相连闭合为环线`;
    case 'create_branch_line':
      return `从「${lineName(op.lineId)}」的「${stationName(op.branchFromStationId)}」分叉支线，新增 ${op.newStationNames.length} 站：${op.newStationNames.join('、')}`;
    case 'batch_rename_stations': {
      const preview = op.renames
        .slice(0, 4)
        .map((r) => `${stationName(r.stationId)}→${r.name}`)
        .join('、');
      const more = op.renames.length > 4 ? ` 等共 ${op.renames.length} 座站点` : `（共 ${op.renames.length} 座站点）`;
      return `批量命名站点：${preview}${more}`;
    }
    case 'merge_stations':
      return `将「${stationName(op.sourceStationId)}」合并入「${stationName(op.targetStationId)}」成为换乘站`;
    case 'configure_map': {
      const parts: string[] = [];
      if (op.lightCityArchetype) {
        if (op.lightCityArchetype === 'shuffle') parts.push('刷新轻城市随机种子');
        else {
          const meta = LIGHT_CITY_ARCHETYPES.find((m) => m.id === op.lightCityArchetype);
          parts.push(`切换轻城市地貌为「${meta?.zh || op.lightCityArchetype}」`);
        }
      }
      if (op.canvasTheme) parts.push(`画布主题设为${op.canvasTheme === 'dark' ? '深色' : '浅色'}`);
      if (op.cityStyle) parts.push(`视觉风格切换为 ${op.cityStyle}`);
      if (typeof op.cornerRadius === 'number') parts.push(`转角圆弧半径设为 ${op.cornerRadius}px`);
      if (typeof op.hideWaypoints === 'boolean') parts.push(op.hideWaypoints ? '默认隐藏途经点' : '显示途经点控制柄');
      return parts.join(' · ') || '更新地图视觉与底图配置';
    }
    case 'create_line':
      return `新建线路「${op.name}」（${op.color}），共 ${op.stationIds.length} 个站点`;
    case 'create_line_via_extension':
      return `新建线路「${op.name}」（${op.color}），从「${stationName(op.anchorStationId)}」延伸 ${op.newStationNames.length} 站：${op.newStationNames.join('、')}`;
    case 'recolor_line':
      return `「${lineName(op.lineId)}」颜色改为 ${op.color}`;
    case 'rename_line':
      return `线路「${lineName(op.lineId)}」改名为「${op.name}」`;
    case 'delete_line':
      return `删除线路「${lineName(op.lineId)}」`;
    case 'attach_station_to_line':
      return `把「${stationName(op.stationId)}」接到「${lineName(op.lineId)}」的${op.position === 'start' ? '起点' : '终点'}`;
    case 'create_station_between':
      return `在「${lineName(op.lineId)}」上「${stationName(op.afterStationId)}」和「${stationName(op.beforeStationId)}」之间插入 ${op.names.length} 站：${op.names.join('、')}`;
    case 'create_station_at_line_end':
      return `在「${lineName(op.lineId)}」的${op.position === 'start' ? '起点' : '终点'}延伸 ${op.names.length} 站：${op.names.join('、')}`;
    case 'rename_station':
      return `站点「${stationName(op.stationId)}」改名为「${op.name}」`;
    case 'delete_station':
      return `删除站点「${stationName(op.stationId)}」`;
  }
}

/**
 * 为 AI 规划助手生成高信噪比、低 Token 开销的空间+拓扑+轻城市地貌上下文载荷。
 */
export function buildCompactAIMapState(params: {
  lines: ReadonlyArray<Line>;
  stations: ReadonlyArray<Station>;
  sections: ReadonlyArray<Section>;
  mapSettings: MapSettings;
}): AIMapStatePayload {
  const { lines, stations, sections, mapSettings } = params;

  const lineCountByStation = new Map<string, number>();
  lines.forEach((l) => {
    l.stationIds.forEach((sid) => {
      lineCountByStation.set(sid, (lineCountByStation.get(sid) || 0) + 1);
    });
  });

  const stationSet = new Set(stations.map((s) => s.id));
  const secsByLine = new Map<string, Section[]>();
  sections.forEach((sec) => {
    const arr = secsByLine.get(sec.lineId);
    if (arr) arr.push(sec);
    else secsByLine.set(sec.lineId, [sec]);
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let defaultNamedStationCount = 0;

  const compactStations = stations.map((s) => {
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    const isDefault = isDefaultPlaceholderStationName(s.name);
    if (isDefault) defaultNamedStationCount += 1;
    const isTransfer = (lineCountByStation.get(s.id) || 0) >= 2;
    return {
      id: s.id,
      name: s.name,
      x,
      y,
      ...(isDefault ? { isDefaultName: true } : {}),
      ...(isTransfer ? { isTransfer: true } : {})
    };
  });

  const compactLines = lines.map((l) => {
    const topo = deriveLineTopology(l, secsByLine.get(l.id) || [], stationSet);
    return {
      id: l.id,
      name: l.name,
      color: l.color,
      stationIds: [...l.stationIds],
      ...(topo.isLoop ? { isLoop: true } : {}),
      ...(topo.hasBranch ? { hasBranch: true } : {})
    };
  });

  let lightCitySummary: string | undefined;
  if (mapSettings.baseMap.mode === 'light-city' && mapSettings.baseMap.lightCity) {
    const lc = mapSettings.baseMap.lightCity;
    const archMeta = LIGHT_CITY_ARCHETYPES.find((m) => m.id === lc.archetype);
    const labelDescs: string[] = [];
    const riverDescs: string[] = [];
    lc.features.forEach((f) => {
      if (f.type === 'label') {
        const tag = f.kind === 'water' ? '水系' : f.kind === 'district' ? '核心片区' : '次级片区';
        labelDescs.push(`${f.text}[${tag}]@(${Math.round(f.x)},${Math.round(f.y)})`);
      } else if (f.type === 'river' && f.points.length >= 2) {
        const p0 = f.points[0];
        const pm = f.points[Math.floor(f.points.length / 2)];
        const p1 = f.points[f.points.length - 1];
        riverDescs.push(
          `河道宽${f.width}: (${Math.round(p0.x)},${Math.round(p0.y)})→(${Math.round(pm.x)},${Math.round(pm.y)})→(${Math.round(p1.x)},${Math.round(p1.y)})`
        );
      }
    });
    lightCitySummary = [
      `地貌模板: ${archMeta?.zh || lc.archetype}`,
      labelDescs.length ? `片区与水名: ${labelDescs.slice(0, 12).join('、')}` : '',
      riverDescs.length ? `主要河流走向: ${riverDescs.slice(0, 6).join('；')}` : ''
    ]
      .filter(Boolean)
      .join(' | ');
  }

  return {
    lines: compactLines,
    stations: compactStations,
    spatialContext: {
      baseMapMode: mapSettings.baseMap.mode,
      ...(Number.isFinite(minX)
        ? {
            bounds: {
              minX,
              minY,
              maxX,
              maxY,
              centerX: Math.round((minX + maxX) / 2),
              centerY: Math.round((minY + maxY) / 2)
            }
          }
        : {}),
      defaultNamedStationCount,
      ...(lightCitySummary ? { lightCitySummary } : {})
    }
  };
}

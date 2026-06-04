// 线网图的纯图操作。抽成无副作用的纯函数，方便 UI 路径和 AI 路径共用同一份逻辑，
// 也方便单测覆盖（删站缝合这类边界 case 很容易回归）。

import { Line, Section, Station, Waypoint } from '../types';
import { createId } from '../utils/id';

export interface MapGraph {
  lines: Line[];
  stations: Station[];
  sections: Section[];
}

// 在某条线路的 sectionIds 里找连接 aId / bId 两站的区间（不区分方向）。
function findSectionBetween(
  line: Line,
  aId: string,
  bId: string,
  sectionById: Map<string, Section>
): Section | undefined {
  for (const sid of line.sectionIds) {
    const sec = sectionById.get(sid);
    if (!sec) continue;
    if (
      (sec.startStationId === aId && sec.endStationId === bId) ||
      (sec.startStationId === bId && sec.endStationId === aId)
    ) {
      return sec;
    }
  }
  return undefined;
}

// 取区间的途经点，并按 from → to 的方向摆正（waypoints 存储顺序是 start → end）。
function orientWaypoints(section: Section | undefined, fromId: string, toId: string): Waypoint[] {
  if (!section || !section.waypoints || section.waypoints.length === 0) return [];
  if (section.startStationId === fromId && section.endStationId === toId) {
    return [...section.waypoints];
  }
  if (section.startStationId === toId && section.endStationId === fromId) {
    return [...section.waypoints].reverse();
  }
  return [...section.waypoints];
}

// 删除一个站点。关键点：当站点位于某条线路的"中间"（前后都有邻站）时，
// 用一条新区间把前后邻站重新连上，避免线路在删站处断成两截。
// - 端点站（线路首/末）：只删站 + 它那一条区间，不缝合（行为同旧逻辑）。
// - 换乘站（同时在多条线路上）：逐条线路分别判断 / 缝合。
// - 缝合时尽力保留被删两段的途经点（按方向拼接）。
export function deleteStationFromGraph(stationId: string, graph: MapGraph): MapGraph {
  const { lines, stations, sections } = graph;
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const removedSectionIds = new Set<string>();
  const bridges: Section[] = [];

  const nextLines = lines.map((line) => {
    const idx = line.stationIds.indexOf(stationId);
    if (idx === -1) return line; // 该站不在这条线路上，原样返回

    const prevId = idx > 0 ? line.stationIds[idx - 1] : undefined;
    const nextId = idx < line.stationIds.length - 1 ? line.stationIds[idx + 1] : undefined;

    // 本线路上所有接触被删站的区间（待移除）
    const touchingSet = new Set(
      line.sectionIds.filter((sid) => {
        const sec = sectionById.get(sid);
        return !!sec && (sec.startStationId === stationId || sec.endStationId === stationId);
      })
    );
    touchingSet.forEach((sid) => removedSectionIds.add(sid));

    // 中间站 → 造一条 prev ↔ next 的缝合区间
    let bridge: Section | null = null;
    if (prevId && nextId) {
      const prevSec = findSectionBetween(line, prevId, stationId, sectionById);
      const nextSec = findSectionBetween(line, stationId, nextId, sectionById);
      const merged = [
        ...orientWaypoints(prevSec, prevId, stationId),
        ...orientWaypoints(nextSec, stationId, nextId)
      ];
      bridge = {
        id: createId(),
        lineId: line.id,
        startStationId: prevId,
        endStationId: nextId,
        ...(merged.length ? { waypoints: merged } : {})
      };
      bridges.push(bridge);
    }

    // 重建 sectionIds：丢掉接触区间，在"第一条被丢区间"的位置插入缝合区间（保持顺序）
    const nextSectionIds: string[] = [];
    let bridgeInserted = false;
    for (const sid of line.sectionIds) {
      if (touchingSet.has(sid)) {
        if (bridge && !bridgeInserted) {
          nextSectionIds.push(bridge.id);
          bridgeInserted = true;
        }
        continue;
      }
      nextSectionIds.push(sid);
    }

    return {
      ...line,
      stationIds: line.stationIds.filter((id) => id !== stationId),
      sectionIds: nextSectionIds,
      lastAddedStationId: line.lastAddedStationId === stationId ? undefined : line.lastAddedStationId
    };
  });

  const nextSections = [...sections.filter((s) => !removedSectionIds.has(s.id)), ...bridges];
  const nextStations = stations.filter((s) => s.id !== stationId);

  return { lines: nextLines, stations: nextStations, sections: nextSections };
}

import { Line, Section, Station, Waypoint } from '../types';
import { findWaypointInsertIndex } from './offsetPath';

// 线网图结构唯一纯函数事务底座（Graph Transaction Engine）：
// 以 sections[] 为连接拓扑的唯一真相来源（天然支持直线、闭合环线、Y 型支线与多线平行共轨），
// 自动派生并严格同步 line.sectionIds 与 line.stationIds，消除历史多处手工拼数组导致的数据撕裂。

export interface MapGraph {
  lines: Line[];
  stations: Station[];
  sections: Section[];
}

export interface LineTopologyMeta {
  stationIds: string[];
  isLoop: boolean;
  hasBranch: boolean;
  terminalStationIds: string[];
}

const normalizePair = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);

const defaultMakeId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * 从某条线路的真实连接边（lineSections）推导有序 stationIds、环线标识、支线标识与终端站集合。
 */
export function deriveLineTopology(line: Line, lineSections: Section[], validStationIds?: Set<string>): LineTopologyMeta {
  const prevOrder = line.stationIds.filter((id) => !validStationIds || validStationIds.has(id));
  const prevRank = new Map<string, number>();
  prevOrder.forEach((id, idx) => {
    if (!prevRank.has(id)) prevRank.set(id, idx);
  });

  if (lineSections.length === 0) {
    const deduped = Array.from(new Set(prevOrder));
    const terminals = deduped.length >= 2 ? [deduped[0], deduped[deduped.length - 1]] : deduped.slice(0, 1);
    return {
      stationIds: deduped,
      isLoop: false,
      hasBranch: false,
      terminalStationIds: terminals
    };
  }

  const adj = new Map<string, string[]>();
  const addNeighbor = (u: string, v: string) => {
    let list = adj.get(u);
    if (!list) {
      list = [];
      adj.set(u, list);
    }
    if (!list.includes(v)) list.push(v);
  };

  lineSections.forEach((sec) => {
    if (sec.startStationId === sec.endStationId) return;
    if (validStationIds && (!validStationIds.has(sec.startStationId) || !validStationIds.has(sec.endStationId))) return;
    addNeighbor(sec.startStationId, sec.endStationId);
    addNeighbor(sec.endStationId, sec.startStationId);
  });

  const connectedNodes = Array.from(adj.keys());
  if (connectedNodes.length === 0) {
    const deduped = Array.from(new Set(prevOrder));
    return { stationIds: deduped, isLoop: false, hasBranch: false, terminalStationIds: deduped.slice(0, 1) };
  }

  // 对每个节点的邻接表按原 stationIds 出现先后排序，确保遍历方向稳定、不随意翻转首末站
  const rankOf = (id: string) => prevRank.get(id) ?? Number.MAX_SAFE_INTEGER;
  adj.forEach((neighbors) => {
    neighbors.sort((a, b) => rankOf(a) - rankOf(b));
  });

  const degreeOneNodes = connectedNodes.filter((id) => (adj.get(id)?.length || 0) === 1);
  const hasBranch = connectedNodes.some((id) => (adj.get(id)?.length || 0) >= 3);

  // 判断是否为单连通纯环线（无度为1端点、无分叉、边数 === 顶点数 >= 3）
  let uniqueEdgeCount = 0;
  adj.forEach((neighbors) => {
    uniqueEdgeCount += neighbors.length;
  });
  uniqueEdgeCount /= 2;

  const visited = new Set<string>();
  const ordered: string[] = [];

  const traverseComponent = (startNode: string) => {
    const stack: string[] = [startNode];
    // 使用递归 DFS（节点数通常 < 500），保证主干一路走到底再回溯支线，顺序最自然
    const dfs = (u: string) => {
      visited.add(u);
      ordered.push(u);
      const neighbors = adj.get(u) || [];
      for (let i = 0; i < neighbors.length; i += 1) {
        const next = neighbors[i];
        if (!visited.has(next)) {
          dfs(next);
        }
      }
    };
    void stack;
    dfs(startNode);
  };

  // 优先从每个连通分量里原顺序最靠前的“端点（degree===1）”起走；若该分量是纯环则从原顺序最靠前节点起走
  const sortedCandidates = [...connectedNodes].sort((a, b) => {
    const degA = adj.get(a)?.length || 0;
    const degB = adj.get(b)?.length || 0;
    const endA = degA === 1 ? 0 : 1;
    const endB = degB === 1 ? 0 : 1;
    if (endA !== endB) return endA - endB;
    return rankOf(a) - rankOf(b);
  });

  let componentCount = 0;
  for (let i = 0; i < sortedCandidates.length; i += 1) {
    const node = sortedCandidates[i];
    if (!visited.has(node)) {
      componentCount += 1;
      traverseComponent(node);
    }
  }

  // 保留「仅加入线路但尚未连线」的孤立站点在末尾，兼容旧右键动作与导入数据
  prevOrder.forEach((id) => {
    if (!visited.has(id)) {
      visited.add(id);
      ordered.push(id);
    }
  });

  const isLoop =
    componentCount === 1 &&
    !hasBranch &&
    degreeOneNodes.length === 0 &&
    connectedNodes.length >= 3 &&
    uniqueEdgeCount === connectedNodes.length;

  const terminalStationIds = isLoop
    ? []
    : degreeOneNodes.length > 0
      ? degreeOneNodes
      : ordered.length > 0
        ? [ordered[0]]
        : [];

  return {
    stationIds: ordered,
    isLoop,
    hasBranch,
    terminalStationIds
  };
}

/**
 * 拓扑自愈归一化：清理孤儿边、合并同线重复边、根据真实连线同步每条线路的 sectionIds 与 stationIds。
 */
export function reconcileGraph(graph: MapGraph): MapGraph {
  const stationSet = new Set(graph.stations.map((s) => s.id));
  const lineSet = new Set(graph.lines.map((l) => l.id));

  const seenLinePair = new Set<string>();
  const cleanSections: Section[] = [];
  const sectionsByLine = new Map<string, Section[]>();

  for (let i = 0; i < graph.sections.length; i += 1) {
    const sec = graph.sections[i];
    if (!lineSet.has(sec.lineId)) continue;
    if (!stationSet.has(sec.startStationId) || !stationSet.has(sec.endStationId)) continue;
    if (sec.startStationId === sec.endStationId) continue;

    const linePairKey = `${sec.lineId}::${normalizePair(sec.startStationId, sec.endStationId)}`;
    if (seenLinePair.has(linePairKey)) continue;
    seenLinePair.add(linePairKey);

    cleanSections.push(sec);
    const list = sectionsByLine.get(sec.lineId);
    if (list) list.push(sec);
    else sectionsByLine.set(sec.lineId, [sec]);
  }

  const nextLines = graph.lines.map((line) => {
    const lineSecs = sectionsByLine.get(line.id) || [];
    const { stationIds } = deriveLineTopology(line, lineSecs, stationSet);
    const hasValidLast =
      line.lastAddedStationId !== undefined &&
      stationSet.has(line.lastAddedStationId) &&
      stationIds.includes(line.lastAddedStationId);
    const nextLine: Line = {
      ...line,
      stationIds,
      sectionIds: lineSecs.map((s) => s.id)
    };
    if (line.lastAddedStationId !== undefined) {
      nextLine.lastAddedStationId = hasValidLast ? line.lastAddedStationId : undefined;
    }
    return nextLine;
  });

  return {
    lines: nextLines,
    stations: graph.stations,
    sections: cleanSections
  };
}

/**
 * 在指定线路上连接两个已存在站点（若尚未连接则新建区间，保留传入 waypoints 的精确走向顺序）。
 * 返回更新后的图、新建区间 ID 以及本次连线是否闭合形成了环路（closedLoop）。
 */
export function connectStationsOnLine(
  graph: MapGraph,
  params: {
    lineId: string;
    fromStationId: string;
    toStationId: string;
    waypoints?: Waypoint[];
    makeId?: () => string;
  }
): { graph: MapGraph; sectionId: string | null; closedLoop: boolean } {
  const { lineId, fromStationId, toStationId, waypoints, makeId = defaultMakeId } = params;
  if (!fromStationId || !toStationId || fromStationId === toStationId) {
    return { graph, sectionId: null, closedLoop: false };
  }

  const targetLine = graph.lines.find((l) => l.id === lineId);
  const stationSet = new Set(graph.stations.map((s) => s.id));
  if (!targetLine || !stationSet.has(fromStationId) || !stationSet.has(toStationId)) {
    return { graph, sectionId: null, closedLoop: false };
  }

  const lineSections = graph.sections.filter((s) => s.lineId === lineId);
  const existing = lineSections.find(
    (s) => normalizePair(s.startStationId, s.endStationId) === normalizePair(fromStationId, toStationId)
  );
  if (existing) {
    return { graph: reconcileGraph(graph), sectionId: existing.id, closedLoop: false };
  }

  // 检查连接前两点是否已在本线连通：若是，则这一笔闭合形成了环路/联络环
  const visited = new Set<string>([fromStationId]);
  const queue = [fromStationId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === toStationId) break;
    for (let i = 0; i < lineSections.length; i += 1) {
      const sec = lineSections[i];
      if (sec.startStationId === curr && !visited.has(sec.endStationId)) {
        visited.add(sec.endStationId);
        queue.push(sec.endStationId);
      } else if (sec.endStationId === curr && !visited.has(sec.startStationId)) {
        visited.add(sec.startStationId);
        queue.push(sec.startStationId);
      }
    }
  }
  const closedLoop = visited.has(toStationId);

  const newSection: Section = {
    id: makeId(),
    lineId,
    startStationId: fromStationId,
    endStationId: toStationId,
    ...(waypoints && waypoints.length > 0 ? { waypoints: waypoints.map((wp) => ({ ...wp })) } : {})
  };

  // 将新连接端点提示性地纳入 stationIds 后再走 reconcileGraph，保证首站延伸时能正确把新站排在队首
  const hintedLines = graph.lines.map((line) => {
    if (line.id !== lineId) return line;
    let nextIds = [...line.stationIds];
    if (!nextIds.includes(fromStationId)) nextIds.push(fromStationId);
    if (!nextIds.includes(toStationId)) {
      if (nextIds[0] === fromStationId && nextIds.length >= 2) {
        // 从原起点站向外延伸：把新终点置于数组最前，维持整条线既有顺序不翻转
        nextIds = [toStationId, ...nextIds];
      } else {
        nextIds.push(toStationId);
      }
    }
    return {
      ...line,
      stationIds: nextIds,
      sectionIds: [...line.sectionIds, newSection.id],
      lastAddedStationId: toStationId
    };
  });

  return {
    graph: reconcileGraph({
      lines: hintedLines,
      stations: graph.stations,
      sections: [...graph.sections, newSection]
    }),
    sectionId: newSection.id,
    closedLoop
  };
}

/**
 * 在已有区间线段上无损切分插入一个新站点：
 * - 自动把原 Section(A, B) 拆分为 Section(A, New) + Section(New, B)；
 * - 原区间的 waypoints 按插点所在子段自动一分为二归入前后两段，绝不丢失既有折角或圆弧；
 * - 若同时指定了 connectFromStationId + activeLineId（如在绘制连笔中直接点击另一段区间做 T 字接入），一并原子建立连接。
 */
export function insertStationOnSection(
  graph: MapGraph,
  params: {
    sectionId: string;
    station: Station;
    splitSharedPair?: boolean;
    connectFrom?: { lineId: string; fromStationId: string; waypoints?: Waypoint[] };
    makeId?: () => string;
  }
): MapGraph {
  const { sectionId, station, splitSharedPair = true, connectFrom, makeId = defaultMakeId } = params;
  const targetSection = graph.sections.find((s) => s.id === sectionId);
  if (!targetSection) return graph;

  const stationById = new Map(graph.stations.map((s) => [s.id, s]));
  const targetPairKey = normalizePair(targetSection.startStationId, targetSection.endStationId);

  const sectionsToSplit = new Set<string>(
    graph.sections
      .filter((sec) =>
        sec.id === sectionId ||
        (splitSharedPair && normalizePair(sec.startStationId, sec.endStationId) === targetPairKey)
      )
      .map((sec) => sec.id)
  );

  const nextSections: Section[] = [];
  const lineInsertHint = new Map<string, { a: string; b: string }>();

  graph.sections.forEach((sec) => {
    if (!sectionsToSplit.has(sec.id)) {
      nextSections.push(sec);
      return;
    }
    const startSt = stationById.get(sec.startStationId);
    const endSt = stationById.get(sec.endStationId);
    const wps = sec.waypoints || [];
    let splitIdx = 0;
    if (startSt && endSt && wps.length > 0) {
      splitIdx = findWaypointInsertIndex(startSt, wps, endSt, station).insertIndex;
    }
    const firstWps = wps.slice(0, splitIdx);
    const secondWps = wps.slice(splitIdx);

    nextSections.push(
      {
        id: makeId(),
        lineId: sec.lineId,
        startStationId: sec.startStationId,
        endStationId: station.id,
        ...(firstWps.length ? { waypoints: firstWps } : {})
      },
      {
        id: makeId(),
        lineId: sec.lineId,
        startStationId: station.id,
        endStationId: sec.endStationId,
        ...(secondWps.length ? { waypoints: secondWps } : {})
      }
    );
    lineInsertHint.set(sec.lineId, { a: sec.startStationId, b: sec.endStationId });
  });

  const nextStations = graph.stations.some((s) => s.id === station.id)
    ? graph.stations
    : [...graph.stations, station];

  const hintedLines = graph.lines.map((line) => {
    const hint = lineInsertHint.get(line.id);
    if (!hint) return line;
    const ids = [...line.stationIds];
    const idxA = ids.indexOf(hint.a);
    const idxB = ids.indexOf(hint.b);
    if (idxA !== -1 && idxB !== -1 && Math.abs(idxA - idxB) === 1 && !ids.includes(station.id)) {
      ids.splice(Math.max(idxA, idxB), 0, station.id);
    }
    return { ...line, stationIds: ids, lastAddedStationId: station.id };
  });

  let nextGraph = reconcileGraph({
    lines: hintedLines,
    stations: nextStations,
    sections: nextSections
  });

  if (connectFrom && connectFrom.fromStationId && connectFrom.fromStationId !== station.id) {
    nextGraph = connectStationsOnLine(nextGraph, {
      lineId: connectFrom.lineId,
      fromStationId: connectFrom.fromStationId,
      toStationId: station.id,
      waypoints: connectFrom.waypoints,
      makeId
    }).graph;
  }

  return nextGraph;
}

/**
 * 拼接两段相连区间（A—stationId 与 stationId—C）在缝合为 A—C 时的途经点，保持原有的弯曲形状不丢失。
 */
function mergeStitchedWaypoints(
  secAB: Section,
  secBC: Section,
  stationAId: string,
  removedId: string,
  stationCId: string
): Waypoint[] {
  const wps1 = secAB.waypoints || [];
  const ordered1 = secAB.startStationId === stationAId && secAB.endStationId === removedId ? wps1 : [...wps1].reverse();
  const wps2 = secBC.waypoints || [];
  const ordered2 = secBC.startStationId === removedId && secBC.endStationId === stationCId ? wps2 : [...wps2].reverse();
  return [...ordered1, ...ordered2];
}

/**
 * 从单条线路中移除一个站点：若该站是本线中间过路站（度===2），自动把前后邻站缝合为直连区间（修复老代码腰斩断线 Bug）。
 */
export function removeStationFromLine(
  graph: MapGraph,
  lineId: string,
  stationId: string,
  makeId: () => string = defaultMakeId
): MapGraph {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return graph;

  const lineSections = graph.sections.filter((s) => s.lineId === lineId);
  const touching = lineSections.filter((s) => s.startStationId === stationId || s.endStationId === stationId);
  const untouchedForLine = lineSections.filter((s) => s.startStationId !== stationId && s.endStationId !== stationId);
  const otherSections = graph.sections.filter((s) => s.lineId !== lineId);

  let stitched: Section | null = null;
  if (touching.length === 2) {
    const neighborOf = (sec: Section) => (sec.startStationId === stationId ? sec.endStationId : sec.startStationId);
    const a = neighborOf(touching[0]);
    const c = neighborOf(touching[1]);
    if (a !== c) {
      const alreadyConnected = untouchedForLine.some(
        (s) => normalizePair(s.startStationId, s.endStationId) === normalizePair(a, c)
      );
      if (!alreadyConnected) {
        // 按原 stationIds 中 a 与 c 的先后顺序决定缝合段正方向
        const idxA = line.stationIds.indexOf(a);
        const idxC = line.stationIds.indexOf(c);
        const orderedStart = idxA !== -1 && idxC !== -1 && idxC < idxA ? c : a;
        const orderedEnd = orderedStart === a ? c : a;
        const firstSec =
          touching[0].startStationId === orderedStart || touching[0].endStationId === orderedStart
            ? touching[0]
            : touching[1];
        const secondSec = firstSec === touching[0] ? touching[1] : touching[0];
        const mergedWps = mergeStitchedWaypoints(firstSec, secondSec, orderedStart, stationId, orderedEnd);
        stitched = {
          id: makeId(),
          lineId,
          startStationId: orderedStart,
          endStationId: orderedEnd,
          ...(mergedWps.length ? { waypoints: mergedWps } : {})
        };
      }
    }
  }

  // 在首个被移除区间的原位插入缝合段，保持区间数组顺序稳定
  const nextLineSections: Section[] = [];
  let insertedStitched = false;
  for (let i = 0; i < lineSections.length; i += 1) {
    const sec = lineSections[i];
    if (sec.startStationId === stationId || sec.endStationId === stationId) {
      if (stitched && !insertedStitched) {
        nextLineSections.push(stitched);
        insertedStitched = true;
      }
    } else {
      nextLineSections.push(sec);
    }
  }
  if (stitched && !insertedStitched) {
    nextLineSections.push(stitched);
  }

  const nextLines = graph.lines.map((l) =>
    l.id !== lineId
      ? l
      : {
          ...l,
          stationIds: l.stationIds.filter((id) => id !== stationId),
          sectionIds: nextLineSections.map((s) => s.id),
          ...(l.lastAddedStationId === stationId ? { lastAddedStationId: undefined } : {})
        }
  );

  return reconcileGraph({
    lines: nextLines,
    stations: graph.stations,
    sections: [...otherSections, ...nextLineSections]
  });
}

/**
 * 全局删除一个站点（保持 (stationId, graph) 签名向后兼容）：对每条经过该站的线路执行安全缝合，并移除站点实体。
 */
export function deleteStationFromGraph(
  stationId: string,
  graph: MapGraph,
  makeId: () => string = defaultMakeId
): MapGraph {
  if (!graph.stations.some((s) => s.id === stationId)) {
    return graph;
  }

  let working: MapGraph = graph;
  for (let i = 0; i < graph.lines.length; i += 1) {
    const line = graph.lines[i];
    const touchesLine =
      line.stationIds.includes(stationId) ||
      working.sections.some(
        (s) => s.lineId === line.id && (s.startStationId === stationId || s.endStationId === stationId)
      );
    if (touchesLine) {
      working = removeStationFromLine(working, line.id, stationId, makeId);
    }
  }

  return reconcileGraph({
    lines: working.lines,
    stations: working.stations.filter((s) => s.id !== stationId),
    sections: working.sections.filter((s) => s.startStationId !== stationId && s.endStationId !== stationId)
  });
}

/**
 * 批量删除多个站点（用于框选/多选按 Delete 删除），逐站缝合保证连续删中间多站后两端依然连通。
 */
export function deleteStationsFromGraph(
  stationIds: ReadonlyArray<string>,
  graph: MapGraph,
  makeId: () => string = defaultMakeId
): MapGraph {
  let next = graph;
  for (let i = 0; i < stationIds.length; i += 1) {
    next = deleteStationFromGraph(stationIds[i], next, makeId);
  }
  return next;
}

/**
 * 侧边栏拖拽重排线性线路的站点顺序：同步重建/复用区间（若原相邻对反转则翻转途经点），消除顺序与画布连线失步。
 */
export function reorderLineStations(
  graph: MapGraph,
  lineId: string,
  stationIds: string[],
  makeId: () => string = defaultMakeId
): MapGraph {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return graph;

  const oldLineSections = graph.sections.filter((s) => s.lineId === lineId);
  const { hasBranch, isLoop } = deriveLineTopology(line, oldLineSections);
  // 若该线路已是复杂支线或闭合环线，仅更新偏好排序提示而不暴力拆毁分叉拓扑
  if (hasBranch || isLoop || oldLineSections.length === 0) {
    return reconcileGraph({
      ...graph,
      lines: graph.lines.map((l) => (l.id === lineId ? { ...l, stationIds } : l))
    });
  }

  const oldPairMap = new Map<string, Section>();
  oldLineSections.forEach((sec) => {
    oldPairMap.set(normalizePair(sec.startStationId, sec.endStationId), sec);
  });

  const rebuiltLineSections: Section[] = [];
  for (let i = 0; i < stationIds.length - 1; i += 1) {
    const a = stationIds[i];
    const b = stationIds[i + 1];
    if (!a || !b || a === b) continue;
    const prevSec = oldPairMap.get(normalizePair(a, b));
    if (prevSec) {
      const reversed = prevSec.startStationId !== a;
      rebuiltLineSections.push({
        ...prevSec,
        startStationId: a,
        endStationId: b,
        ...(prevSec.waypoints?.length
          ? { waypoints: reversed ? [...prevSec.waypoints].reverse() : prevSec.waypoints }
          : {})
      });
    } else {
      rebuiltLineSections.push({
        id: makeId(),
        lineId,
        startStationId: a,
        endStationId: b
      });
    }
  }

  const otherSections = graph.sections.filter((s) => s.lineId !== lineId);
  return reconcileGraph({
    lines: graph.lines.map((l) =>
      l.id !== lineId
        ? l
        : {
            ...l,
            stationIds,
            sectionIds: rebuiltLineSections.map((s) => s.id)
          }
    ),
    stations: graph.stations,
    sections: [...otherSections, ...rebuiltLineSections]
  });
}

/**
 * 将 sourceStationId 合并入 targetStationId 成为换乘站：重连所有关联区间并清理重复边与自环。
 */
export function mergeStationsIntoInterchange(
  graph: MapGraph,
  sourceStationId: string,
  targetStationId: string
): MapGraph {
  if (!sourceStationId || !targetStationId || sourceStationId === targetStationId) return graph;
  if (!graph.stations.some((s) => s.id === sourceStationId) || !graph.stations.some((s) => s.id === targetStationId)) {
    return graph;
  }

  const rewiredSections = graph.sections.map((sec) => ({
    ...sec,
    startStationId: sec.startStationId === sourceStationId ? targetStationId : sec.startStationId,
    endStationId: sec.endStationId === sourceStationId ? targetStationId : sec.endStationId
  }));

  const updatedLines = graph.lines.map((line) => ({
    ...line,
    stationIds: Array.from(new Set(line.stationIds.map((id) => (id === sourceStationId ? targetStationId : id)))),
    lastAddedStationId: line.lastAddedStationId === sourceStationId ? targetStationId : line.lastAddedStationId
  }));

  return reconcileGraph({
    lines: updatedLines,
    stations: graph.stations.filter((s) => s.id !== sourceStationId),
    sections: rewiredSections
  });
}

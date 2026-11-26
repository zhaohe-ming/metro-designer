import { Line, Section, Station } from '../types';
import { deriveLineTopology, MapGraph } from '../lib/graphOps';
import { createId } from '../utils/id';
import {
  cloneProOpsDocument,
  ProOpsDocument,
  ProRouteStep,
  ProServicePattern,
  ProServiceValidation,
  ProTrackConnection,
  ProValidationIssue
} from './types';

const normalizePair = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);

export interface ReconcileProOpsResult {
  proOps: ProOpsDocument;
  validations: Record<string, ProServiceValidation>;
  brokenConnectionIds: Set<string>;
}

/**
 * 保守型单线区间裂变检测（Conservative Deterministic Split-Healing）：
 * 仅当原区间 (lineId, fromStationId, toStationId) 在同一条线路上被新插入的中间站拆分为
 * 一条唯一的、中间节点度数全部为 2、且中间节点均未在该交路其他步出现过的简单链时，才自动展开修复；
 * 任何删站、改线、环路歧义或支线分叉一律拒绝盲猜，交由 broken 断链状态提示用户确认。
 */
function findDeterministicSplitChain(
  lineSections: Section[],
  fromStationId: string,
  toStationId: string,
  existingVisitedStations: ReadonlySet<string>
): Array<{ section: Section; fromId: string; toId: string }> | null {
  if (fromStationId === toStationId) return null;

  const adj = new Map<string, Array<{ neighbor: string; section: Section }>>();
  const addEdge = (u: string, v: string, section: Section) => {
    const list = adj.get(u);
    if (list) list.push({ neighbor: v, section });
    else adj.set(u, [{ neighbor: v, section }]);
  };

  lineSections.forEach((sec) => {
    addEdge(sec.startStationId, sec.endStationId, sec);
    addEdge(sec.endStationId, sec.startStationId, sec);
  });

  if (!adj.has(fromStationId) || !adj.has(toStationId)) return null;

  const maxDepth = 6;
  const matchedChains: Array<Array<{ section: Section; fromId: string; toId: string }>> = [];

  const dfs = (
    curr: string,
    visited: Set<string>,
    chain: Array<{ section: Section; fromId: string; toId: string }>
  ) => {
    if (chain.length > maxDepth || matchedChains.length > 1) return;
    const edges = adj.get(curr) || [];
    for (let i = 0; i < edges.length; i += 1) {
      const { neighbor, section } = edges[i];
      if (neighbor === toStationId) {
        if (chain.length >= 1) {
          matchedChains.push([...chain, { section, fromId: curr, toId: neighbor }]);
        }
        continue;
      }
      if (visited.has(neighbor)) continue;
      // 严苛条件 1：裂变出的新中间站在本线上度数必须严格为 2（无支线岔口）
      const deg = adj.get(neighbor)?.length || 0;
      if (deg !== 2) continue;
      // 严苛条件 2：中间站绝不能是该交路原本已访问过的车站（彻底杜绝环线反向绕圈误判）
      if (existingVisitedStations.has(neighbor)) continue;

      visited.add(neighbor);
      chain.push({ section, fromId: curr, toId: neighbor });
      dfs(neighbor, visited, chain);
      chain.pop();
      visited.delete(neighbor);
    }
  };

  dfs(fromStationId, new Set([fromStationId]), []);
  return matchedChains.length === 1 ? matchedChains[0] : null;
}

/**
 * 同步并校验专业运营文档与最新物理线网拓扑：
 * - 清理孤儿属性配置（lineSpecs / stationProfiles / sectionOverrides）；
 * - 对确定性的单区间插站裂变做无损展开；
 * - 对删站、拆线、缺失联络线等不确定变更保留原交路并标记 status = 'broken'，绝不静默删交路。
 */
export function reconcileProOps(graph: MapGraph, doc: ProOpsDocument): ReconcileProOpsResult {
  const next = cloneProOpsDocument(doc);
  const stationMap = new Map<string, Station>(graph.stations.map((s) => [s.id, s]));
  const lineMap = new Map<string, Line>(graph.lines.map((l) => [l.id, l]));
  const sectionMap = new Map<string, Section>(graph.sections.map((s) => [s.id, s]));

  const sectionsByLine = new Map<string, Section[]>();
  const sectionByLinePair = new Map<string, Section>();
  graph.sections.forEach((sec) => {
    const list = sectionsByLine.get(sec.lineId);
    if (list) list.push(sec);
    else sectionsByLine.set(sec.lineId, [sec]);
    sectionByLinePair.set(`${sec.lineId}::${normalizePair(sec.startStationId, sec.endStationId)}`, sec);
  });

  // 1) 清理无副作用的稀疏属性字典孤儿键
  Object.keys(next.lineSpecs).forEach((lineId) => {
    if (!lineMap.has(lineId)) delete next.lineSpecs[lineId];
  });
  Object.keys(next.stationProfiles).forEach((stationId) => {
    if (!stationMap.has(stationId)) delete next.stationProfiles[stationId];
  });
  Object.keys(next.sectionOverrides).forEach((sectionId) => {
    if (!sectionMap.has(sectionId)) delete next.sectionOverrides[sectionId];
  });

  // 2) 校验跨线物理连接（联络线/道岔），保留断链项以便用户在面板修复
  const lineStationSets = new Map<string, Set<string>>();
  graph.lines.forEach((line) => {
    lineStationSets.set(line.id, new Set(line.stationIds));
  });

  const brokenConnectionIds = new Set<string>();
  next.trackConnections = next.trackConnections.map((conn) => {
    const fromSt = stationMap.get(conn.fromStationId);
    const toSt = stationMap.get(conn.toStationId);
    const validFrom = Boolean(fromSt && lineStationSets.get(conn.fromLineId)?.has(conn.fromStationId));
    const validTo = Boolean(toSt && lineStationSets.get(conn.toLineId)?.has(conn.toStationId));
    if (!validFrom || !validTo) {
      brokenConnectionIds.add(conn.id);
    }
    return {
      ...conn,
      ...(fromSt ? { fromStationNameHint: fromSt.name } : {}),
      ...(toSt ? { toStationNameHint: toSt.name } : {})
    };
  });
  const connMap = new Map<string, ProTrackConnection>(next.trackConnections.map((c) => [c.id, c]));

  // 3) 逐交路进行保守裂变自愈与断链校验
  const validations: Record<string, ProServiceValidation> = {};

  next.servicePatterns = next.servicePatterns.map((pattern) => {
    const existingStationsInPattern = new Set<string>();
    pattern.routeSteps.forEach((s) => {
      existingStationsInPattern.add(s.fromStationId);
      existingStationsInPattern.add(s.toStationId);
    });

    const expandedSteps: ProRouteStep[] = [];
    let healedSplitCount = 0;

    pattern.routeSteps.forEach((step) => {
      const freshFromName = stationMap.get(step.fromStationId)?.name || step.fromStationNameHint;
      const freshToName = stationMap.get(step.toStationId)?.name || step.toStationNameHint;

      if (step.kind === 'connection') {
        expandedSteps.push({
          ...step,
          ...(freshFromName ? { fromStationNameHint: freshFromName } : {}),
          ...(freshToName ? { toStationNameHint: freshToName } : {})
        });
        return;
      }

      // 优先检查原 sectionId 是否仍匹配同一线路与端点对
      const directSec = sectionMap.get(step.sectionId);
      const expectedPair = normalizePair(step.fromStationId, step.toStationId);
      if (
        directSec &&
        directSec.lineId === step.lineId &&
        normalizePair(directSec.startStationId, directSec.endStationId) === expectedPair
      ) {
        expandedSteps.push({
          ...step,
          ...(freshFromName ? { fromStationNameHint: freshFromName } : {}),
          ...(freshToName ? { toStationNameHint: freshToName } : {})
        });
        return;
      }

      // 次优：同线同端点对但重新生成过 sectionId
      const samePairSec = sectionByLinePair.get(`${step.lineId}::${expectedPair}`);
      if (samePairSec) {
        expandedSteps.push({
          ...step,
          sectionId: samePairSec.id,
          ...(freshFromName ? { fromStationNameHint: freshFromName } : {}),
          ...(freshToName ? { toStationNameHint: freshToName } : {})
        });
        return;
      }

      // 保守裂变自愈：检查是否仅在原区间内插入了度为 2 的新中间站
      const lineSecs = sectionsByLine.get(step.lineId) || [];
      const splitChain = findDeterministicSplitChain(
        lineSecs,
        step.fromStationId,
        step.toStationId,
        existingStationsInPattern
      );

      if (splitChain && splitChain.length >= 2) {
        healedSplitCount += 1;
        const intermediateStopDefault =
          pattern.category === 'local' || pattern.category === 'short_turn';
        splitChain.forEach((seg, segIdx) => {
          const isLast = segIdx === splitChain.length - 1;
          const segFromName = stationMap.get(seg.fromId)?.name;
          const segToName = stationMap.get(seg.toId)?.name;
          expandedSteps.push({
            kind: 'section',
            sectionId: seg.section.id,
            lineId: step.lineId,
            fromStationId: seg.fromId,
            toStationId: seg.toId,
            ...(segFromName ? { fromStationNameHint: segFromName } : {}),
            ...(segToName ? { toStationNameHint: segToName } : {}),
            stopAtEnd: isLast ? step.stopAtEnd : intermediateStopDefault,
            ...(isLast && step.dwellSecOverride !== undefined
              ? { dwellSecOverride: step.dwellSecOverride }
              : {})
          });
        });
        return;
      }

      // 无法确定性修复：原样保留该步并等待验证器标黄提示
      expandedSteps.push({
        ...step,
        ...(freshFromName ? { fromStationNameHint: freshFromName } : {}),
        ...(freshToName ? { toStationNameHint: freshToName } : {})
      });
    });

    const issues: ProValidationIssue[] = [];
    if (expandedSteps.length === 0) {
      issues.push({
        stepIndex: 0,
        code: 'missing_section',
        message: '该交路尚未配置任何有效运行区间'
      });
    }

    expandedSteps.forEach((step, idx) => {
      const labelFrom = stationMap.get(step.fromStationId)?.name || step.fromStationNameHint || '未知站';
      const labelTo = stationMap.get(step.toStationId)?.name || step.toStationNameHint || '未知站';

      if (step.kind === 'section') {
        const sec = sectionMap.get(step.sectionId);
        const expectedPair = normalizePair(step.fromStationId, step.toStationId);
        if (
          !sec ||
          sec.lineId !== step.lineId ||
          normalizePair(sec.startStationId, sec.endStationId) !== expectedPair
        ) {
          issues.push({
            stepIndex: idx,
            code: 'missing_section',
            message: `第 ${idx + 1} 步区间「${labelFrom} → ${labelTo}」已变更或断开`
          });
        }
      } else {
        const conn = connMap.get(step.connectionId);
        if (!conn || brokenConnectionIds.has(conn.id)) {
          issues.push({
            stepIndex: idx,
            code: 'missing_connection',
            message: `第 ${idx + 1} 步跨线连接「${labelFrom} → ${labelTo}」不存在或两端车站已变动`
          });
        } else {
          const forwardMatch =
            conn.fromLineId === step.fromLineId &&
            conn.fromStationId === step.fromStationId &&
            conn.toLineId === step.toLineId &&
            conn.toStationId === step.toStationId;
          const reverseMatch =
            conn.bidirectional &&
            conn.toLineId === step.fromLineId &&
            conn.toStationId === step.fromStationId &&
            conn.fromLineId === step.toLineId &&
            conn.fromStationId === step.toStationId;
          if (!forwardMatch && !reverseMatch) {
            issues.push({
              stepIndex: idx,
              code: 'missing_connection',
              message: `第 ${idx + 1} 步跨线连接方向或归属线路不匹配`
            });
          }
        }
      }

      if (idx > 0) {
        const prev = expandedSteps[idx - 1];
        const prevEndLine = prev.kind === 'section' ? prev.lineId : prev.toLineId;
        const currStartLine = step.kind === 'section' ? step.lineId : step.fromLineId;
        if (prev.toStationId !== step.fromStationId) {
          issues.push({
            stepIndex: idx,
            code: 'discontinuity',
            message: `第 ${idx} 步终点与第 ${idx + 1} 步起点车站不连续`
          });
        } else if (prevEndLine !== currStartLine) {
          issues.push({
            stepIndex: idx,
            code: 'discontinuity',
            message: `第 ${idx + 1} 步缺少跨线轨行连接（共站换乘需先配置跨线道岔）`
          });
        }
      }
    });

    validations[pattern.id] = {
      patternId: pattern.id,
      status: issues.length === 0 ? 'valid' : 'broken',
      issues,
      healedSplitCount
    };

    return {
      ...pattern,
      routeSteps: expandedSteps
    };
  });

  return {
    proOps: next,
    validations,
    brokenConnectionIds
  };
}

/**
 * 提取某条线路在两点之间（或全线/整环）的有序物理区间步序列，用于一键创建/修复交路。
 */
export function buildOrderedLineSteps(
  graph: MapGraph,
  lineId: string,
  options?: {
    startStationId?: string;
    endStationId?: string;
    stopPredicate?: (stationId: string, isTerminal: boolean) => boolean;
  }
): ProRouteStep[] {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return [];
  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const lineSections = graph.sections.filter((s) => s.lineId === lineId);
  if (lineSections.length === 0) return [];

  const topo = deriveLineTopology(line, lineSections, new Set(stationMap.keys()));
  const sectionByPair = new Map<string, Section>();
  const adj = new Map<string, string[]>();
  lineSections.forEach((sec) => {
    sectionByPair.set(normalizePair(sec.startStationId, sec.endStationId), sec);
    const a = adj.get(sec.startStationId) || [];
    if (!a.includes(sec.endStationId)) a.push(sec.endStationId);
    adj.set(sec.startStationId, a);
    const b = adj.get(sec.endStationId) || [];
    if (!b.includes(sec.startStationId)) b.push(sec.startStationId);
    adj.set(sec.endStationId, b);
  });

  let stationChain: string[] = [];

  if (options?.startStationId && options?.endStationId) {
    if (options.startStationId === options.endStationId && topo.isLoop) {
      // 环线首末同站整圈：沿有序顶点走一圈回到起点
      const idx = topo.stationIds.indexOf(options.startStationId);
      const rotated =
        idx >= 0
          ? [...topo.stationIds.slice(idx), ...topo.stationIds.slice(0, idx), options.startStationId]
          : [...topo.stationIds, topo.stationIds[0]];
      stationChain = rotated;
    } else if (options.startStationId !== options.endStationId) {
      // BFS 在本线拓扑内寻找从起点到终点的简单路径
      const queue: string[][] = [[options.startStationId]];
      const visited = new Set<string>([options.startStationId]);
      while (queue.length > 0) {
        const path = queue.shift()!;
        const tail = path[path.length - 1];
        if (tail === options.endStationId) {
          stationChain = path;
          break;
        }
        const neighbors = adj.get(tail) || [];
        for (let i = 0; i < neighbors.length; i += 1) {
          const next = neighbors[i];
          if (!visited.has(next)) {
            visited.add(next);
            queue.push([...path, next]);
          }
        }
      }
    }
  }

  if (stationChain.length < 2) {
    if (topo.isLoop && topo.stationIds.length >= 3) {
      stationChain = [...topo.stationIds, topo.stationIds[0]];
    } else {
      // 从首站到末站取主干最长链
      const startId = topo.terminalStationIds[0] || topo.stationIds[0];
      const endId =
        topo.terminalStationIds.length >= 2
          ? topo.terminalStationIds[topo.terminalStationIds.length - 1]
          : topo.stationIds[topo.stationIds.length - 1];
      if (startId && endId && startId !== endId) {
        return buildOrderedLineSteps(graph, lineId, {
          startStationId: startId,
          endStationId: endId,
          stopPredicate: options?.stopPredicate
        });
      }
      stationChain = topo.stationIds;
    }
  }

  const steps: ProRouteStep[] = [];
  for (let i = 0; i < stationChain.length - 1; i += 1) {
    const fromId = stationChain[i];
    const toId = stationChain[i + 1];
    const sec = sectionByPair.get(normalizePair(fromId, toId));
    if (!sec) break;
    const isTerminal = i === stationChain.length - 2;
    const stopAtEnd = options?.stopPredicate ? options.stopPredicate(toId, isTerminal) : true;
    steps.push({
      kind: 'section',
      sectionId: sec.id,
      lineId,
      fromStationId: fromId,
      toStationId: toId,
      fromStationNameHint: stationMap.get(fromId)?.name,
      toStationNameHint: stationMap.get(toId)?.name,
      stopAtEnd
    });
  }
  return steps;
}

/**
 * 一键为指定物理线路生成「全程普通车」基准交路。
 */
export function createLineAllStopPattern(graph: MapGraph, lineId: string): ProServicePattern | null {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return null;
  const routeSteps = buildOrderedLineSteps(graph, lineId);
  if (routeSteps.length === 0) return null;
  return {
    id: createId(),
    name: `${line.name} 全程普通车`,
    code: '普通',
    color: line.color,
    category: 'local',
    stopAtStart: true,
    routeSteps,
    headwaySec: 240,
    bidirectional: true
  };
}

/**
 * 一键生成「大站快车」交路：默认仅停靠首末站与多线换乘站（若全线无换乘站则每隔 2~3 站停靠）。
 */
export function createLineExpressPattern(graph: MapGraph, lineId: string): ProServicePattern | null {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return null;

  const stationLineCounts = new Map<string, number>();
  graph.lines.forEach((l) => {
    new Set(l.stationIds).forEach((sid) => {
      stationLineCounts.set(sid, (stationLineCounts.get(sid) || 0) + 1);
    });
  });

  const baseSteps = buildOrderedLineSteps(graph, lineId);
  if (baseSteps.length === 0) return null;

  const hasTransferMid = baseSteps
    .slice(0, -1)
    .some((s) => (stationLineCounts.get(s.toStationId) || 1) >= 2);

  const expressSteps: ProRouteStep[] = baseSteps.map((step, idx) => {
    const isLast = idx === baseSteps.length - 1;
    if (isLast) return { ...step, stopAtEnd: true };
    const isTransfer = (stationLineCounts.get(step.toStationId) || 1) >= 2;
    const stopAtEnd = hasTransferMid ? isTransfer : (idx + 1) % 3 === 0;
    return { ...step, stopAtEnd };
  });

  return {
    id: createId(),
    name: `${line.name} 大站快车`,
    code: '快车',
    color: '#ea580c',
    category: 'express',
    stopAtStart: true,
    routeSteps: expressSteps,
    headwaySec: 360,
    bidirectional: true
  };
}

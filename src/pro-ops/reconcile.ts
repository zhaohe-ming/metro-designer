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
 * 线路子走廊分解单元：用于把含主支线、环线、6字线、多个独立不连通分段乃至孤立未连线车站的
 * 任意复杂单线拓扑 100% 无遗漏地展开为一维走廊序列与可选运行交路变体。
 */
export interface LineSubCorridor {
  id: string;
  kind: 'trunk' | 'branch' | 'loop' | 'segment' | 'isolated';
  label: string;
  stationIds: string[];
  steps: ProRouteStep[];
  /** 若为支线，标记其从主干/上一走廊分岔出的枢纽站 ID */
  branchFromStationId?: string;
  /** 若为闭合环，标记末尾列为回到起点的环闭合点 */
  isClosedLoop?: boolean;
}

export interface LineRouteVariant {
  key: string;
  label: string;
  isLoop: boolean;
  stationIds: string[];
  steps: ProRouteStep[];
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
      const deg = adj.get(neighbor)?.length || 0;
      if (deg !== 2) continue;
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

  Object.keys(next.lineSpecs).forEach((lineId) => {
    if (!lineMap.has(lineId)) delete next.lineSpecs[lineId];
  });
  Object.keys(next.stationProfiles).forEach((stationId) => {
    if (!stationMap.has(stationId)) delete next.stationProfiles[stationId];
  });
  Object.keys(next.sectionOverrides).forEach((sectionId) => {
    if (!sectionMap.has(sectionId)) delete next.sectionOverrides[sectionId];
  });
  if (Array.isArray(next.sharedTrackLinePairs)) {
    next.sharedTrackLinePairs = next.sharedTrackLinePairs.filter((pairKeyStr) => {
      const [a, b] = pairKeyStr.split('::');
      return Boolean(a && b && lineMap.has(a) && lineMap.has(b) && a !== b);
    });
  }

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

function stationChainToSteps(
  lineId: string,
  stationChain: string[],
  sectionByPair: ReadonlyMap<string, Section>,
  stationMap: ReadonlyMap<string, Station>,
  stopPredicate?: (stationId: string, isTerminal: boolean) => boolean
): ProRouteStep[] {
  const steps: ProRouteStep[] = [];
  for (let i = 0; i < stationChain.length - 1; i += 1) {
    const fromId = stationChain[i];
    const toId = stationChain[i + 1];
    const sec = sectionByPair.get(normalizePair(fromId, toId));
    if (!sec) break;
    const isTerminal = i === stationChain.length - 2;
    const stopAtEnd = stopPredicate ? stopPredicate(toId, isTerminal) : true;
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
 * 将单条物理线路完整拆解为覆盖 100% 区间与 100% 车站的有序子走廊列表：
 * - 单连通直线 -> [trunk]
 * - 单连通纯环线 -> [loop (首尾闭合)]
 * - 6字线（单端点引线 + 环） -> 一笔走完引线绕环闭合或 [trunk + loop-branch]，覆盖全部边
 * - Y型/多支线树 -> [主线 trunk, 支线1 (自枢纽分出), 支线2 ...]
 * - 同一条线路下画了两段或多段互不相连的独立区间 -> [独立区段 1, 独立区段 2 ...]（每段内部同样支持主支线与环线！）
 * - 已归属该线但尚未连线的孤立车站 -> [未连线站点]
 */
export function decomposeLineIntoSubCorridors(graph: MapGraph, lineId: string): LineSubCorridor[] {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return [];

  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const lineSections = graph.sections.filter(
    (s) => s.lineId === lineId && stationMap.has(s.startStationId) && stationMap.has(s.endStationId) && s.startStationId !== s.endStationId
  );

  const rankMap = new Map<string, number>();
  line.stationIds.forEach((id, idx) => {
    if (!rankMap.has(id)) rankMap.set(id, idx);
  });
  const rankOf = (id: string) => rankMap.get(id) ?? Number.MAX_SAFE_INTEGER;

  const sectionByPair = new Map<string, Section>();
  const adj = new Map<string, Array<{ to: string; section: Section }>>();
  const addAdj = (u: string, v: string, section: Section) => {
    const list = adj.get(u) || [];
    if (!list.some((e) => e.to === v)) list.push({ to: v, section });
    adj.set(u, list);
  };

  lineSections.forEach((sec) => {
    const pk = normalizePair(sec.startStationId, sec.endStationId);
    if (!sectionByPair.has(pk)) {
      sectionByPair.set(pk, sec);
      addAdj(sec.startStationId, sec.endStationId, sec);
      addAdj(sec.endStationId, sec.startStationId, sec);
    }
  });

  adj.forEach((edges) => {
    edges.sort((a, b) => rankOf(a.to) - rankOf(b.to));
  });

  // 收集本线所有关联车站（含连线车站 + 孤立未连线车站）
  const allStationIds: string[] = [];
  const seenStation = new Set<string>();
  line.stationIds.forEach((id) => {
    if (stationMap.has(id) && !seenStation.has(id)) {
      seenStation.add(id);
      allStationIds.push(id);
    }
  });
  adj.forEach((_, id) => {
    if (stationMap.has(id) && !seenStation.has(id)) {
      seenStation.add(id);
      allStationIds.push(id);
    }
  });

  if (allStationIds.length === 0) return [];

  // 划分连通分量
  const visitedComp = new Set<string>();
  const connectedComponents: string[][] = [];
  const isolatedStationIds: string[] = [];

  allStationIds.forEach((seed) => {
    if (visitedComp.has(seed)) return;
    const neighbors = adj.get(seed);
    if (!neighbors || neighbors.length === 0) {
      visitedComp.add(seed);
      isolatedStationIds.push(seed);
      return;
    }
    const comp: string[] = [];
    const queue = [seed];
    visitedComp.add(seed);
    while (queue.length > 0) {
      const u = queue.shift()!;
      comp.push(u);
      (adj.get(u) || []).forEach(({ to }) => {
        if (!visitedComp.has(to)) {
          visitedComp.add(to);
          queue.push(to);
        }
      });
    }
    comp.sort((a, b) => rankOf(a) - rankOf(b));
    connectedComponents.push(comp);
  });

  const multiComp = connectedComponents.length > 1;
  const subCorridors: LineSubCorridor[] = [];

  connectedComponents.forEach((compNodes, compIdx) => {
    const compSet = new Set(compNodes);
    const compEdges: Section[] = [];
    sectionByPair.forEach((sec) => {
      if (compSet.has(sec.startStationId) && compSet.has(sec.endStationId)) {
        compEdges.push(sec);
      }
    });

    const compPrefix = multiComp ? `区段${compIdx + 1}` : '';
    const degOneNodes = compNodes.filter((id) => (adj.get(id)?.length || 0) === 1);
    const maxDeg = Math.max(...compNodes.map((id) => adj.get(id)?.length || 0));

    // Case A: 纯闭合环线（所有顶点度数 === 2，无端点，边数 === 顶点数 >= 3）
    if (degOneNodes.length === 0 && maxDeg === 2 && compNodes.length >= 3 && compEdges.length === compNodes.length) {
      const startNode = compNodes[0];
      const chain: string[] = [startNode];
      const visited = new Set<string>([startNode]);
      let curr = startNode;
      while (true) {
        const nextEdge = (adj.get(curr) || []).find((e) => !visited.has(e.to));
        if (!nextEdge) break;
        visited.add(nextEdge.to);
        chain.push(nextEdge.to);
        curr = nextEdge.to;
      }
      chain.push(startNode);
      subCorridors.push({
        id: `${lineId}_comp_${compIdx}_loop`,
        kind: 'loop',
        label: compPrefix ? `${compPrefix}·环线` : '环线全程',
        stationIds: chain,
        steps: stationChainToSteps(lineId, chain, sectionByPair, stationMap),
        isClosedLoop: true
      });
      return;
    }

    const uncoveredPairs = new Set<string>(
      compEdges.map((sec) => normalizePair(sec.startStationId, sec.endStationId))
    );
    const coveredNodes = new Set<string>();

    // 提取主干（Trunk）
    let trunkChain: string[] = [];

    if (degOneNodes.length >= 2) {
      // 在所有度为 1 的终端站之间找最长简单路径（同长时取原站点顺序最靠前的起终点）
      const bfsLongestFrom = (source: string): string[] => {
        let best: string[] = [source];
        const dfsPath = (u: string, visited: Set<string>, path: string[]) => {
          if (path.length > best.length) {
            best = [...path];
          }
          const edges = adj.get(u) || [];
          for (let i = 0; i < edges.length; i += 1) {
            const nxt = edges[i].to;
            if (!visited.has(nxt)) {
              visited.add(nxt);
              path.push(nxt);
              dfsPath(nxt, visited, path);
              path.pop();
              visited.delete(nxt);
            }
          }
        };
        dfsPath(source, new Set([source]), [source]);
        return best;
      };

      for (let i = 0; i < degOneNodes.length; i += 1) {
        const cand = bfsLongestFrom(degOneNodes[i]);
        if (cand.length > trunkChain.length) {
          trunkChain = cand;
        }
      }
      if (
        trunkChain.length >= 2 &&
        rankOf(trunkChain[0]) > rankOf(trunkChain[trunkChain.length - 1])
      ) {
        trunkChain.reverse();
      }
    } else if (degOneNodes.length === 1) {
      // 6 字线（单引线接环）：从唯一终端出发一路走到底，并在环交汇点闭合该环！
      const start = degOneNodes[0];
      const chain: string[] = [start];
      const usedPairs = new Set<string>();
      let curr = start;
      while (true) {
        const candidates = (adj.get(curr) || []).filter(
          (e) => !usedPairs.has(normalizePair(curr, e.to))
        );
        if (candidates.length === 0) break;
        // 优先走尚未访问过的节点；若都访问过则闭合回环节点
        const unvisitedNext = candidates.find((e) => !chain.includes(e.to)) || candidates[0];
        usedPairs.add(normalizePair(curr, unvisitedNext.to));
        chain.push(unvisitedNext.to);
        curr = unvisitedNext.to;
        if (chain.slice(0, -1).includes(curr) && (adj.get(curr)?.every((e) => usedPairs.has(normalizePair(curr, e.to))) ?? true)) {
          break;
        }
      }
      trunkChain = chain;
    } else {
      // 无度为 1 终端但存在度 >= 3 的复环（如 8 字环 / 带弦环）：先取经过首站的最长简单环作为主环
      const start = compNodes[0];
      let bestCycle: string[] = [];
      const dfsCycle = (u: string, visited: Set<string>, path: string[]) => {
        const edges = adj.get(u) || [];
        for (let i = 0; i < edges.length; i += 1) {
          const nxt = edges[i].to;
          if (nxt === start && path.length >= 3) {
            if (path.length + 1 > bestCycle.length) {
              bestCycle = [...path, start];
            }
            continue;
          }
          if (!visited.has(nxt)) {
            visited.add(nxt);
            path.push(nxt);
            dfsCycle(nxt, visited, path);
            path.pop();
            visited.delete(nxt);
          }
        }
      };
      dfsCycle(start, new Set([start]), [start]);
      trunkChain = bestCycle.length >= 3 ? bestCycle : compNodes.slice(0, 2);
    }

    for (let i = 0; i < trunkChain.length - 1; i += 1) {
      uncoveredPairs.delete(normalizePair(trunkChain[i], trunkChain[i + 1]));
    }
    trunkChain.forEach((id) => coveredNodes.add(id));

    const hasRemainingBranches = uncoveredPairs.size > 0;
    const isTrunkLoop = trunkChain.length >= 4 && trunkChain[0] === trunkChain[trunkChain.length - 1];

    subCorridors.push({
      id: `${lineId}_comp_${compIdx}_trunk`,
      kind: multiComp && !hasRemainingBranches ? 'segment' : isTrunkLoop ? 'loop' : 'trunk',
      label: hasRemainingBranches
        ? `${compPrefix ? `${compPrefix}·` : ''}主线`
        : multiComp
          ? `独立区段 ${compIdx + 1}`
          : isTrunkLoop
            ? '主环线'
            : '全程主线',
      stationIds: trunkChain,
      steps: stationChainToSteps(lineId, trunkChain, sectionByPair, stationMap),
      ...(isTrunkLoop ? { isClosedLoop: true } : {})
    });

    // 迭代提取所有剩余支线或联络弦，确保本连通分量的每一条边、每一个站 100% 被纳入走廊
    let branchIdx = 1;
    while (uncoveredPairs.size > 0) {
      // 寻找挂载在已覆盖节点上的未覆盖边起点（按原站点顺序优先）
      const anchorCandidates = Array.from(coveredNodes).filter((u) =>
        (adj.get(u) || []).some((e) => uncoveredPairs.has(normalizePair(u, e.to)))
      );
      anchorCandidates.sort((a, b) => rankOf(a) - rankOf(b));
      const branchRoot = anchorCandidates[0] || compNodes[0];

      // 在剩余未覆盖边中从 branchRoot 走出最长简单分支链
      let bestBranch: string[] = [];
      const dfsBranch = (u: string, usedLocalPairs: Set<string>, path: string[]) => {
        if (path.length > bestBranch.length) {
          bestBranch = [...path];
        }
        const edges = (adj.get(u) || []).filter((e) => {
          const pk = normalizePair(u, e.to);
          return uncoveredPairs.has(pk) && !usedLocalPairs.has(pk);
        });
        for (let i = 0; i < edges.length; i += 1) {
          const nxt = edges[i].to;
          const pk = normalizePair(u, nxt);
          // 若到达另一个已覆盖主干节点（弦），记录闭合步后停止继续深入主干
          if (coveredNodes.has(nxt) && path.length >= 1) {
            const candidate = [...path, nxt];
            if (candidate.length > bestBranch.length) {
              bestBranch = candidate;
            }
            continue;
          }
          if (path.includes(nxt)) {
            const loopCand = [...path, nxt];
            if (loopCand.length > bestBranch.length) {
              bestBranch = loopCand;
            }
            continue;
          }
          usedLocalPairs.add(pk);
          path.push(nxt);
          dfsBranch(nxt, usedLocalPairs, path);
          path.pop();
          usedLocalPairs.delete(pk);
        }
      };

      dfsBranch(branchRoot, new Set(), [branchRoot]);
      if (bestBranch.length < 2) break;

      for (let i = 0; i < bestBranch.length - 1; i += 1) {
        uncoveredPairs.delete(normalizePair(bestBranch[i], bestBranch[i + 1]));
      }
      bestBranch.forEach((id) => coveredNodes.add(id));

      const rootName = stationMap.get(branchRoot)?.name || '分岔站';
      subCorridors.push({
        id: `${lineId}_comp_${compIdx}_branch_${branchIdx}`,
        kind: 'branch',
        label: `${compPrefix ? `${compPrefix}·` : ''}支线${branchIdx > 1 ? branchIdx : ''}（自${rootName}）`,
        stationIds: bestBranch,
        steps: stationChainToSteps(lineId, bestBranch, sectionByPair, stationMap),
        branchFromStationId: branchRoot
      });
      branchIdx += 1;
    }
  });

  // 纳入归属本线但尚未连线的孤立站点，确保不漏任何一站
  if (isolatedStationIds.length > 0) {
    subCorridors.push({
      id: `${lineId}_isolated`,
      kind: 'isolated',
      label: '待连线站点',
      stationIds: isolatedStationIds,
      steps: []
    });
  }

  return subCorridors;
}

/**
 * 枚举某条物理线路上所有可开行的端到端完整运行路径变体（主线、主支贯通线、独立支线、各独立不连通区段、闭合环线）。
 */
export function listLineRouteVariants(graph: MapGraph, lineId: string): LineRouteVariant[] {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return [];
  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const subCorridors = decomposeLineIntoSubCorridors(graph, lineId).filter(
    (sc) => sc.steps.length > 0
  );
  if (subCorridors.length === 0) return [];

  const variants: LineRouteVariant[] = [];
  const seenKeys = new Set<string>();

  const pushVariant = (key: string, label: string, isLoop: boolean, stationIds: string[], steps: ProRouteStep[]) => {
    if (steps.length === 0 || seenKeys.has(key)) return;
    seenKeys.add(key);
    variants.push({ key, label, isLoop, stationIds, steps });
  };

  subCorridors.forEach((sc) => {
    const firstName = stationMap.get(sc.stationIds[0])?.name || sc.stationIds[0];
    const lastName = stationMap.get(sc.stationIds[sc.stationIds.length - 1])?.name || sc.stationIds[sc.stationIds.length - 1];

    if (sc.kind === 'loop' || sc.isClosedLoop) {
      pushVariant(
        sc.id,
        `${sc.label}（${firstName} ↻ ${lastName}）`,
        true,
        sc.stationIds,
        sc.steps
      );
      return;
    }

    if (sc.kind === 'trunk' || sc.kind === 'segment') {
      pushVariant(
        sc.id,
        `${sc.label}（${firstName} → ${lastName}）`,
        false,
        sc.stationIds,
        sc.steps
      );
      return;
    }

    if (sc.kind === 'branch' && sc.branchFromStationId) {
      // 1) 主干始发站贯通入支线（现实最常见的 Y 型主支贯通交路，如西园 -> 科技园 -> 航站楼！）
      const branchTipId = sc.stationIds[sc.stationIds.length - 1];
      const parentTrunk = subCorridors.find(
        (p) => (p.kind === 'trunk' || p.kind === 'segment') && p.stationIds.includes(sc.branchFromStationId!)
      );
      if (parentTrunk && parentTrunk.stationIds[0] !== sc.branchFromStationId) {
        const throughSteps = buildOrderedLineSteps(graph, lineId, {
          startStationId: parentTrunk.stationIds[0],
          endStationId: branchTipId
        });
        if (throughSteps.length > sc.steps.length) {
          const trunkOriginName = stationMap.get(parentTrunk.stationIds[0])?.name || '';
          pushVariant(
            `${sc.id}_through_origin`,
            `主支贯通（${trunkOriginName} → ${lastName}）`,
            false,
            [throughSteps[0].fromStationId, ...throughSteps.map((s) => s.toStationId)],
            throughSteps
          );
        }
      }

      // 2) 纯支线独立区间交路（如 科技园 -> 航站楼）
      pushVariant(
        sc.id,
        `${sc.label}独立交路（${firstName} → ${lastName}）`,
        false,
        sc.stationIds,
        sc.steps
      );
    }
  });

  return variants;
}

/**
 * 提取某条线路在两点之间（或默认首条主走廊）的有序物理区间步序列。
 */
export function buildOrderedLineSteps(
  graph: MapGraph,
  lineId: string,
  options?: {
    startStationId?: string;
    endStationId?: string;
    variantKey?: string;
    stopPredicate?: (stationId: string, isTerminal: boolean) => boolean;
  }
): ProRouteStep[] {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return [];
  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const lineSections = graph.sections.filter((s) => s.lineId === lineId);
  if (lineSections.length === 0) return [];

  if (options?.variantKey) {
    const matchedVariant = listLineRouteVariants(graph, lineId).find((v) => v.key === options.variantKey);
    if (matchedVariant) {
      return matchedVariant.steps.map((step, idx, arr) => {
        const isTerminal = idx === arr.length - 1;
        return {
          ...step,
          stopAtEnd: options.stopPredicate ? options.stopPredicate(step.toStationId, isTerminal) : true
        };
      });
    }
  }

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
    if (options.startStationId === options.endStationId) {
      // 同站起终（环线或主环绕一圈）：BFS/DFS 寻找从该站出发回到该站的简单环
      let foundCycle: string[] = [];
      const dfsLoop = (u: string, visited: Set<string>, path: string[]) => {
        if (foundCycle.length > 0) return;
        const neighbors = adj.get(u) || [];
        for (let i = 0; i < neighbors.length; i += 1) {
          const nxt = neighbors[i];
          if (nxt === options.startStationId && path.length >= 3) {
            foundCycle = [...path, nxt];
            return;
          }
          if (!visited.has(nxt)) {
            visited.add(nxt);
            path.push(nxt);
            dfsLoop(nxt, visited, path);
            path.pop();
            visited.delete(nxt);
          }
        }
      };
      dfsLoop(options.startStationId, new Set([options.startStationId]), [options.startStationId]);
      stationChain = foundCycle;
    } else {
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
    const subCorridors = decomposeLineIntoSubCorridors(graph, lineId);
    const primary = subCorridors.find((sc) => sc.steps.length > 0);
    if (primary) {
      stationChain = primary.stationIds;
    } else if (topo.isLoop && topo.stationIds.length >= 3) {
      stationChain = [...topo.stationIds, topo.stationIds[0]];
    } else {
      stationChain = topo.stationIds;
    }
  }

  return stationChainToSteps(lineId, stationChain, sectionByPair, stationMap, options?.stopPredicate);
}

/**
 * 为指定物理线路（或指定主支线/区段变体）生成「普通车」交路。
 */
export function createLineAllStopPattern(
  graph: MapGraph,
  lineId: string,
  variantKey?: string
): ProServicePattern | null {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return null;
  const variants = listLineRouteVariants(graph, lineId);
  const chosen = variantKey ? variants.find((v) => v.key === variantKey) : variants[0];
  const routeSteps = buildOrderedLineSteps(graph, lineId, { variantKey: chosen?.key });
  if (routeSteps.length === 0) return null;

  const suffix =
    variants.length > 1 && chosen
      ? ` ${chosen.label.split('（')[0]}`
      : chosen?.isLoop
        ? ' 双向环行普通车'
        : ' 全程普通车';

  return {
    id: createId(),
    name: `${line.name}${suffix}`,
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
 * 一键为某条线路的所有不连通分段及主支贯通变体生成完整普通车集合（确保多区段/主支线不漏任何站点）。
 */
export function createAllSubCorridorPatternsForLine(graph: MapGraph, lineId: string): ProServicePattern[] {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return [];
  const variants = listLineRouteVariants(graph, lineId);
  if (variants.length <= 1) {
    const single = createLineAllStopPattern(graph, lineId);
    return single ? [single] : [];
  }
  // 选取主线/环线/独立区段 + 主支贯通（过滤掉已被主支贯通完全包含的冗余纯支线短交路）
  const selectedVariants = variants.filter((v, _, arr) => {
    if (!v.key.includes('_branch_') || v.key.endsWith('_through_origin')) return true;
    const hasThrough = arr.some((other) => other.key === `${v.key}_through_origin`);
    return !hasThrough;
  });

  return selectedVariants
    .map((v) => createLineAllStopPattern(graph, lineId, v.key))
    .filter((p): p is ProServicePattern => p !== null);
}

/**
 * 为指定物理线路（或指定主支线/区段变体）生成「大站快车」交路。
 */
export function createLineExpressPattern(
  graph: MapGraph,
  lineId: string,
  variantKey?: string
): ProServicePattern | null {
  const line = graph.lines.find((l) => l.id === lineId);
  if (!line) return null;

  const stationLineCounts = new Map<string, number>();
  graph.lines.forEach((l) => {
    new Set(l.stationIds).forEach((sid) => {
      stationLineCounts.set(sid, (stationLineCounts.get(sid) || 0) + 1);
    });
  });

  // 同时识别本线内部支线分岔枢纽（度数 >= 3），快车默认停靠分岔站与换乘站
  const lineAdjCount = new Map<string, number>();
  graph.sections
    .filter((s) => s.lineId === lineId)
    .forEach((s) => {
      lineAdjCount.set(s.startStationId, (lineAdjCount.get(s.startStationId) || 0) + 1);
      lineAdjCount.set(s.endStationId, (lineAdjCount.get(s.endStationId) || 0) + 1);
    });

  const variants = listLineRouteVariants(graph, lineId);
  const chosen = variantKey ? variants.find((v) => v.key === variantKey) : variants[0];
  const baseSteps = buildOrderedLineSteps(graph, lineId, { variantKey: chosen?.key });
  if (baseSteps.length === 0) return null;

  const isKeyStop = (sid: string) =>
    (stationLineCounts.get(sid) || 1) >= 2 || (lineAdjCount.get(sid) || 0) >= 3;

  const hasKeyMid = baseSteps.slice(0, -1).some((s) => isKeyStop(s.toStationId));

  const expressSteps: ProRouteStep[] = baseSteps.map((step, idx) => {
    const isLast = idx === baseSteps.length - 1;
    if (isLast) return { ...step, stopAtEnd: true };
    const stopAtEnd = hasKeyMid ? isKeyStop(step.toStationId) : (idx + 1) % 3 === 0;
    return { ...step, stopAtEnd };
  });

  const prefix =
    variants.length > 1 && chosen ? `${line.name} ${chosen.label.split('（')[0]}快车` : `${line.name} 大站快车`;

  return {
    id: createId(),
    name: prefix,
    code: '快车',
    color: '#ea580c',
    category: 'express',
    stopAtStart: true,
    routeSteps: expressSteps,
    headwaySec: 360,
    firstDepartureOffsetSec: 120,
    bidirectional: true
  };
}

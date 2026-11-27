import { Line } from '../types';
import { MapGraph } from '../lib/graphOps';
import { measureSectionDistance } from './distance';
import { ServiceKinematicsResult } from './kinematics';
import { decomposeLineIntoSubCorridors } from './reconcile';
import {
  makeCanonicalLinePairKey,
  ProOpsDocument,
  ProServicePattern,
  ProServiceValidation
} from './types';

export interface CorridorColumn {
  colIndex: number;
  stationId: string;
  stationName: string;
  lineId: string;
  lineName: string;
  lineColor: string;
  cumulativeKm: number;
  /** 是否与左侧前一列在物理轨道上直接相连（false 表示此处是新支线起点、第二段独立不连通区间起点或孤立站） */
  connectToPrev: boolean;
  /** 连接 colIndex-1 与 colIndex 的基准物理区间 ID（用于严格区分独立双隧并行 vs 共线共轨） */
  prevSectionId?: string;
  /** 子走廊分段标签（如 "主线" / "支线（自科技园）" / "独立区段 2" / "环线全程"） */
  subCorridorId: string;
  subCorridorLabel?: string;
  isLoopClosure?: boolean;
  transferLines: Array<{ id: string; name: string; color: string }>;
  hasTurnback: boolean;
  hasPassingTrack: boolean;
  junctionNote?: string;
}

export interface CorridorRowCell {
  colIndex: number;
  kind: 'none' | 'origin' | 'terminus' | 'stop' | 'pass';
  arrivalMin?: number;
  passSpeedKmh?: number;
}

export interface CorridorBandSpan {
  startCol: number;
  endCol: number;
}

export interface CorridorServiceRow {
  pattern: ProServicePattern;
  validation: ProServiceValidation;
  kinematics: ServiceKinematicsResult;
  savedMinutesVsLocal?: number;
  /** 支持主支线跨越、环线错位始发等多段连续色带（彻底告别单一 startCol..endCol 假连线！） */
  spans: CorridorBandSpan[];
  startCol: number;
  endCol: number;
  throughEntryLabel?: string;
  throughExitLabel?: string;
  cells: CorridorRowCell[];
}

export interface CorridorDiagramModel {
  title: string;
  subtitle: string;
  mode: 'line' | 'pattern';
  columns: CorridorColumn[];
  rows: CorridorServiceRow[];
}

function collectTransferLinesForStation(
  graph: MapGraph,
  stationId: string,
  excludeLineId: string
): Array<{ id: string; name: string; color: string }> {
  const res: Array<{ id: string; name: string; color: string }> = [];
  graph.lines.forEach((line) => {
    if (line.id === excludeLineId) return;
    if (line.stationIds.includes(stationId)) {
      res.push({ id: line.id, name: line.name, color: line.color });
    }
  });
  return res;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);

/**
 * 构建一维拉直版运行体系导乘图模型：
 * - mode = 'line': 完整展开该线路的所有主线、Y型支线、闭合环线、多个独立不连通分段及孤立站点（100% 不漏站）；
 * - mode = 'pattern': 跟随选中交路全程访问序列一维拉直展开。
 */
export function buildCorridorDiagramModel(params: {
  graph: MapGraph;
  proOps: ProOpsDocument;
  validations: Readonly<Record<string, ProServiceValidation>>;
  kinematicsMap: Readonly<Record<string, ServiceKinematicsResult>>;
  isGeoMode: boolean;
  axisMode: 'line' | 'pattern';
  targetLineId?: string | null;
  targetPatternId?: string | null;
}): CorridorDiagramModel {
  const {
    graph,
    proOps,
    validations,
    kinematicsMap,
    isGeoMode,
    axisMode,
    targetLineId,
    targetPatternId
  } = params;

  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const lineMap = new Map<string, Line>(graph.lines.map((l) => [l.id, l]));
  const sectionMap = new Map(graph.sections.map((s) => [s.id, s]));

  const columns: CorridorColumn[] = [];

  const focusPattern = targetPatternId
    ? proOps.servicePatterns.find((p) => p.id === targetPatternId)
    : undefined;
  const focusKin = focusPattern ? kinematicsMap[focusPattern.id] : undefined;

  const sharedPairSet = new Set(proOps.sharedTrackLinePairs || []);
  const isTrackSharedBetweenLines = (lineAId: string, lineBId: string): boolean => {
    if (!lineAId || !lineBId) return false;
    if (lineAId === lineBId) return true;
    return sharedPairSet.has(makeCanonicalLinePairKey(lineAId, lineBId));
  };

  if (axisMode === 'pattern' && focusPattern && focusKin && focusKin.status === 'valid' && focusKin.visits.length >= 2) {
    const visitStepSecMap = new Map<number, string>();
    focusKin.segments.forEach((seg) => {
      const stp = focusPattern.routeSteps[seg.stepIndex];
      if (stp && stp.kind === 'section' && seg.toVisitIndex > seg.fromVisitIndex) {
        visitStepSecMap.set(seg.toVisitIndex, stp.sectionId);
      }
    });
    focusKin.visits.forEach((v, idx) => {
      const displayLineId = v.switchedToLineId || v.lineId;
      const displayLine = lineMap.get(displayLineId);
      columns.push({
        colIndex: idx,
        stationId: v.stationId,
        stationName: v.stationName,
        lineId: displayLineId,
        lineName: displayLine?.name || v.lineName,
        lineColor: displayLine?.color || v.lineColor,
        cumulativeKm: Math.round((v.cumulativeMeters / 1000) * 100) / 100,
        connectToPrev: idx > 0,
        ...(idx > 0 && visitStepSecMap.has(idx) ? { prevSectionId: visitStepSecMap.get(idx) } : {}),
        subCorridorId: 'pattern_full',
        ...(idx === 0 ? { subCorridorLabel: '全程走廊' } : {}),
        transferLines: collectTransferLinesForStation(graph, v.stationId, displayLineId),
        hasTurnback: v.hasTurnback,
        hasPassingTrack: v.hasPassingTrack,
        ...(v.switchedToLineName ? { junctionNote: `⇄ 转入${v.switchedToLineName}` } : {})
      });
    });
  } else {
    const line =
      (targetLineId ? lineMap.get(targetLineId) : undefined) ||
      (focusPattern?.routeSteps[0]?.kind === 'section'
        ? lineMap.get(focusPattern.routeSteps[0].lineId)
        : undefined) ||
      graph.lines[0];

    if (!line) {
      return {
        title: '暂无可用线路走廊',
        subtitle: '请先在线网绘制模式创建线路与站点',
        mode: 'line',
        columns: [],
        rows: []
      };
    }

    const subCorridors = decomposeLineIntoSubCorridors(graph, line.id);
    // 记录已算出的站点基准里程，方便支线直接继承分岔枢纽站的累计里程！
    const stationKnownMeters = new Map<string, number>();
    const multiSub = subCorridors.length > 1;

    subCorridors.forEach((sc) => {
      if (sc.kind === 'isolated') {
        sc.stationIds.forEach((sid, idx) => {
          const st = stationMap.get(sid);
          const prof = proOps.stationProfiles[sid];
          columns.push({
            colIndex: columns.length,
            stationId: sid,
            stationName: st?.name || sid,
            lineId: line.id,
            lineName: line.name,
            lineColor: line.color,
            cumulativeKm: 0,
            connectToPrev: false,
            subCorridorId: sc.id,
            ...(idx === 0 ? { subCorridorLabel: sc.label } : {}),
            transferLines: collectTransferLinesForStation(graph, sid, line.id),
            hasTurnback: Boolean(prof?.hasTurnback),
            hasPassingTrack: Boolean(prof?.hasPassingTrack)
          });
        });
        return;
      }

      if (sc.stationIds.length === 0) return;
      const firstId = sc.stationIds[0];
      const firstSt = stationMap.get(firstId);
      const firstProf = proOps.stationProfiles[firstId];
      let cumMeters =
        sc.kind === 'branch' && stationKnownMeters.has(firstId)
          ? stationKnownMeters.get(firstId)!
          : 0;
      if (!stationKnownMeters.has(firstId)) {
        stationKnownMeters.set(firstId, cumMeters);
      }

      columns.push({
        colIndex: columns.length,
        stationId: firstId,
        stationName: firstSt?.name || firstId,
        lineId: line.id,
        lineName: line.name,
        lineColor: line.color,
        cumulativeKm: Math.round((cumMeters / 1000) * 100) / 100,
        connectToPrev: false,
        subCorridorId: sc.id,
        ...(multiSub || sc.isClosedLoop ? { subCorridorLabel: sc.label } : {}),
        transferLines: collectTransferLinesForStation(graph, firstId, line.id),
        hasTurnback: Boolean(firstProf?.hasTurnback),
        hasPassingTrack: Boolean(firstProf?.hasPassingTrack)
      });

      sc.steps.forEach((step, stepIdx) => {
        if (step.kind !== 'section') return;
        const sec = sectionMap.get(step.sectionId);
        if (sec) {
          cumMeters += measureSectionDistance(
            sec,
            stationMap,
            proOps.scaleConfig,
            proOps.sectionOverrides,
            isGeoMode
          ).meters;
        }
        const st = stationMap.get(step.toStationId);
        const prof = proOps.stationProfiles[step.toStationId];
        if (!stationKnownMeters.has(step.toStationId)) {
          stationKnownMeters.set(step.toStationId, cumMeters);
        }
        const isClosureCol = Boolean(sc.isClosedLoop && stepIdx === sc.steps.length - 1);
        columns.push({
          colIndex: columns.length,
          stationId: step.toStationId,
          stationName: isClosureCol ? `${st?.name || step.toStationId} ↻` : st?.name || step.toStationId,
          lineId: line.id,
          lineName: line.name,
          lineColor: line.color,
          cumulativeKm: Math.round((cumMeters / 1000) * 100) / 100,
          connectToPrev: true,
          prevSectionId: step.sectionId,
          subCorridorId: sc.id,
          ...(isClosureCol ? { isLoopClosure: true } : {}),
          transferLines: collectTransferLinesForStation(graph, step.toStationId, line.id),
          hasTurnback: Boolean(prof?.hasTurnback),
          hasPassingTrack: Boolean(prof?.hasPassingTrack)
        });
      });
    });
  }

  if (columns.length === 0) {
    return {
      title: '暂无站点序列',
      subtitle: '请先添加车站与区间',
      mode: axisMode,
      columns: [],
      rows: []
    };
  }

  // 构建相邻物理连接列对索引：pairKey(u, v) -> Array<{ leftCol, rightCol, sectionId, lineId }>
  const adjacentColPairs = new Map<
    string,
    Array<{ leftCol: number; rightCol: number; sectionId?: string; lineId: string }>
  >();
  for (let c = 1; c < columns.length; c += 1) {
    if (!columns[c].connectToPrev) continue;
    const pk = pairKey(columns[c - 1].stationId, columns[c].stationId);
    const list = adjacentColPairs.get(pk) || [];
    list.push({
      leftCol: c - 1,
      rightCol: c,
      sectionId: columns[c].prevSectionId,
      lineId: columns[c].lineId
    });
    adjacentColPairs.set(pk, list);
  }

  // 将交路的物理运行边精确投影到走廊的所有子区段（严格按物理区间 sectionId 或显式共线共轨匹配，彻底隔离独立双隧并行线！）
  const projectPatternOntoColumns = (
    pattern: ProServicePattern,
    kin: ServiceKinematicsResult
  ): {
    spans: CorridorBandSpan[];
    colVisitMap: Map<number, { visitIdx: number; isStop: boolean; arrivalSec: number; passSpeedKmh: number }>;
    firstMatchedVisitIdx: number;
    lastMatchedVisitIdx: number;
  } | null => {
    if (kin.status !== 'valid' || kin.visits.length < 2) return null;

    if (
      axisMode === 'pattern' &&
      focusPattern &&
      kin.patternId === focusPattern.id &&
      kin.visits.length === columns.length
    ) {
      const direct = new Map<number, { visitIdx: number; isStop: boolean; arrivalSec: number; passSpeedKmh: number }>();
      kin.visits.forEach((v, idx) => {
        direct.set(idx, {
          visitIdx: idx,
          isStop: v.isStop,
          arrivalSec: v.arrivalSec,
          passSpeedKmh: v.passSpeedKmh
        });
      });
      return {
        spans: [{ startCol: 0, endCol: columns.length - 1 }],
        colVisitMap: direct,
        firstMatchedVisitIdx: 0,
        lastMatchedVisitIdx: kin.visits.length - 1
      };
    }

    const activeUnitEdges = new Set<number>(); // leftCol index (represents edge leftCol <-> leftCol + 1)
    const colVisitMap = new Map<
      number,
      { visitIdx: number; isStop: boolean; arrivalSec: number; passSpeedKmh: number }
    >();
    let firstMatchedVisitIdx = Number.MAX_SAFE_INTEGER;
    let lastMatchedVisitIdx = -1;

    const recordColVisit = (colIdx: number, visitIdx: number) => {
      const v = kin.visits[visitIdx];
      if (!v) return;
      const existing = colVisitMap.get(colIdx);
      if (
        !existing ||
        visitIdx === 0 ||
        visitIdx === kin.visits.length - 1 ||
        (v.isStop && !existing.isStop)
      ) {
        colVisitMap.set(colIdx, {
          visitIdx,
          isStop: v.isStop,
          arrivalSec: v.arrivalSec,
          passSpeedKmh: v.passSpeedKmh
        });
      }
      if (visitIdx < firstMatchedVisitIdx) firstMatchedVisitIdx = visitIdx;
      if (visitIdx > lastMatchedVisitIdx) lastMatchedVisitIdx = visitIdx;
    };

    for (let segIdx = 0; segIdx < kin.segments.length; segIdx += 1) {
      const seg = kin.segments[segIdx];
      const step = pattern.routeSteps[seg.stepIndex];
      if (!step || step.kind !== 'section') continue;
      if (seg.fromVisitIndex === seg.toVisitIndex) continue;

      const u = kin.visits[seg.fromVisitIndex]?.stationId;
      const w = kin.visits[seg.toVisitIndex]?.stationId;
      if (!u || !w || u === w) continue;

      const rawMatches = adjacentColPairs.get(pairKey(u, w));
      if (!rawMatches || rawMatches.length === 0) continue;

      // 关键过滤：仅当同一物理区间（如本线列车或经跨线道岔驶入本线的跨线车），或两线被显式标记为「共线共轨」时才投影！
      const matches = rawMatches.filter(
        (m) =>
          (m.sectionId && m.sectionId === step.sectionId) ||
          isTrackSharedBetweenLines(m.lineId, step.lineId)
      );
      if (matches.length === 0) continue;

      const chosen =
        matches.find(
          (m) =>
            (columns[m.leftCol].stationId === u && colVisitMap.has(m.leftCol)) ||
            (columns[m.rightCol].stationId === u && colVisitMap.has(m.rightCol))
        ) || matches[0];

      activeUnitEdges.add(chosen.leftCol);
      if (columns[chosen.leftCol].stationId === u) {
        recordColVisit(chosen.leftCol, seg.fromVisitIndex);
        recordColVisit(chosen.rightCol, seg.toVisitIndex);
      } else {
        recordColVisit(chosen.rightCol, seg.fromVisitIndex);
        recordColVisit(chosen.leftCol, seg.toVisitIndex);
      }
    }

    if (activeUnitEdges.size === 0) return null;

    // 合并相邻已激活的物理单元边为连续色带区间 spans
    const sortedEdges = Array.from(activeUnitEdges).sort((a, b) => a - b);
    const spans: CorridorBandSpan[] = [];
    sortedEdges.forEach((leftCol) => {
      const prevSpan = spans[spans.length - 1];
      if (prevSpan && prevSpan.endCol === leftCol && columns[leftCol + 1]?.connectToPrev) {
        prevSpan.endCol = leftCol + 1;
      } else {
        spans.push({ startCol: leftCol, endCol: leftCol + 1 });
      }
    });

    return {
      spans,
      colVisitMap,
      firstMatchedVisitIdx: firstMatchedVisitIdx === Number.MAX_SAFE_INTEGER ? 0 : firstMatchedVisitIdx,
      lastMatchedVisitIdx: Math.max(0, lastMatchedVisitIdx)
    };
  };

  // 按相同起终点对索引基准慢车用时（精准支持主线慢车 vs 主线快车、主支慢车 vs 主支快车对比省时！）
  const localBaselineByOdKey = new Map<string, number>();
  proOps.servicePatterns.forEach((p) => {
    const kin = kinematicsMap[p.id];
    if (kin && kin.status === 'valid' && p.category === 'local' && kin.visits.length >= 2) {
      const odKey = `${kin.visits[0].stationId}->${kin.visits[kin.visits.length - 1].stationId}::${kin.totalDistanceMeters}`;
      const prev = localBaselineByOdKey.get(odKey);
      if (prev === undefined || kin.oneWayTravelSec > prev) {
        localBaselineByOdKey.set(odKey, kin.oneWayTravelSec);
      }
    }
  });

  const rows: CorridorServiceRow[] = [];

  proOps.servicePatterns.forEach((pattern) => {
    const validation = validations[pattern.id] || {
      patternId: pattern.id,
      status: 'broken',
      issues: [],
      healedSplitCount: 0
    };
    const kin = kinematicsMap[pattern.id];
    if (!kin) return;

    if (validation.status === 'broken') {
      const corridorLineIds = new Set(columns.map((c) => c.lineId));
      const touchesCorridor = pattern.routeSteps.some((s) =>
        s.kind === 'section'
          ? Array.from(corridorLineIds).some((cid) => isTrackSharedBetweenLines(cid, s.lineId))
          : corridorLineIds.has(s.fromLineId) || corridorLineIds.has(s.toLineId)
      );
      if (touchesCorridor || pattern.id === targetPatternId) {
        rows.push({
          pattern,
          validation,
          kinematics: kin,
          spans: [],
          startCol: 0,
          endCol: Math.max(0, columns.length - 1),
          cells: columns.map((_, idx) => ({ colIndex: idx, kind: 'none' }))
        });
      }
      return;
    }

    const projected = projectPatternOntoColumns(pattern, kin);
    if (!projected) return;

    const startCol = projected.spans[0].startCol;
    const endCol = projected.spans[projected.spans.length - 1].endCol;

    let throughEntryLabel: string | undefined;
    let throughExitLabel: string | undefined;
    if (projected.firstMatchedVisitIdx > 0) {
      const originVisit = kin.visits[0];
      throughEntryLabel = `贯通自 ${originVisit.lineName}·${originVisit.stationName}`;
    }
    if (projected.lastMatchedVisitIdx < kin.visits.length - 1) {
      const termVisit = kin.visits[kin.visits.length - 1];
      throughExitLabel = `贯通至 ${termVisit.lineName}·${termVisit.stationName}`;
    }

    let savedMinutesVsLocal: number | undefined;
    if (kin.visits.length >= 2) {
      const odKey = `${kin.visits[0].stationId}->${kin.visits[kin.visits.length - 1].stationId}::${kin.totalDistanceMeters}`;
      const baseSec = localBaselineByOdKey.get(odKey);
      if (baseSec !== undefined) {
        const diffMin = (baseSec - kin.oneWayTravelSec) / 60;
        if (diffMin >= 0.3) {
          savedMinutesVsLocal = Math.round(diffMin * 10) / 10;
        }
      }
    }

    const coveredCols = new Set<number>();
    projected.spans.forEach((sp) => {
      for (let c = sp.startCol; c <= sp.endCol; c += 1) coveredCols.add(c);
    });

    const cells: CorridorRowCell[] = columns.map((_, colIdx) => {
      if (!coveredCols.has(colIdx)) {
        return { colIndex: colIdx, kind: 'none' };
      }
      const hit = projected.colVisitMap.get(colIdx);
      if (!hit) {
        return { colIndex: colIdx, kind: 'pass' };
      }
      const isOrigin = hit.visitIdx === 0;
      const isTerminus = hit.visitIdx === kin.visits.length - 1;
      const kind: CorridorRowCell['kind'] = isOrigin
        ? 'origin'
        : isTerminus
          ? 'terminus'
          : hit.isStop
            ? 'stop'
            : 'pass';
      return {
        colIndex: colIdx,
        kind,
        arrivalMin: Math.round((hit.arrivalSec / 60) * 10) / 10,
        passSpeedKmh: hit.passSpeedKmh
      };
    });

    rows.push({
      pattern,
      validation,
      kinematics: kin,
      ...(savedMinutesVsLocal !== undefined ? { savedMinutesVsLocal } : {}),
      spans: projected.spans,
      startCol,
      endCol,
      ...(throughEntryLabel ? { throughEntryLabel } : {}),
      ...(throughExitLabel ? { throughExitLabel } : {}),
      cells
    });
  });

  const uniqueStationCount = new Set(columns.map((c) => c.stationId)).size;
  const subCount = new Set(columns.map((c) => c.subCorridorId)).size;
  const distinctLineNames = Array.from(new Set(columns.map((c) => c.lineName)));
  const title =
    axisMode === 'pattern' && focusPattern
      ? `${focusPattern.name} · 全程运行体系导乘图`
      : `${distinctLineNames.join(' / ')} · 全拓扑运行体系导乘图`;
  const subtitle = `覆盖 ${uniqueStationCount} 座车站${subCount > 1 ? `（含 ${subCount} 个主支/分段走廊）` : ''} · 已编排 ${rows.length} 种交路`;

  return {
    title,
    subtitle,
    mode: axisMode,
    columns,
    rows
  };
}

const escapeXml = (str: string): string =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export function buildServiceDiagramSvg(
  model: CorridorDiagramModel,
  theme: 'light' | 'dark' = 'light'
): string {
  const isDark = theme === 'dark';
  const bg = isDark ? '#0b1220' : '#ffffff';
  const cardBg = isDark ? '#111c30' : '#f8fafc';
  const border = isDark ? '#1e293b' : '#e2e8f0';
  const textMain = isDark ? '#f8fafc' : '#0f172a';
  const textSub = isDark ? '#94a3b8' : '#64748b';
  const gridLine = isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(15, 23, 42, 0.08)';
  const breakLine = isDark ? 'rgba(245, 158, 11, 0.45)' : 'rgba(217, 119, 6, 0.35)';

  const leftHeaderW = 248;
  const colStep = 78;
  const padX = 28;
  const padTop = 82;
  const stationHeaderH = 114;
  const rowH = 58;
  const footerH = 38;

  const colCount = Math.max(1, model.columns.length);
  const rowCount = Math.max(1, model.rows.length);
  const width = padX * 2 + leftHeaderW + colCount * colStep + 36;
  const height = padTop + stationHeaderH + rowCount * rowH + footerH;

  const colCenterX = (colIdx: number) => padX + leftHeaderW + colIdx * colStep + colStep / 2;

  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" rx="16"/>`
  );

  parts.push(
    `<text x="${padX}" y="38" font-size="18" font-weight="800" fill="${textMain}">${escapeXml(model.title)}</text>`,
    `<text x="${padX}" y="60" font-size="12" fill="${textSub}">${escapeXml(model.subtitle)}</text>`
  );

  const legendX = width - padX - 310;
  if (legendX > padX + 260) {
    parts.push(
      `<g transform="translate(${legendX}, 30)">`,
      `<circle cx="8" cy="8" r="6" fill="${bg}" stroke="#2563eb" stroke-width="3.5"/>`,
      `<circle cx="8" cy="8" r="2.2" fill="#2563eb"/>`,
      `<text x="20" y="12" font-size="11.5" fill="${textSub}">始发/终到</text>`,
      `<circle cx="92" cy="8" r="5.5" fill="${bg}" stroke="#2563eb" stroke-width="3"/>`,
      `<text x="103" y="12" font-size="11.5" fill="${textSub}">停靠站</text>`,
      `<line x1="154" y1="8" x2="178" y2="8" stroke="#ea580c" stroke-width="5" stroke-linecap="round"/>`,
      `<text x="184" y="12" font-size="11.5" fill="${textSub}">越站直通（不停车）</text>`,
      `</g>`
    );
  }

  // 按物理连通子走廊（subCorridorId + lineId）分组绘制顶部胶囊横幅，不同支线/独立区段自动断开标明！
  const bannerY = padTop;
  let segStart = 0;
  while (segStart < model.columns.length) {
    let segEnd = segStart;
    const startColObj = model.columns[segStart];
    while (
      segEnd + 1 < model.columns.length &&
      model.columns[segEnd + 1].connectToPrev &&
      model.columns[segEnd + 1].lineId === startColObj.lineId &&
      model.columns[segEnd + 1].subCorridorId === startColObj.subCorridorId
    ) {
      segEnd += 1;
    }
    const x1 = colCenterX(segStart) - colStep * 0.42;
    const x2 = colCenterX(segEnd) + colStep * 0.42;
    const color = startColObj.lineColor;
    const bannerText = startColObj.subCorridorLabel
      ? `${startColObj.lineName} · ${startColObj.subCorridorLabel}`
      : startColObj.lineName;
    parts.push(
      `<rect x="${x1.toFixed(1)}" y="${bannerY}" width="${Math.max(36, x2 - x1).toFixed(1)}" height="22" rx="11" fill="${escapeXml(color)}"/>`,
      `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${bannerY + 15}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#ffffff">${escapeXml(bannerText)}</text>`
    );
    segStart = segEnd + 1;
  }

  const tableTop = padTop + stationHeaderH;
  const tableBottom = tableTop + rowCount * rowH;

  model.columns.forEach((col, idx) => {
    const cx = colCenterX(idx);
    // 在非物理连续的支线/独立分段交界处画醒目的分段竖虚线
    if (idx > 0 && !col.connectToPrev) {
      const sepX = cx - colStep / 2;
      parts.push(
        `<line x1="${sepX}" y1="${padTop}" x2="${sepX}" y2="${tableBottom}" stroke="${breakLine}" stroke-width="1.5" stroke-dasharray="5,4"/>`
      );
    }
    parts.push(
      `<line x1="${cx}" y1="${padTop + 28}" x2="${cx}" y2="${tableBottom}" stroke="${gridLine}" stroke-width="1" stroke-dasharray="3,3"/>`,
      `<text x="${cx}" y="${padTop + 44}" text-anchor="middle" font-size="10" fill="${textSub}">${col.cumulativeKm.toFixed(1)}km</text>`,
      `<text x="${cx}" y="${padTop + 66}" text-anchor="middle" font-size="12.5" font-weight="700" fill="${textMain}">${escapeXml(col.stationName)}</text>`
    );

    col.transferLines.slice(0, 2).forEach((tr, tIdx) => {
      const py = padTop + 76 + tIdx * 16;
      parts.push(
        `<rect x="${cx - 24}" y="${py}" width="48" height="13" rx="6.5" fill="${escapeXml(tr.color)}"/>`,
        `<text x="${cx}" y="${py + 9.8}" text-anchor="middle" font-size="9" font-weight="700" fill="#ffffff">${escapeXml(tr.name.slice(0, 6))}</text>`
      );
    });
  });

  if (model.rows.length === 0) {
    parts.push(
      `<rect x="${padX}" y="${tableTop}" width="${width - padX * 2}" height="${rowH}" rx="10" fill="${cardBg}" stroke="${border}"/>`,
      `<text x="${width / 2}" y="${tableTop + 34}" text-anchor="middle" font-size="13" fill="${textSub}">尚未添加运行交路，请在左侧「运行体系」一键生成普通车或大站快车</text>`
    );
  } else {
    model.rows.forEach((row, rIdx) => {
      const ry = tableTop + rIdx * rowH;
      const midY = ry + rowH / 2;
      const p = row.pattern;
      const kin = row.kinematics;

      parts.push(
        `<rect x="${padX}" y="${ry + 4}" width="${width - padX * 2}" height="${rowH - 8}" rx="10" fill="${cardBg}" stroke="${border}"/>`,
        `<rect x="${padX + 10}" y="${ry + 12}" width="44" height="20" rx="6" fill="${escapeXml(p.color)}"/>`,
        `<text x="${padX + 32}" y="${ry + 26}" text-anchor="middle" font-size="10.5" font-weight="800" fill="#ffffff">${escapeXml(p.code)}</text>`,
        `<text x="${padX + 62}" y="${ry + 25}" font-size="13" font-weight="700" fill="${textMain}">${escapeXml(p.name.slice(0, 14))}</text>`
      );

      if (row.validation.status === 'broken') {
        parts.push(
          `<text x="${padX + 62}" y="${ry + 43}" font-size="11" font-weight="600" fill="#d97706">断链待修复：${escapeXml(row.validation.issues[0]?.message || '区间已变动')}</text>`
        );
        return;
      }

      const metaLine = `每 ${(p.headwaySec / 60).toFixed(1).replace(/\.0$/, '')} 分 · ${(kin.oneWayTravelSec / 60).toFixed(1)} 分 (${kin.commercialSpeedKmh}km/h)${
        row.savedMinutesVsLocal ? ` · 省 ${row.savedMinutesVsLocal} 分` : ''
      }`;
      parts.push(
        `<text x="${padX + 12}" y="${ry + 44}" font-size="10.5" fill="${textSub}">${escapeXml(metaLine)}</text>`
      );

      // 按物理连续子段绘制多段色带（支持 Y 型主支跳转虚线衔接！）
      row.spans.forEach((sp, spIdx) => {
        const x1 = colCenterX(sp.startCol);
        const x2 = colCenterX(sp.endCol);
        parts.push(
          `<line x1="${x1}" y1="${midY}" x2="${x2}" y2="${midY}" stroke="${escapeXml(p.color)}" stroke-width="6" stroke-linecap="round"/>`
        );
        if (spIdx > 0) {
          const prevSp = row.spans[spIdx - 1];
          const prevEnd = colCenterX(prevSp.endCol);
          // 若是主支贯通列车在主干分岔站跳到右侧支线同站列，用柔和细虚线弧提示跨段接续
          if (model.columns[prevSp.endCol]?.stationId === model.columns[sp.startCol]?.stationId) {
            parts.push(
              `<line x1="${prevEnd}" y1="${midY}" x2="${x1}" y2="${midY}" stroke="${escapeXml(p.color)}" stroke-width="2" stroke-dasharray="4,4" opacity="0.55"/>`
            );
          }
        }
      });

      if (row.throughEntryLabel) {
        parts.push(
          `<text x="${colCenterX(row.startCol) + 4}" y="${midY - 12}" font-size="9.5" font-weight="600" fill="${escapeXml(p.color)}">◀ ${escapeXml(row.throughEntryLabel)}</text>`
        );
      }
      if (row.throughExitLabel) {
        parts.push(
          `<text x="${colCenterX(row.endCol) - 4}" y="${midY - 12}" text-anchor="end" font-size="9.5" font-weight="600" fill="${escapeXml(p.color)}">${escapeXml(row.throughExitLabel)} ▶</text>`
        );
      }

      row.cells.forEach((cell) => {
        if (cell.kind === 'none' || cell.kind === 'pass') return;
        const cx = colCenterX(cell.colIndex);
        if (cell.kind === 'origin' || cell.kind === 'terminus') {
          parts.push(
            `<circle cx="${cx}" cy="${midY}" r="7.5" fill="${bg}" stroke="${escapeXml(p.color)}" stroke-width="3.5"/>`,
            `<circle cx="${cx}" cy="${midY}" r="2.8" fill="${escapeXml(p.color)}"/>`
          );
        } else if (cell.kind === 'stop') {
          parts.push(
            `<circle cx="${cx}" cy="${midY}" r="5.8" fill="${bg}" stroke="${escapeXml(p.color)}" stroke-width="3.2"/>`
          );
        }
        if (cell.arrivalMin !== undefined && cell.kind !== 'origin') {
          parts.push(
            `<text x="${cx}" y="${midY + 18}" text-anchor="middle" font-size="9.5" fill="${textSub}">${cell.arrivalMin.toFixed(1)}&apos;</text>`
          );
        }
      });
    });
  }

  parts.push(
    `<text x="${width - padX}" y="${height - 14}" text-anchor="end" font-size="10.5" fill="${textSub}">Generated by TransitCanvas · Pro Operations Lab</text>`,
    `</svg>`
  );

  return parts.join('\n');
}

export function rasterizeSvgToPngBlob(svgContent: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const matchW = svgContent.match(/width="(\d+(?:\.\d+)?)"/);
    const matchH = svgContent.match(/height="(\d+(?:\.\d+)?)"/);
    const w = matchW ? Number(matchW[1]) : 1200;
    const h = matchH ? Number(matchH[1]) : 480;

    const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('无法创建导出画布'));
          return;
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('PNG 编码失败'));
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('导乘图光栅化加载失败'));
    };
    img.src = url;
  });
}

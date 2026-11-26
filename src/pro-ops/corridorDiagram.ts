import { Line } from '../types';
import { MapGraph } from '../lib/graphOps';
import { measureSectionDistance } from './distance';
import { ServiceKinematicsResult } from './kinematics';
import { buildOrderedLineSteps } from './reconcile';
import {
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
  transferLines: Array<{ id: string; name: string; color: string }>;
  hasTurnback: boolean;
  hasPassingTrack: boolean;
  /** 若列在此处发生跨线道岔切换，展示切入的新线路提示 */
  junctionNote?: string;
}

export interface CorridorRowCell {
  colIndex: number;
  kind: 'none' | 'origin' | 'terminus' | 'stop' | 'pass';
  /** 相对本交路始发站发车时刻的分钟数（如 12.5） */
  arrivalMin?: number;
  passSpeedKmh?: number;
}

export interface CorridorServiceRow {
  pattern: ProServicePattern;
  validation: ProServiceValidation;
  kinematics: ServiceKinematicsResult;
  /** 相比同走廊全程普通车节省的分钟数（> 0.1 时展示） */
  savedMinutesVsLocal?: number;
  startCol: number;
  endCol: number;
  /** 在单线走廊视角下，若交路从外线跨入或跨出本线，标注贯通方向说明 */
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

/**
 * 构建一维拉直版运行体系导乘图模型：
 * - mode = 'pattern': 以指定交路（含环线完整一圈、6字线重复访问或跨线全程）作为横轴，叠加共走廊交路；
 * - mode = 'line':    以指定物理线路作为标准走廊轴（与 Phase 2 斜线运行图纵轴严格一致），展示本线所有交路及跨线车切入/切出。
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

  if (axisMode === 'pattern' && focusPattern && focusKin && focusKin.status === 'valid' && focusKin.visits.length >= 2) {
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
        transferLines: collectTransferLinesForStation(graph, v.stationId, displayLineId),
        hasTurnback: v.hasTurnback,
        hasPassingTrack: v.hasPassingTrack,
        ...(v.switchedToLineName ? { junctionNote: `⇄ 转入${v.switchedToLineName}` } : {})
      });
    });
  } else {
    // 按物理线路作为固定走廊轴
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

    const orderedSteps = buildOrderedLineSteps(graph, line.id);
    if (orderedSteps.length > 0) {
      const firstId = orderedSteps[0].fromStationId;
      const firstSt = stationMap.get(firstId);
      const firstProf = proOps.stationProfiles[firstId];
      columns.push({
        colIndex: 0,
        stationId: firstId,
        stationName: firstSt?.name || firstId,
        lineId: line.id,
        lineName: line.name,
        lineColor: line.color,
        cumulativeKm: 0,
        transferLines: collectTransferLinesForStation(graph, firstId, line.id),
        hasTurnback: Boolean(firstProf?.hasTurnback),
        hasPassingTrack: Boolean(firstProf?.hasPassingTrack)
      });

      let cumMeters = 0;
      orderedSteps.forEach((step, idx) => {
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
        columns.push({
          colIndex: idx + 1,
          stationId: step.toStationId,
          stationName: st?.name || step.toStationId,
          lineId: line.id,
          lineName: line.name,
          lineColor: line.color,
          cumulativeKm: Math.round((cumMeters / 1000) * 100) / 100,
          transferLines: collectTransferLinesForStation(graph, step.toStationId, line.id),
          hasTurnback: Boolean(prof?.hasTurnback),
          hasPassingTrack: Boolean(prof?.hasPassingTrack)
        });
      });
    } else {
      line.stationIds.forEach((sid, idx) => {
        const st = stationMap.get(sid);
        const prof = proOps.stationProfiles[sid];
        columns.push({
          colIndex: idx,
          stationId: sid,
          stationName: st?.name || sid,
          lineId: line.id,
          lineName: line.name,
          lineColor: line.color,
          cumulativeKm: 0,
          transferLines: collectTransferLinesForStation(graph, sid, line.id),
          hasTurnback: Boolean(prof?.hasTurnback),
          hasPassingTrack: Boolean(prof?.hasPassingTrack)
        });
      });
    }
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

  // 将各交路的访问序列对齐映射到当前走廊列（支持正向或反向共走廊子段对齐）
  const mapVisitsToColumns = (
    kin: ServiceKinematicsResult
  ): {
    matched: Map<number, { visitIdx: number; isStop: boolean; arrivalSec: number; passSpeedKmh: number }>;
    firstMatchedVisitIdx: number;
    lastMatchedVisitIdx: number;
  } | null => {
    if (kin.status !== 'valid' || kin.visits.length < 2) return null;

    // 若当前就是 focusPattern 的专属轴且列数完全相等，直接 1:1 精确映射（完美支持 6字线 / 环线重复访问！）
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
        matched: direct,
        firstMatchedVisitIdx: 0,
        lastMatchedVisitIdx: kin.visits.length - 1
      };
    }

    // 尝试正向与反向单调最长子序列匹配走廊列
    const tryAlign = (visitSeq: typeof kin.visits, reversed: boolean) => {
      let bestMap = new Map<number, { visitIdx: number; isStop: boolean; arrivalSec: number; passSpeedKmh: number }>();
      let bestFirst = -1;
      let bestLast = -1;

      for (let vStart = 0; vStart < visitSeq.length; vStart += 1) {
        const startSid = visitSeq[vStart].stationId;
        for (let cStart = 0; cStart < columns.length; cStart += 1) {
          if (columns[cStart].stationId !== startSid) continue;
          const temp = new Map<number, { visitIdx: number; isStop: boolean; arrivalSec: number; passSpeedKmh: number }>();
          let cCursor = cStart;
          let firstOrig = -1;
          let lastOrig = -1;

          for (let vIdx = vStart; vIdx < visitSeq.length && cCursor < columns.length; vIdx += 1) {
            const v = visitSeq[vIdx];
            if (columns[cCursor].stationId === v.stationId) {
              const origIdx = reversed ? kin.visits.length - 1 - vIdx : vIdx;
              if (firstOrig === -1) firstOrig = origIdx;
              lastOrig = origIdx;
              temp.set(cCursor, {
                visitIdx: origIdx,
                isStop: v.isStop,
                arrivalSec: v.arrivalSec,
                passSpeedKmh: v.passSpeedKmh
              });
              cCursor += 1;
            } else {
              break;
            }
          }

          if (temp.size >= 2 && temp.size > bestMap.size) {
            bestMap = temp;
            bestFirst = Math.min(firstOrig, lastOrig);
            bestLast = Math.max(firstOrig, lastOrig);
          }
        }
      }
      return bestMap.size >= 2
        ? { matched: bestMap, firstMatchedVisitIdx: bestFirst, lastMatchedVisitIdx: bestLast }
        : null;
    };

    const forwardRes = tryAlign(kin.visits, false);
    const reverseRes = tryAlign([...kin.visits].reverse(), true);
    if (forwardRes && reverseRes) {
      return forwardRes.matched.size >= reverseRes.matched.size ? forwardRes : reverseRes;
    }
    return forwardRes || reverseRes;
  };

  // 计算同走廊基准慢车全程用时（用于展示快车省时分钟数）
  let localBaselineSec: number | null = null;
  proOps.servicePatterns.forEach((p) => {
    const kin = kinematicsMap[p.id];
    if (
      kin &&
      kin.status === 'valid' &&
      p.category === 'local' &&
      kin.visits.length === columns.length &&
      kin.visits[0]?.stationId === columns[0]?.stationId &&
      kin.visits[kin.visits.length - 1]?.stationId === columns[columns.length - 1]?.stationId
    ) {
      if (localBaselineSec === null || kin.oneWayTravelSec > localBaselineSec) {
        localBaselineSec = kin.oneWayTravelSec;
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
      // 若属于本走廊关联线路，展示断链行以提醒修复
      const touchesCorridor = pattern.routeSteps.some((s) =>
        columns.some((c) => c.stationId === s.fromStationId || c.stationId === s.toStationId)
      );
      if (touchesCorridor || pattern.id === targetPatternId) {
        rows.push({
          pattern,
          validation,
          kinematics: kin,
          startCol: 0,
          endCol: Math.max(0, columns.length - 1),
          cells: columns.map((_, idx) => ({ colIndex: idx, kind: 'none' }))
        });
      }
      return;
    }

    const aligned = mapVisitsToColumns(kin);
    if (!aligned) return;

    const matchedCols = Array.from(aligned.matched.keys()).sort((a, b) => a - b);
    const startCol = matchedCols[0];
    const endCol = matchedCols[matchedCols.length - 1];

    let throughEntryLabel: string | undefined;
    let throughExitLabel: string | undefined;
    if (aligned.firstMatchedVisitIdx > 0) {
      const originVisit = kin.visits[0];
      throughEntryLabel = `贯通自 ${originVisit.lineName}·${originVisit.stationName}`;
    }
    if (aligned.lastMatchedVisitIdx < kin.visits.length - 1) {
      const termVisit = kin.visits[kin.visits.length - 1];
      throughExitLabel = `贯通至 ${termVisit.lineName}·${termVisit.stationName}`;
    }

    let savedMinutesVsLocal: number | undefined;
    if (
      localBaselineSec !== null &&
      startCol === 0 &&
      endCol === columns.length - 1 &&
      aligned.firstMatchedVisitIdx === 0 &&
      aligned.lastMatchedVisitIdx === kin.visits.length - 1
    ) {
      const diffMin = (localBaselineSec - kin.oneWayTravelSec) / 60;
      if (diffMin >= 0.3) {
        savedMinutesVsLocal = Math.round(diffMin * 10) / 10;
      }
    }

    const cells: CorridorRowCell[] = columns.map((_, colIdx) => {
      if (colIdx < startCol || colIdx > endCol) {
        return { colIndex: colIdx, kind: 'none' };
      }
      const hit = aligned.matched.get(colIdx);
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
      startCol,
      endCol,
      ...(throughEntryLabel ? { throughEntryLabel } : {}),
      ...(throughExitLabel ? { throughExitLabel } : {}),
      cells
    });
  });

  const totalKm = columns[columns.length - 1]?.cumulativeKm || 0;
  const distinctLineNames = Array.from(new Set(columns.map((c) => c.lineName)));
  const title =
    axisMode === 'pattern' && focusPattern
      ? `${focusPattern.name} · 全程运行体系导乘图`
      : `${distinctLineNames.join(' / ')} · 走廊运行体系导乘图`;
  const subtitle = `共 ${columns.length} 站 · 走廊里程 ${totalKm.toFixed(2)} km · 已编排 ${rows.length} 种运行交路`;

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

/**
 * 将一维拉直版运行体系导乘图渲染为高分辨率独立矢量 SVG（支持浅色/深色主题，零外部字体依赖）。
 */
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

  const leftHeaderW = 248;
  const colStep = 78;
  const padX = 28;
  const padTop = 82;
  const stationHeaderH = 112;
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

  // 顶部标题与图例栏
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

  // 线路归属连续色带（跨线时自动分段变色）
  const bannerY = padTop;
  let segStart = 0;
  while (segStart < model.columns.length) {
    let segEnd = segStart;
    const lineId = model.columns[segStart].lineId;
    while (segEnd + 1 < model.columns.length && model.columns[segEnd + 1].lineId === lineId) {
      segEnd += 1;
    }
    const x1 = colCenterX(segStart) - colStep * 0.42;
    const x2 = colCenterX(segEnd) + colStep * 0.42;
    const color = model.columns[segStart].lineColor;
    const lineName = model.columns[segStart].lineName;
    parts.push(
      `<rect x="${x1.toFixed(1)}" y="${bannerY}" width="${Math.max(24, x2 - x1).toFixed(1)}" height="22" rx="11" fill="${escapeXml(color)}"/>`,
      `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${bannerY + 15}" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">${escapeXml(lineName)}</text>`
    );
    segStart = segEnd + 1;
  }

  // 车站纵向虚线与站名表头
  const tableTop = padTop + stationHeaderH;
  const tableBottom = tableTop + rowCount * rowH;

  model.columns.forEach((col, idx) => {
    const cx = colCenterX(idx);
    parts.push(
      `<line x1="${cx}" y1="${padTop + 28}" x2="${cx}" y2="${tableBottom}" stroke="${gridLine}" stroke-width="1" stroke-dasharray="3,3"/>`,
      `<text x="${cx}" y="${padTop + 44}" text-anchor="middle" font-size="10" fill="${textSub}">${col.cumulativeKm.toFixed(1)}km</text>`,
      `<text x="${cx}" y="${padTop + 66}" text-anchor="middle" font-size="12.5" font-weight="700" fill="${textMain}">${escapeXml(col.stationName)}</text>`
    );

    // 换乘小胶囊（最多展示前 2 条，避免遮挡）
    col.transferLines.slice(0, 2).forEach((tr, tIdx) => {
      const py = padTop + 76 + tIdx * 16;
      parts.push(
        `<rect x="${cx - 24}" y="${py}" width="48" height="13" rx="6.5" fill="${escapeXml(tr.color)}"/>`,
        `<text x="${cx}" y="${py + 9.8}" text-anchor="middle" font-size="9" font-weight="700" fill="#ffffff">${escapeXml(tr.name.slice(0, 6))}</text>`
      );
    });
  });

  // 各运行交路横带
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

      const xStart = colCenterX(row.startCol);
      const xEnd = colCenterX(row.endCol);
      parts.push(
        `<line x1="${xStart}" y1="${midY}" x2="${xEnd}" y2="${midY}" stroke="${escapeXml(p.color)}" stroke-width="6" stroke-linecap="round"/>`
      );

      if (row.throughEntryLabel) {
        parts.push(
          `<text x="${xStart + 4}" y="${midY - 12}" font-size="9.5" font-weight="600" fill="${escapeXml(p.color)}">◀ ${escapeXml(row.throughEntryLabel)}</text>`
        );
      }
      if (row.throughExitLabel) {
        parts.push(
          `<text x="${xEnd - 4}" y="${midY - 12}" text-anchor="end" font-size="9.5" font-weight="600" fill="${escapeXml(p.color)}">${escapeXml(row.throughExitLabel)} ▶</text>`
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
    `<text x="${width - padX}" y="${height - 14}" text-anchor="end" font-size="10.5" fill="${textSub}">Generated by Metro Designer · Pro Operations Lab</text>`,
    `</svg>`
  );

  return parts.join('\n');
}

/**
 * 将 SVG 矢量字符串光栅化为高清 PNG Blob（2x 视网膜采样）。
 */
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

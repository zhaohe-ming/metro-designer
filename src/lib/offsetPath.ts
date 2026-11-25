// 共线平行区间几何与途经点精准插点计算：
// 1. 解决反向区间（A->B 与 B->A）法向量翻转导致平行线完全重叠在同一侧的历史 Bug；
// 2. 采用逐段法向量 + 顶点角平分线斜接偏移（Miter-Bisector Offset），杜绝折角处平行线交叉；
// 3. 转角处自动按凹凸方向计算同心圆弧半径（外圈 R + d，内圈 R - d），实现官方级等距并线转弯；
// 4. 提供按所点击子段精确计算途经点插入下标的函数，彻底根治途经点顺序错乱。

import { RPoint, roundCorners, rPointsToFlat } from './roundedPath';

const EPS = 1e-6;
const MITER_MIN_DENOM = 0.35; // 限制极端回头锐角斜接长度不超过 ~2.85x

export function canonicalSectionPairKey(stationA: string, stationB: string): string {
  return stationA < stationB ? `${stationA}_${stationB}` : `${stationB}_${stationA}`;
}

/**
 * 计算平行区间在自身遍历方向（startStation -> ...waypoints -> endStation）上的带符号法向偏移量。
 * 统一以 min(idA, idB) -> max(idA, idB) 为规范化正方向；若当前区间与规范方向相反，则自动取反偏移号，
 * 确保无论区间存储方向如何，多条共线轨道永远对称排布在中心线两侧、绝不重叠。
 */
export function computeDirectedParallelOffset(
  startStationId: string,
  endStationId: string,
  slotIndex: number,
  totalSlots: number,
  gap: number
): number {
  if (totalSlots <= 1 || gap === 0) return 0;
  const canonicalOffset = (slotIndex - (totalSlots - 1) / 2) * gap;
  const isCanonicalDirection = startStationId <= endStationId;
  return isCanonicalDirection ? canonicalOffset : -canonicalOffset;
}

/**
 * 对带圆角/圆弧元数据的折线做真正的角平分线等距平行偏移，并自动调整同心转角半径。
 */
export function offsetPolylinePoints(
  points: RPoint[],
  offset: number,
  fallbackCornerRadius = 0
): RPoint[] {
  if (points.length === 0) return [];
  if (Math.abs(offset) < EPS || points.length === 1) {
    return points.map((p) => ({ ...p }));
  }

  // 过滤重合相邻点，同时保留原数组映射关系以便写回
  const clean: RPoint[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = clean[clean.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) > EPS) {
      clean.push(points[i]);
    }
  }
  if (clean.length < 2) {
    return points.map((p) => ({ ...p }));
  }

  const segCount = clean.length - 1;
  const tangents = new Array<{ x: number; y: number }>(segCount);
  const normals = new Array<{ x: number; y: number }>(segCount);

  for (let k = 0; k < segCount; k += 1) {
    const dx = clean[k + 1].x - clean[k].x;
    const dy = clean[k + 1].y - clean[k].y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    tangents[k] = { x: tx, y: ty };
    normals[k] = { x: -ty, y: tx };
  }

  const out: RPoint[] = new Array(clean.length);
  out[0] = {
    ...clean[0],
    x: clean[0].x + normals[0].x * offset,
    y: clean[0].y + normals[0].y * offset
  };

  for (let i = 1; i < clean.length - 1; i += 1) {
    const nPrev = normals[i - 1];
    const nCurr = normals[i];
    const tPrev = tangents[i - 1];
    const tCurr = tangents[i];

    const sumX = nPrev.x + nCurr.x;
    const sumY = nPrev.y + nCurr.y;
    const denom = Math.max(MITER_MIN_DENOM, 1 + (nPrev.x * nCurr.x + nPrev.y * nCurr.y));
    const shiftX = (sumX / denom) * offset;
    const shiftY = (sumY / denom) * offset;

    const basePt = clean[i];
    let adjustedRadius = basePt.radius;
    if (basePt.mode !== 'arc') {
      const rawR = typeof basePt.radius === 'number' ? basePt.radius : fallbackCornerRadius;
      if (rawR > 0) {
        // cross > 0 表示向法向 +N 侧转弯（+offset 在弯道内圈，半径减小；-offset 在外圈，半径增大）
        const cross = tPrev.x * tCurr.y - tPrev.y * tCurr.x;
        if (Math.abs(cross) > 1e-4) {
          const sign = cross > 0 ? 1 : -1;
          adjustedRadius = Math.max(2, rawR - sign * offset);
        }
      }
    }

    out[i] = {
      ...basePt,
      x: basePt.x + shiftX,
      y: basePt.y + shiftY,
      ...(adjustedRadius !== undefined ? { radius: adjustedRadius } : {})
    };
  }

  const lastIdx = clean.length - 1;
  const lastNormal = normals[segCount - 1];
  out[lastIdx] = {
    ...clean[lastIdx],
    x: clean[lastIdx].x + lastNormal.x * offset,
    y: clean[lastIdx].y + lastNormal.y * offset
  };

  return out;
}

/**
 * 一步生成某条区间用于绘制的平行偏移控制点（shiftedPoints）与平滑圆角/圆弧采样点（renderPoints）。
 */
export function buildSectionRenderGeometry(
  controlPoints: RPoint[],
  directedOffset: number,
  fallbackCornerRadius: number
): { shiftedFlat: number[]; renderFlat: number[]; shiftedPoints: RPoint[]; renderPoints: Array<{ x: number; y: number }> } {
  const shiftedPoints = offsetPolylinePoints(controlPoints, directedOffset, fallbackCornerRadius);
  const renderPoints = roundCorners(shiftedPoints, fallbackCornerRadius);
  return {
    shiftedPoints,
    renderPoints,
    shiftedFlat: rPointsToFlat(shiftedPoints),
    renderFlat: rPointsToFlat(renderPoints)
  };
}

export function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; t: number; distance: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) {
    return { x: ax, y: ay, t: 0, distance: Math.hypot(px - ax, py - ay) };
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const x = ax + dx * t;
  const y = ay + dy * t;
  return { x, y, t, distance: Math.hypot(px - x, py - y) };
}

/**
 * 给定区间控制折线 [startStation, ...waypoints, endStation] 与点击/拖拽起始世界坐标 target，
 * 精确找出 target 落在哪一段相邻控制点 [V_j, V_{j+1}] 上，返回新途经点应当插入的 waypoints 数组下标 j（0..waypoints.length）。
 * - 点在第 1 小段（起点~W0）返回 0；
 * - 点在第 2 小段（W0~W1）返回 1；
 * - 即使区间存在 S 弯、U 型回环或任意方向存储，也 100% 匹配视觉所点击的子段，绝不反序打结。
 */
export function findWaypointInsertIndex(
  start: { x: number; y: number },
  waypoints: ReadonlyArray<{ x: number; y: number; mode?: 'corner' | 'arc' }>,
  end: { x: number; y: number },
  target: { x: number; y: number }
): { insertIndex: number; projectedPoint: { x: number; y: number }; distance: number } {
  const vertices = [start, ...waypoints, end];
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestPoint = { x: target.x, y: target.y };

  for (let j = 0; j < vertices.length - 1; j += 1) {
    const a = vertices[j];
    const b = vertices[j + 1];
    const proj = projectPointToSegment(target.x, target.y, a.x, a.y, b.x, b.y);
    if (proj.distance < bestDist) {
      bestDist = proj.distance;
      bestIdx = j;
      bestPoint = { x: proj.x, y: proj.y };
    }
  }

  // 若某个已有途经点开启了过点大圆弧（mode === 'arc'），圆弧可能远离直线弦，额外检测前半弧与后半弧以保证曲线命中归属准确
  for (let w = 0; w < waypoints.length; w += 1) {
    if (waypoints[w].mode !== 'arc') continue;
    const prevV = vertices[w];
    const currV = waypoints[w];
    const nextV = vertices[w + 2];
    const fullArc = roundCorners(
      [
        { x: prevV.x, y: prevV.y },
        { x: currV.x, y: currV.y, mode: 'arc' },
        { x: nextV.x, y: nextV.y }
      ],
      0
    );
    // 找出采样点中最接近 currV 的分界下标：分界前归属区间 w（prevV~currV），分界后归属区间 w+1（currV~nextV）
    let midSampleIdx = Math.floor(fullArc.length / 2);
    let minToWp = Number.POSITIVE_INFINITY;
    for (let s = 0; s < fullArc.length; s += 1) {
      const d = Math.hypot(fullArc[s].x - currV.x, fullArc[s].y - currV.y);
      if (d < minToWp) {
        minToWp = d;
        midSampleIdx = s;
      }
    }
    for (let s = 0; s < fullArc.length - 1; s += 1) {
      const proj = projectPointToSegment(target.x, target.y, fullArc[s].x, fullArc[s].y, fullArc[s + 1].x, fullArc[s + 1].y);
      if (proj.distance < bestDist) {
        bestDist = proj.distance;
        bestIdx = s < midSampleIdx ? w : w + 1;
        bestPoint = { x: proj.x, y: proj.y };
      }
    }
  }

  return { insertIndex: bestIdx, projectedPoint: bestPoint, distance: bestDist };
}

export interface ParallelSectionInput {
  id: string;
  lineId: string;
  startStationId: string;
  endStationId: string;
  points: ReadonlyArray<{ x: number; y: number }>;
  parallelOrder?: ReadonlyArray<string>;
}

export interface SectionParallelMeta {
  /** 该区间沿自身遍历方向（start -> ...waypoints -> end）的带符号法向偏移量 */
  directedOffset: number;
  /** 在当前并行走廊中的槽位下标（0 = 规范正向的上侧/左侧，totalSlots - 1 = 下侧/右侧） */
  slotIndex: number;
  /** 当前并行走廊内的独立线路总数 */
  totalSlots: number;
  /** 当前走廊按槽位从 0 到 totalSlots - 1 排好序的 lineId 列表 */
  orderedLineIds: string[];
  /** 与当前区间同属一整条连续共线走廊的所有 sectionId 列表（供右键整条走廊一键调序） */
  corridorSectionIds: string[];
  /** 仅当前局部并行簇的 sectionId 列表（供按住 Alt 单区间调序） */
  localGroupSectionIds: string[];
  /** 走廊主轴方向提示：horizontal 代表上下排布，vertical 代表左右排布 */
  axisHint: 'horizontal' | 'vertical';
}

export interface NetworkParallelLayout {
  bySectionId: Map<string, SectionParallelMeta>;
  /**
   * 单线中间站被跨多区间快线旁通时的视觉圆心微调量：
   * 让单线站圆点精准落在所属普线的偏移轨道上，同时与旁通快线留出清晰间隙，避免产生“快线也停靠该站”的误读。
   */
  stationTrackNudges: Map<string, { dx: number; dy: number }>;
}

interface PolySegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  tx: number;
  ty: number;
  len: number;
}

interface IndexedSection {
  idx: number;
  input: ParallelSectionInput;
  pairKey: string;
  segs: PolySegment[];
  totalLen: number;
  dx: number;
  dy: number;
  tStart: { x: number; y: number };
  tEnd: { x: number; y: number };
  mid: { x: number; y: number };
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function isScreenCanonicalVector(dx: number, dy: number): boolean {
  // 屏幕坐标系 (+x 向右, +y 向下)，法向量 n = (-ty, tx)：
  // 1) 横向/斜向走廊 (|dx| > 4) 取左 -> 右 (dx > 0)，此时 slot 0 (-offset) 恒居屏幕上方，slot 1 (+offset) 恒居屏幕下方；
  // 2) 近竖直走廊 (|dx| <= 4) 取下 -> 上 (dy < 0)，此时 slot 0 (-offset) 恒居屏幕左侧，slot 1 (+offset) 恒居屏幕右侧。
  return Math.abs(dx) > 4 ? dx > 0 : dy < 0;
}

/**
 * 计算两条不同线路区间之间的平行共线投影重叠长度与方向点积（用于识别跨多区间直达快线与分段普线的几何重合）。
 * 十字/斜交换乘线因 |dot| < 0.94（夹角 > 20°）被直接过滤，绝不误触发平行避让。
 */
function measureCollinearOverlap(
  shorter: IndexedSection,
  longer: IndexedSection,
  distTol: number
): { overlapLen: number; signedDotSum: number } {
  let overlapLen = 0;
  let signedDotSum = 0;

  for (let i = 0; i < shorter.segs.length; i += 1) {
    const p = shorter.segs[i];
    for (let j = 0; j < longer.segs.length; j += 1) {
      const q = longer.segs[j];
      const dot = p.tx * q.tx + p.ty * q.ty;
      if (Math.abs(dot) < 0.94) continue;

      const u0 = (p.ax - q.ax) * q.tx + (p.ay - q.ay) * q.ty;
      const u1 = (p.bx - q.ax) * q.tx + (p.by - q.ay) * q.ty;
      const lo = Math.max(0, Math.min(u0, u1));
      const hi = Math.min(q.len, Math.max(u0, u1));
      const ov = hi - lo;
      if (ov <= 4) continue;

      const uMid = (lo + hi) * 0.5;
      const qx = q.ax + q.tx * uMid;
      const qy = q.ay + q.ty * uMid;
      const denom = u1 - u0;
      const tP = Math.abs(denom) > EPS ? Math.max(0, Math.min(1, (uMid - u0) / denom)) : 0.5;
      const px = p.ax + (p.bx - p.ax) * tP;
      const py = p.ay + (p.by - p.ay) * tP;
      if (Math.hypot(px - qx, py - qy) <= distTol) {
        overlapLen += ov;
        signedDotSum += dot * ov;
      }
    }
  }

  return { overlapLen, signedDotSum };
}

/**
 * 在有序线路列表 orderedLineIds 中调整指定线路的槽位（2 线直接对调，多线支持上下/左右移动一格）。
 */
export function moveLineInParallelOrder(
  orderedLineIds: ReadonlyArray<string>,
  targetLineId: string,
  direction: 'swap' | 'prev' | 'next'
): string[] {
  const next = [...orderedLineIds];
  if (next.length < 2) return next;
  if (direction === 'swap' || next.length === 2) {
    if (next.length === 2) return [next[1], next[0]];
    const idx = next.indexOf(targetLineId);
    if (idx < 0) return next.reverse();
    const swapIdx = idx === 0 ? 1 : idx - 1;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    return next;
  }
  const idx = next.indexOf(targetLineId);
  if (idx < 0) return next;
  const swapWith = direction === 'prev' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= next.length) return next;
  [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
  return next;
}

/**
 * 全网统一共线并行布局引擎（供画布实时渲染、SVG 矢量导出、MP4 动态视频导出三端共享）：
 * 1) 支持同起终点多线并行 + 跨多区间直达快线（A->D 覆盖 A-B-C-D）几何自动识别并线；
 * 2) 多站共线走廊链式连续定向：消除因随机站点 ID 字典序导致的站内上下翻面/X 形交叉；
 * 3) 首段屏幕直觉锚定（横向排前居上、竖向排前居左）+ 支持区间级 parallelOrder 局部自定义顺序；
 * 4) 自动输出被快线越站旁通的单线中间站圆点轨道对齐微调量（stationTrackNudges）。
 */
export function computeNetworkParallelLayout(params: {
  sections: ReadonlyArray<ParallelSectionInput>;
  lineOrderMap: ReadonlyMap<string, number>;
  gap: number;
  stationLineCounts?: Readonly<Record<string, number>>;
}): NetworkParallelLayout {
  const { sections, lineOrderMap, gap, stationLineCounts } = params;
  const bySectionId = new Map<string, SectionParallelMeta>();
  const stationTrackNudges = new Map<string, { dx: number; dy: number }>();
  if (sections.length === 0) {
    return { bySectionId, stationTrackNudges };
  }

  const indexed: IndexedSection[] = [];
  for (let idx = 0; idx < sections.length; idx += 1) {
    const s = sections[idx];
    const pts = s.points;
    if (!pts || pts.length < 2) continue;

    const clean: Array<{ x: number; y: number }> = [pts[0]];
    let minX = pts[0].x;
    let minY = pts[0].y;
    let maxX = pts[0].x;
    let maxY = pts[0].y;
    for (let k = 1; k < pts.length; k += 1) {
      const p = pts[k];
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      const prev = clean[clean.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > EPS) {
        clean.push(p);
      }
    }

    const segs: PolySegment[] = [];
    let totalLen = 0;
    for (let k = 0; k < clean.length - 1; k += 1) {
      const a = clean[k];
      const b = clean[k + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len <= EPS) continue;
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, tx: dx / len, ty: dy / len, len });
      totalLen += len;
    }

    const first = clean[0];
    const last = clean[clean.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const chordLen = Math.hypot(dx, dy) || 1;
    const tStart = segs.length > 0 ? { x: segs[0].tx, y: segs[0].ty } : { x: dx / chordLen, y: dy / chordLen };
    const tEnd =
      segs.length > 0
        ? { x: segs[segs.length - 1].tx, y: segs[segs.length - 1].ty }
        : { x: dx / chordLen, y: dy / chordLen };

    let mid = { x: (first.x + last.x) * 0.5, y: (first.y + last.y) * 0.5 };
    if (segs.length > 0 && totalLen > EPS) {
      const half = totalLen * 0.5;
      let acc = 0;
      for (let k = 0; k < segs.length; k += 1) {
        if (acc + segs[k].len >= half || k === segs.length - 1) {
          const r = Math.max(0, Math.min(1, (half - acc) / segs[k].len));
          mid = {
            x: segs[k].ax + (segs[k].bx - segs[k].ax) * r,
            y: segs[k].ay + (segs[k].by - segs[k].ay) * r
          };
          break;
        }
        acc += segs[k].len;
      }
    }

    indexed.push({
      idx: indexed.length,
      input: s,
      pairKey: canonicalSectionPairKey(s.startStationId, s.endStationId),
      segs,
      totalLen,
      dx,
      dy,
      tStart,
      tEnd,
      mid,
      minX,
      minY,
      maxX,
      maxY
    });
  }

  const n = indexed.length;
  if (n === 0) return { bySectionId, stationTrackNudges };

  // 并查集构建局部并行簇（融合：1. 同起终点共线区间；2. 跨区间直达快线共线覆盖）
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let c = x;
    while (c !== r) {
      const nxt = parent[c];
      parent[c] = r;
      c = nxt;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const distTol = Math.max(11, Math.abs(gap) * 1.65);
  const maxPairDetourDist = Math.max(120, Math.abs(gap) * 14);

  // Pass A: 相同起终点区间归组（排除相距甚远的环线半圈绕行支路）
  const byPair = new Map<string, IndexedSection[]>();
  for (let i = 0; i < n; i += 1) {
    const item = indexed[i];
    const arr = byPair.get(item.pairKey);
    if (arr) arr.push(item);
    else byPair.set(item.pairKey, [item]);
  }
  byPair.forEach((arr) => {
    if (arr.length < 2) return;
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const a = arr[i];
        const b = arr[j];
        if (a.input.lineId === b.input.lineId) continue;
        const bothStraight = a.input.points.length <= 2 && b.input.points.length <= 2;
        const midDist = Math.hypot(a.mid.x - b.mid.x, a.mid.y - b.mid.y);
        if (bothStraight || midDist <= maxPairDetourDist) {
          union(a.idx, b.idx);
        } else {
          const shorter = a.totalLen <= b.totalLen ? a : b;
          const longer = a.totalLen <= b.totalLen ? b : a;
          const { overlapLen } = measureCollinearOverlap(shorter, longer, distTol);
          if (overlapLen >= Math.max(16, Math.min(34, shorter.totalLen * 0.45))) {
            union(a.idx, b.idx);
          }
        }
      }
    }
  });

  // Pass B: 沿 minX 扫描剪枝，自动检测跨多区间快线与分段普线的平行共线重叠
  const sortedByMinX = [...indexed].sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < n; i += 1) {
    const a = sortedByMinX[i];
    if (a.totalLen < 4 || a.segs.length === 0) continue;
    const limitX = a.maxX + distTol;
    for (let j = i + 1; j < n; j += 1) {
      const b = sortedByMinX[j];
      if (b.minX > limitX) break;
      if (a.input.lineId === b.input.lineId) continue;
      if (find(a.idx) === find(b.idx)) continue;
      if (b.totalLen < 4 || b.segs.length === 0) continue;
      if (Math.max(a.minY, b.minY) > Math.min(a.maxY, b.maxY) + distTol) continue;

      const shorter = a.totalLen <= b.totalLen ? a : b;
      const longer = a.totalLen <= b.totalLen ? b : a;
      const { overlapLen } = measureCollinearOverlap(shorter, longer, distTol);
      const minRequired = Math.max(16, Math.min(36, shorter.totalLen * 0.48));
      if (overlapLen >= minRequired) {
        union(a.idx, b.idx);
      }
    }
  }

  // 汇总所有局部簇
  const rawClusters = new Map<number, IndexedSection[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const list = rawClusters.get(r);
    if (list) list.push(indexed[i]);
    else rawClusters.set(r, [indexed[i]]);
  }

  interface ParallelCluster {
    clusterIdx: number;
    members: IndexedSection[];
    rep: IndexedSection;
    lineSet: Set<string>;
    orderedLineIds: string[];
    reversed: boolean;
    corridorId: number;
  }

  const multiClusters: ParallelCluster[] = [];

  rawClusters.forEach((members) => {
    const lineSet = new Set<string>();
    members.forEach((m) => lineSet.add(m.input.lineId));
    if (lineSet.size < 2) {
      // 单线独行区间：偏移为 0
      const onlyLineId = members[0].input.lineId;
      const secIds = members.map((m) => m.input.id);
      members.forEach((m) => {
        bySectionId.set(m.input.id, {
          directedOffset: 0,
          slotIndex: 0,
          totalSlots: 1,
          orderedLineIds: [onlyLineId],
          corridorSectionIds: secIds,
          localGroupSectionIds: secIds,
          axisHint: Math.abs(m.dx) >= Math.abs(m.dy) * 0.85 ? 'horizontal' : 'vertical'
        });
      });
      return;
    }

    // 选簇内总长最长（其次按线路顺序、ID 稳定排序）的区间作为几何参考主轴 rep
    const sortedForRep = [...members].sort((a, b) => {
      if (Math.abs(b.totalLen - a.totalLen) > 1) return b.totalLen - a.totalLen;
      const oa = lineOrderMap.get(a.input.lineId) ?? 9999;
      const ob = lineOrderMap.get(b.input.lineId) ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.input.id.localeCompare(b.input.id);
    });
    const rep = sortedForRep[0];

    const defaultOrdered = Array.from(lineSet).sort((la, lb) => {
      const oa = lineOrderMap.get(la) ?? 9999;
      const ob = lineOrderMap.get(lb) ?? 9999;
      return oa !== ob ? oa - ob : la.localeCompare(lb);
    });

    // 若簇内区间带有用户自定义 parallelOrder，优先采用该顺序
    let customOrder: ReadonlyArray<string> | undefined;
    for (let i = 0; i < sortedForRep.length; i += 1) {
      const po = sortedForRep[i].input.parallelOrder;
      if (po && po.length >= 2 && po.some((id) => lineSet.has(id))) {
        customOrder = po;
        break;
      }
    }

    const orderedLineIds = customOrder
      ? [...defaultOrdered].sort((la, lb) => {
          const ia = customOrder!.indexOf(la);
          const ib = customOrder!.indexOf(lb);
          const sa = ia >= 0 ? ia : 1000 + defaultOrdered.indexOf(la);
          const sb = ib >= 0 ? ib : 1000 + defaultOrdered.indexOf(lb);
          return sa - sb;
        })
      : defaultOrdered;

    multiClusters.push({
      clusterIdx: multiClusters.length,
      members,
      rep,
      lineSet,
      orderedLineIds,
      reversed: !isScreenCanonicalVector(rep.dx, rep.dy),
      corridorId: -1
    });
  });

  // Stage 3: 多站共线走廊链式连续定向（沿共享换乘站串联多段并行簇，锁定同侧槽位绝不翻面）
  if (multiClusters.length > 0) {
    const byBoundaryStation = new Map<string, number[]>();
    const addBoundary = (stId: string, cIdx: number) => {
      const arr = byBoundaryStation.get(stId);
      if (arr) {
        if (!arr.includes(cIdx)) arr.push(cIdx);
      } else {
        byBoundaryStation.set(stId, [cIdx]);
      }
    };

    multiClusters.forEach((c) => {
      addBoundary(c.rep.input.startStationId, c.clusterIdx);
      addBoundary(c.rep.input.endStationId, c.clusterIdx);
    });

    // 每个簇最多在 startStationId 侧连 1 个前驱/邻接簇，在 endStationId 侧连 1 个后继/邻接簇
    interface ChainLink {
      neighborIdx: number;
      viaStationId: string;
    }
    const clusterLinks = new Map<number, ChainLink[]>();
    multiClusters.forEach((c) => clusterLinks.set(c.clusterIdx, []));

    interface CandidateLink {
      aIdx: number;
      bIdx: number;
      stationId: string;
      sharedLines: number;
      contDot: number;
    }
    const candidates: CandidateLink[] = [];

    byBoundaryStation.forEach((cIndices, stationId) => {
      if (cIndices.length < 2) return;
      for (let i = 0; i < cIndices.length; i += 1) {
        for (let j = i + 1; j < cIndices.length; j += 1) {
          const ca = multiClusters[cIndices[i]];
          const cb = multiClusters[cIndices[j]];
          // 跳过自环区间
          if (
            ca.rep.input.startStationId === ca.rep.input.endStationId ||
            cb.rep.input.startStationId === cb.rep.input.endStationId
          ) {
            continue;
          }
          let shared = 0;
          ca.lineSet.forEach((lid) => {
            if (cb.lineSet.has(lid)) shared += 1;
          });
          if (shared < 2) continue;

          // 计算穿过 stationId 时的切线顺滑度：ca 驶入 stationId 的切向 · cb 驶离 stationId 的切向
          const intoS =
            ca.rep.input.endStationId === stationId
              ? ca.rep.tEnd
              : { x: -ca.rep.tStart.x, y: -ca.rep.tStart.y };
          const outOfS =
            cb.rep.input.startStationId === stationId
              ? cb.rep.tStart
              : { x: -cb.rep.tEnd.x, y: -cb.rep.tEnd.y };
          const contDot = intoS.x * outOfS.x + intoS.y * outOfS.y;
          if (contDot <= -0.65) continue; // 排除 180° 折返发卡弯

          candidates.push({
            aIdx: ca.clusterIdx,
            bIdx: cb.clusterIdx,
            stationId,
            sharedLines: shared,
            contDot
          });
        }
      }
    });

    candidates.sort((x, y) => {
      if (y.sharedLines !== x.sharedLines) return y.sharedLines - x.sharedLines;
      return y.contDot - x.contDot;
    });

    const usedStationPort = new Set<string>(); // `${clusterIdx}:${stationId}` 及站点度数<=2约束
    const stationUsedCount = new Map<string, number>();

    candidates.forEach((cand) => {
      const portA = `${cand.aIdx}:${cand.stationId}`;
      const portB = `${cand.bIdx}:${cand.stationId}`;
      const stUsed = stationUsedCount.get(cand.stationId) || 0;
      if (usedStationPort.has(portA) || usedStationPort.has(portB) || stUsed >= 2) return;
      const linksA = clusterLinks.get(cand.aIdx)!;
      const linksB = clusterLinks.get(cand.bIdx)!;
      if (linksA.length >= 2 || linksB.length >= 2) return;

      usedStationPort.add(portA);
      usedStationPort.add(portB);
      stationUsedCount.set(cand.stationId, stUsed + 2);
      linksA.push({ neighborIdx: cand.bIdx, viaStationId: cand.stationId });
      linksB.push({ neighborIdx: cand.aIdx, viaStationId: cand.stationId });
    });

    // 遍历所有走廊链（优先从端点 degree <= 1 开始走，环路再兜底）
    const visited = new Set<number>();
    let corridorCounter = 0;

    const processChainFrom = (seedIdx: number) => {
      const chain: number[] = [seedIdx];
      const sharedStations: string[] = [];
      visited.add(seedIdx);

      let curr = seedIdx;
      while (true) {
        const links = clusterLinks.get(curr) || [];
        const nextLink = links.find((l) => !visited.has(l.neighborIdx));
        if (!nextLink) break;
        visited.add(nextLink.neighborIdx);
        sharedStations.push(nextLink.viaStationId);
        chain.push(nextLink.neighborIdx);
        curr = nextLink.neighborIdx;
      }

      const cid = corridorCounter++;
      chain.forEach((cIdx) => {
        multiClusters[cIdx].corridorId = cid;
      });

      if (chain.length === 1) {
        const only = multiClusters[chain[0]];
        only.reversed = !isScreenCanonicalVector(only.rep.dx, only.rep.dy);
        return;
      }

      // 沿链方向对齐每一段簇的进出方向
      const c0 = multiClusters[chain[0]];
      c0.reversed = c0.rep.input.endStationId !== sharedStations[0];
      for (let t = 1; t < chain.length; t += 1) {
        const ct = multiClusters[chain[t]];
        ct.reversed = ct.rep.input.startStationId !== sharedStations[t - 1];
      }

      // 计算整条走廊的合位移，使首尾符合屏幕直觉正向（左->右居上，下->上居左）
      let netDx = 0;
      let netDy = 0;
      chain.forEach((cIdx) => {
        const c = multiClusters[cIdx];
        netDx += c.reversed ? -c.rep.dx : c.rep.dx;
        netDy += c.reversed ? -c.rep.dy : c.rep.dy;
      });
      const refDx = Math.hypot(netDx, netDy) > 4 ? netDx : c0.reversed ? -c0.rep.dx : c0.rep.dx;
      const refDy = Math.hypot(netDx, netDy) > 4 ? netDy : c0.reversed ? -c0.rep.dy : c0.rep.dy;
      if (!isScreenCanonicalVector(refDx, refDy)) {
        chain.forEach((cIdx) => {
          multiClusters[cIdx].reversed = !multiClusters[cIdx].reversed;
        });
      }
    };

    // Pass 1: 开放链端点 (degree <= 1)
    for (let i = 0; i < multiClusters.length; i += 1) {
      if (visited.has(i)) continue;
      if ((clusterLinks.get(i)?.length || 0) <= 1) {
        processChainFrom(i);
      }
    }
    // Pass 2: 闭合走廊环 (degree === 2)
    for (let i = 0; i < multiClusters.length; i += 1) {
      if (!visited.has(i)) {
        processChainFrom(i);
      }
    }

    // 汇总每条连续走廊下的全部 sectionId
    const corridorSectionIdsMap = new Map<number, string[]>();
    multiClusters.forEach((c) => {
      const list = corridorSectionIdsMap.get(c.corridorId) || [];
      c.members.forEach((m) => list.push(m.input.id));
      corridorSectionIdsMap.set(c.corridorId, list);
    });

    // Stage 4: 计算每个区间的精确带符号法向偏移量 directedOffset
    multiClusters.forEach((cluster) => {
      const { rep, members, orderedLineIds, reversed } = cluster;
      const totalSlots = orderedLineIds.length;
      const localGroupSectionIds = members.map((m) => m.input.id);
      const corridorSectionIds = corridorSectionIdsMap.get(cluster.corridorId) || localGroupSectionIds;
      const axisHint: 'horizontal' | 'vertical' =
        Math.abs(rep.dx) >= Math.abs(rep.dy) * 0.85 ? 'horizontal' : 'vertical';

      members.forEach((m) => {
        const slotIndex = Math.max(0, orderedLineIds.indexOf(m.input.lineId));
        const canonicalOffset = totalSlots <= 1 || gap === 0 ? 0 : (slotIndex - (totalSlots - 1) / 2) * gap;

        let sameAsRep: boolean;
        if (m.idx === rep.idx) {
          sameAsRep = true;
        } else if (
          m.input.startStationId === rep.input.startStationId &&
          m.input.endStationId === rep.input.endStationId &&
          m.input.startStationId !== m.input.endStationId
        ) {
          sameAsRep = true;
        } else if (
          m.input.startStationId === rep.input.endStationId &&
          m.input.endStationId === rep.input.startStationId &&
          m.input.startStationId !== m.input.endStationId
        ) {
          sameAsRep = false;
        } else {
          const shorter = m.totalLen <= rep.totalLen ? m : rep;
          const longer = m.totalLen <= rep.totalLen ? rep : m;
          const { overlapLen, signedDotSum } = measureCollinearOverlap(shorter, longer, distTol);
          if (overlapLen > 2 && Math.abs(signedDotSum) > EPS) {
            sameAsRep = signedDotSum >= 0;
          } else {
            sameAsRep = m.dx * rep.dx + m.dy * rep.dy >= 0;
          }
        }

        const sameAsCorridor = reversed ? !sameAsRep : sameAsRep;
        const directedOffset = sameAsCorridor ? canonicalOffset : -canonicalOffset;

        bySectionId.set(m.input.id, {
          directedOffset,
          slotIndex,
          totalSlots,
          orderedLineIds,
          corridorSectionIds,
          localGroupSectionIds,
          axisHint
        });
      });
    });
  }

  // Stage 5: 为被跨区间快线旁通的单线中间站计算轨道圆心对齐微调量
  if (stationLineCounts && Math.abs(gap) > EPS) {
    const incidentByStation = new Map<string, Array<{ sec: IndexedSection; atStart: boolean }>>();
    const pushIncident = (stId: string, sec: IndexedSection, atStart: boolean) => {
      const arr = incidentByStation.get(stId);
      if (arr) arr.push({ sec, atStart });
      else incidentByStation.set(stId, [{ sec, atStart }]);
    };
    indexed.forEach((sec) => {
      pushIncident(sec.input.startStationId, sec, true);
      if (sec.input.endStationId !== sec.input.startStationId) {
        pushIncident(sec.input.endStationId, sec, false);
      }
    });

    const maxNudge = Math.abs(gap) * 1.5;
    incidentByStation.forEach((items, stId) => {
      if ((stationLineCounts[stId] || 0) !== 1 || items.length === 0) return;
      let sumX = 0;
      let sumY = 0;
      let validCount = 0;
      for (let i = 0; i < items.length; i += 1) {
        const { sec, atStart } = items[i];
        const meta = bySectionId.get(sec.input.id);
        if (!meta || Math.abs(meta.directedOffset) <= 0.4) return;
        const tangent = atStart ? sec.tStart : sec.tEnd;
        const nx = -tangent.y;
        const ny = tangent.x;
        sumX += nx * meta.directedOffset;
        sumY += ny * meta.directedOffset;
        validCount += 1;
      }
      if (validCount > 0) {
        let dx = sumX / validCount;
        let dy = sumY / validCount;
        const mag = Math.hypot(dx, dy);
        if (mag > maxNudge) {
          dx = (dx / mag) * maxNudge;
          dy = (dy / mag) * maxNudge;
        }
        stationTrackNudges.set(stId, { dx, dy });
      }
    });
  }

  return { bySectionId, stationTrackNudges };
}

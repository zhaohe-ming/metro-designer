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

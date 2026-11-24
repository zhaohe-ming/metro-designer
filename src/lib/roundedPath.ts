// 折线与圆弧几何纯函数：
// 支持每个内部途经点独立设置：
// 1. mode === 'corner'（默认）：相切导圆角（Corner Fillet），支持单点独立 radius（覆盖全局 fallbackRadius）；
// 2. mode === 'arc'：过「前锚点 — 当前途经点 — 后锚点」的三点正圆弧（3-Point Circular Arc），适合画环线、沿江弧线；
// 3. 提供圆弧拉杆手柄（Arc Handle）的正向位置计算与反向拖拽求半径函数，供画布直接交互调圆弧。

export interface RPoint {
  x: number;
  y: number;
  /** 单点独立导圆角半径（undefined 则回退至 fallbackRadius；0 表示强制尖角） */
  radius?: number;
  /** 'corner' = 相切导圆角（默认）；'arc' = 过三点纯圆弧 */
  mode?: 'corner' | 'arc';
}

export interface CornerHandleInfo {
  /** 拐角内侧单位角平分线方向 */
  bisectorX: number;
  bisectorY: number;
  /** 两臂夹角（弧度，0..PI） */
  theta: number;
  /** 当前几何允许的最大导圆角半径（受相邻两臂半长限制） */
  maxRadius: number;
  /** 实际生效半径 */
  effectiveRadius: number;
  /** 圆弧顶点（圆弧中点）世界坐标 */
  arcApexX: number;
  arcApexY: number;
  /** 推荐手柄中心世界坐标（当 radius=0 时留最小抓取间距，方便从尖角直接往内拉） */
  handleX: number;
  handleY: number;
}

const EPS = 1e-6;
const TWO_PI = Math.PI * 2;

function wrapPositiveAngle(rad: number): number {
  const mod = rad % TWO_PI;
  return mod < 0 ? mod + TWO_PI : mod;
}

/**
 * 采样过三点 A -> M -> B 的正圆弧（不含起点 A；若 includeEnd=true 则包含终点 B）。
 * 当三点近似共线时退化为折线段。
 */
export function sampleThreePointArc(
  a: { x: number; y: number },
  m: { x: number; y: number },
  b: { x: number; y: number },
  includeEnd: boolean
): Array<{ x: number; y: number }> {
  const x1 = a.x;
  const y1 = a.y;
  const x2 = m.x;
  const y2 = m.y;
  const x3 = b.x;
  const y3 = b.y;

  const det = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(det) < 1e-3) {
    return includeEnd ? [{ x: x2, y: y2 }, { x: x3, y: y3 }] : [{ x: x2, y: y2 }];
  }

  const s1 = x1 * x1 + y1 * y1;
  const s2 = x2 * x2 + y2 * y2;
  const s3 = x3 * x3 + y3 * y3;
  const cx = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / det;
  const cy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / det;
  const r = Math.hypot(x1 - cx, y1 - cy);

  if (!Number.isFinite(r) || r < EPS || r > 50000) {
    return includeEnd ? [{ x: x2, y: y2 }, { x: x3, y: y3 }] : [{ x: x2, y: y2 }];
  }

  const aA = Math.atan2(y1 - cy, x1 - cx);
  const aM = Math.atan2(y2 - cy, x2 - cx);
  const aB = Math.atan2(y3 - cy, x3 - cx);

  const ccwAM = wrapPositiveAngle(aM - aA);
  const ccwAB = wrapPositiveAngle(aB - aA);
  // 判断逆时针从 A 到 B 的弧是否经过 M；否则走顺时针负角度弧
  const sweep = ccwAM <= ccwAB ? ccwAB : ccwAB - TWO_PI;

  const steps = Math.max(8, Math.min(96, Math.ceil(Math.abs(sweep) / (Math.PI / 24))));
  const limit = includeEnd ? steps : steps - 1;
  const out: Array<{ x: number; y: number }> = [];
  for (let k = 1; k <= limit; k += 1) {
    const angle = aA + sweep * (k / steps);
    out.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return out;
}

function hasVertexCurve(pt: RPoint, fallbackRadius: number): boolean {
  if (pt.mode === 'arc') return true;
  const r = typeof pt.radius === 'number' ? pt.radius : fallbackRadius;
  return r > 0;
}

export function roundCorners(points: RPoint[], fallbackRadius = 0, angleThresholdDeg = 6): Array<{ x: number; y: number }> {
  if (points.length < 3) {
    return points.map((p) => ({ x: p.x, y: p.y }));
  }

  const anyCurved = points.some((pt, idx) => idx > 0 && idx < points.length - 1 && hasVertexCurve(pt, fallbackRadius));
  if (!anyCurved) {
    return points.map((p) => ({ x: p.x, y: p.y }));
  }

  const out: Array<{ x: number; y: number }> = [{ x: points[0].x, y: points[0].y }];

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    if (curr.mode === 'arc') {
      const startAnchor = out[out.length - 1];
      const isNextLast = i + 1 === points.length - 1;
      const nextNeedsRoom = !isNextLast && hasVertexCurve(next, fallbackRadius);
      const endAnchor = nextNeedsRoom
        ? { x: (curr.x + next.x) / 2, y: (curr.y + next.y) / 2 }
        : { x: next.x, y: next.y };
      const arcPts = sampleThreePointArc(startAnchor, curr, endAnchor, nextNeedsRoom);
      for (let k = 0; k < arcPts.length; k += 1) {
        out.push(arcPts[k]);
      }
      continue;
    }

    const effectiveFallback = typeof curr.radius === 'number' ? curr.radius : fallbackRadius;
    if (effectiveFallback <= 0) {
      out.push({ x: curr.x, y: curr.y });
      continue;
    }

    // 若前一个顶点是过点圆弧，其终点已落在 (prev+curr)/2，左臂有效起点为 out 末尾
    const effectivePrev = prev.mode === 'arc' ? out[out.length - 1] : prev;
    const v1x = effectivePrev.x - curr.x;
    const v1y = effectivePrev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < EPS || len2 < EPS) {
      out.push({ x: curr.x, y: curr.y });
      continue;
    }

    const u1x = v1x / len1;
    const u1y = v1y / len1;
    const u2x = v2x / len2;
    const u2y = v2y / len2;

    const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
    const theta = Math.acos(dot);
    const turnDeg = 180 - (theta * 180) / Math.PI;
    if (turnDeg < angleThresholdDeg) {
      out.push({ x: curr.x, y: curr.y });
      continue;
    }

    const half = theta / 2;
    const tanHalf = Math.tan(half);
    let t = tanHalf > EPS ? effectiveFallback / tanHalf : effectiveFallback;
    // 若该拐点显式指定了独立 radius，允许向端点侧伸展至臂长 90% 以拉出大弯道；全局默认模式保持 50% 夹紧防重叠
    const hasExplicitRadius = typeof curr.radius === 'number';
    const maxArm1 = hasExplicitRadius && i === 1 && !hasVertexCurve(prev, fallbackRadius) ? len1 * 0.9 : len1 * 0.5;
    const maxArm2 =
      hasExplicitRadius && (i + 1 === points.length - 1 || !hasVertexCurve(next, fallbackRadius))
        ? len2 * 0.9
        : len2 * 0.5;
    t = Math.min(t, maxArm1, maxArm2);
    const rEff = t * tanHalf;
    if (rEff < 1e-3) {
      out.push({ x: curr.x, y: curr.y });
      continue;
    }

    const p1 = { x: curr.x + u1x * t, y: curr.y + u1y * t };
    const p2 = { x: curr.x + u2x * t, y: curr.y + u2y * t };

    let bx = u1x + u2x;
    let by = u1y + u2y;
    const blen = Math.hypot(bx, by);
    if (blen < EPS) {
      out.push({ x: curr.x, y: curr.y });
      continue;
    }
    bx /= blen;
    by /= blen;
    const dc = rEff / Math.sin(half);
    const cx = curr.x + bx * dc;
    const cy = curr.x * 0 + curr.y + by * dc;

    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const a2 = Math.atan2(p2.y - cy, p2.x - cx);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= TWO_PI;
    while (delta < -Math.PI) delta += TWO_PI;
    const steps = Math.max(3, Math.ceil(Math.abs(delta) / (Math.PI / 20)));
    for (let k = 0; k <= steps; k += 1) {
      const a = a1 + delta * (k / steps);
      out.push({ x: cx + rEff * Math.cos(a), y: cy + rEff * Math.sin(a) });
    }
  }

  out.push({ x: points[points.length - 1].x, y: points[points.length - 1].y });
  return out;
}

/**
 * 计算某个内部拐点（mode === 'corner'）的圆弧拉杆手柄几何信息，供画布选中途经点时渲染拖拽拉杆。
 */
export function computeCornerHandleInfo(
  prev: { x: number; y: number },
  curr: { x: number; y: number },
  next: { x: number; y: number },
  currentRadius: number,
  minHandleGapWorld = 18
): CornerHandleInfo | null {
  const v1x = prev.x - curr.x;
  const v1y = prev.y - curr.y;
  const v2x = next.x - curr.x;
  const v2y = next.y - curr.y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 < EPS || len2 < EPS) return null;

  const u1x = v1x / len1;
  const u1y = v1y / len1;
  const u2x = v2x / len2;
  const u2y = v2y / len2;
  const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
  const theta = Math.acos(dot);
  const turnDeg = 180 - (theta * 180) / Math.PI;
  if (turnDeg < 6) return null;

  let bx = u1x + u2x;
  let by = u1y + u2y;
  const blen = Math.hypot(bx, by);
  if (blen < EPS) return null;
  bx /= blen;
  by /= blen;

  const half = theta / 2;
  const tanHalf = Math.tan(half);
  const sinHalf = Math.sin(half);
  const maxT = Math.min(len1, len2) * 0.9;
  const maxRadius = Math.max(0, maxT * tanHalf);
  const effectiveRadius = Math.max(0, Math.min(currentRadius, maxRadius));

  // 圆弧中点离拐点的距离 dArc = r * (1 / sin(half) - 1)
  const apexFactor = Math.max(0, 1 / Math.max(EPS, sinHalf) - 1);
  const apexDist = effectiveRadius * apexFactor;
  const handleDist = Math.max(minHandleGapWorld, apexDist);

  return {
    bisectorX: bx,
    bisectorY: by,
    theta,
    maxRadius,
    effectiveRadius,
    arcApexX: curr.x + bx * apexDist,
    arcApexY: curr.y + by * apexDist,
    handleX: curr.x + bx * handleDist,
    handleY: curr.y + by * handleDist
  };
}

/**
 * 根据指针在拐角内侧角平分线上的拖拽坐标反推目标圆角半径，使圆弧顶点实时跟随鼠标。
 */
export function radiusFromCornerHandleDrag(
  prev: { x: number; y: number },
  curr: { x: number; y: number },
  next: { x: number; y: number },
  pointer: { x: number; y: number }
): number {
  const info = computeCornerHandleInfo(prev, curr, next, 0, 0);
  if (!info) return 0;
  const dx = pointer.x - curr.x;
  const dy = pointer.y - curr.y;
  const proj = dx * info.bisectorX + dy * info.bisectorY;
  if (proj <= 2) return 0;
  const sinHalf = Math.sin(info.theta / 2);
  const denom = Math.max(0.08, 1 / Math.max(EPS, sinHalf) - 1);
  const rawRadius = proj / denom;
  return Math.round(Math.max(0, Math.min(info.maxRadius, rawRadius)));
}

// 扁平数组兼容版，供只需统一圆角半径的调用点使用。
export function roundLineFlat(flat: number[], radius: number, angleThresholdDeg = 6): number[] {
  if (radius <= 0 || flat.length < 6) return flat;
  const pts: RPoint[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  const rounded = roundCorners(pts, radius, angleThresholdDeg);
  const result: number[] = [];
  for (const p of rounded) result.push(p.x, p.y);
  return result;
}

export function rPointsToFlat(pts: Array<{ x: number; y: number }>): number[] {
  const result = new Array<number>(pts.length * 2);
  for (let i = 0; i < pts.length; i += 1) {
    result[i * 2] = pts[i].x;
    result[i * 2 + 1] = pts[i].y;
  }
  return result;
}

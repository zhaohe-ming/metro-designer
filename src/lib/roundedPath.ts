// 折线圆角：把折线的内部拐点替换成固定半径的圆弧（端点保持不动），返回更密的折线点。
// 抽成无副作用纯函数，供画布（Konva <Line points>）和将来的视频导出共用同一份几何，
// 保证两端视觉一致（项目一贯的"几何/渲染分离"原则）。
//
// 设计要点：
// - 半径会被夹到"相邻两段各自一半"以内 → 相邻拐角的圆弧不会互相重叠 / 回勾
//   （这是 naive 固定半径最容易出 bug 的地方）。
// - 拐角偏离直线小于 angleThresholdDeg 时当直线处理，不圆。
// - 因为只圆"内部拐点"、端点不动：把一个 section 的 [起点站, ...途经点, 终点站]
//   喂进来，自然只会圆途经点，站点（端点）保持尖角。

export interface RPoint {
  x: number;
  y: number;
}

const EPS = 1e-6;

export function roundCorners(points: RPoint[], radius: number, angleThresholdDeg = 10): RPoint[] {
  if (radius <= 0 || points.length < 3) return points.slice();

  const out: RPoint[] = [points[0]];

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    // 从拐点指向两侧邻点的向量
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < EPS || len2 < EPS) {
      out.push(curr);
      continue;
    }

    const u1x = v1x / len1;
    const u1y = v1y / len1;
    const u2x = v2x / len2;
    const u2y = v2y / len2;

    // 两臂夹角 theta（0..PI）：dot = cos(theta)
    const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
    const theta = Math.acos(dot);
    const turnDeg = 180 - (theta * 180) / Math.PI; // 偏离直线的角度
    if (turnDeg < angleThresholdDeg) {
      out.push(curr);
      continue;
    }

    const half = theta / 2;
    const tanHalf = Math.tan(half);
    // 为达到目标半径，沿每条臂回退的切点距离 t = r / tan(theta/2)
    let t = tanHalf > EPS ? radius / tanHalf : radius;
    // 夹紧：不超过相邻两段各自一半，避免相邻圆弧重叠
    t = Math.min(t, len1 / 2, len2 / 2);
    const rEff = t * tanHalf; // 夹紧后的实际半径
    if (rEff < 1e-3) {
      out.push(curr);
      continue;
    }

    // 两个切点
    const p1 = { x: curr.x + u1x * t, y: curr.y + u1y * t };
    const p2 = { x: curr.x + u2x * t, y: curr.y + u2y * t };

    // 圆心在内角平分线上，离拐点 dc = rEff / sin(theta/2)
    let bx = u1x + u2x;
    let by = u1y + u2y;
    const blen = Math.hypot(bx, by);
    if (blen < EPS) {
      out.push(curr);
      continue;
    }
    bx /= blen;
    by /= blen;
    const dc = rEff / Math.sin(half);
    const cx = curr.x + bx * dc;
    const cy = curr.y + by * dc;

    // 在 p1 → p2 之间按短弧采样
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const a2 = Math.atan2(p2.y - cy, p2.x - cx);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 16))); // ≈ 每 11° 一个采样点
    for (let k = 0; k <= steps; k += 1) {
      const a = a1 + delta * (k / steps);
      out.push({ x: cx + rEff * Math.cos(a), y: cy + rEff * Math.sin(a) });
    }
  }

  out.push(points[points.length - 1]);
  return out;
}

// 扁平数组版，给 Konva 的 <Line points={[x0,y0,x1,y1,...]}> 直接用。
export function roundLineFlat(flat: number[], radius: number, angleThresholdDeg = 10): number[] {
  if (radius <= 0 || flat.length < 6) return flat;
  const pts: RPoint[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  const rounded = roundCorners(pts, radius, angleThresholdDeg);
  const result: number[] = [];
  for (const p of rounded) result.push(p.x, p.y);
  return result;
}

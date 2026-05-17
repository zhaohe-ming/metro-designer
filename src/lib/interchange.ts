// 换乘站绘制的几何计算 —— Canvas（Konva）和 exportVideo（Canvas 2D）共用。
// 不做实际绘制，只算"该画几个扇形 / 弧段 / 弧形箭头、起止角度、半径"。
//
// 角度约定：0 度 = 正右方（3 点钟），角度沿顺时针递增（与 Konva.Arc.rotation 一致；
// Canvas 2D 的 arc() 同样：4th 参数 false = 顺时针）。多线分布从 -90 度（12 点钟）开始顺时针展开。

import { InterchangeShape } from '../stylePresets';

export type Sector = {
  /** 顺时针角度起点（degrees，0=右） */
  startDeg: number;
  /** 扇形/弧段跨过的角度（degrees） */
  sweepDeg: number;
  /** 该扇形对应的线路颜色 */
  color: string;
};

/**
 * 按线路数等分一圈，给每条线分一个扇形/弧段（用于 lineColorArcs 等需要全周覆盖的形状）。
 */
export function computeEqualSectors(lineColors: string[]): Sector[] {
  if (lineColors.length === 0) return [];
  const sweep = 360 / lineColors.length;
  const start = -90;
  return lineColors.map((color, i) => ({
    startDeg: start + i * sweep,
    sweepDeg: sweep,
    color
  }));
}

/**
 * 弧形箭头规划（curvedArrows 形状）。每条线一个"refresh icon 风"的箭头，
 * 沿整圆等分，每个槽位包含：弧形箭体 + 箭头三角形 + 槽间小间隙
 *
 * 返回的每个 arrow：
 *  - bodyStartDeg / bodySweepDeg: 弧形箭体的角度起止
 *  - tipDeg:                       箭头三角形尖端的角度位置（箭体末端再前推 arrowheadDeg）
 *  - color
 */
export type CurvedArrowPlan = {
  bodyStartDeg: number;
  bodySweepDeg: number;
  tipDeg: number;
  color: string;
};

export function planCurvedArrows(lineColors: string[]): CurvedArrowPlan[] {
  const n = lineColors.length;
  if (n === 0) return [];
  const slotDeg = 360 / n;
  // 箭头三角形吃掉的角度：N 小时大一点，N 大时收缩；上限 22°
  const arrowheadDeg = Math.min(22, slotDeg * 0.32);
  // 箭头之间的小空气间隙
  const gapDeg = Math.min(10, slotDeg * 0.12);
  const bodySweepDeg = Math.max(0, slotDeg - arrowheadDeg - gapDeg);
  return lineColors.map((color, i) => {
    const bodyStartDeg = -90 + i * slotDeg + gapDeg / 2;
    return {
      bodyStartDeg,
      bodySweepDeg,
      tipDeg: bodyStartDeg + bodySweepDeg + arrowheadDeg,
      color
    };
  });
}

/**
 * 给某个弧形箭头构造 SVG path data（Konva <Path> 可直接吃）。
 * 形状：以 (cx, cy) 为圆心，外径 outerR、内径 innerR 之间的环带，
 *   起点在 bodyStartDeg 的内径位置，沿内径顺时针扫到 bodyEndDeg，
 *   然后斜向外划到尖端（位于 tipDeg、中径位置），
 *   再回到 bodyEndDeg 的外径，沿外径逆时针回到 bodyStartDeg 的外径，
 *   闭合即得到"弧形箭头"。
 */
export function buildCurvedArrowPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  plan: CurvedArrowPlan
): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const pt = (radius: number, deg: number): [number, number] => [
    cx + radius * Math.cos(toRad(deg)),
    cy + radius * Math.sin(toRad(deg))
  ];

  const bodyEndDeg = plan.bodyStartDeg + plan.bodySweepDeg;
  const midR = (innerR + outerR) / 2;

  const [sIx, sIy] = pt(innerR, plan.bodyStartDeg);
  const [eIx, eIy] = pt(innerR, bodyEndDeg);
  const [eOx, eOy] = pt(outerR, bodyEndDeg);
  const [sOx, sOy] = pt(outerR, plan.bodyStartDeg);
  const [tipX, tipY] = pt(midR, plan.tipDeg);

  // 单条线（N=1）就不画这个，外面会兜底，不可能 sweep > 180
  const largeArc = plan.bodySweepDeg > 180 ? 1 : 0;

  // SVG 弧命令：A rx ry x-rot large-arc sweep x y
  // sweep=1 顺时针（屏幕坐标），sweep=0 逆时针
  return [
    `M ${sIx.toFixed(2)} ${sIy.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 1 ${eIx.toFixed(2)} ${eIy.toFixed(2)}`,
    `L ${tipX.toFixed(2)} ${tipY.toFixed(2)}`,
    `L ${eOx.toFixed(2)} ${eOy.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 0 ${sOx.toFixed(2)} ${sOy.toFixed(2)}`,
    'Z'
  ].join(' ');
}

/**
 * Canvas 2D 版本：直接在 ctx 上 fill 一条弧形箭头。
 * 用于视频导出 —— 因为 Canvas 2D 没有 SVG path 字符串，必须 stroke / arc 拼出来。
 */
export function fillCurvedArrowCanvas2d(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  plan: CurvedArrowPlan
) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const bodyEndDeg = plan.bodyStartDeg + plan.bodySweepDeg;
  const midR = (innerR + outerR) / 2;

  ctx.fillStyle = plan.color;
  ctx.beginPath();
  // 内径上的顺时针弧（false = 顺时针）
  ctx.arc(cx, cy, innerR, toRad(plan.bodyStartDeg), toRad(bodyEndDeg), false);
  // 斜向外到箭头尖端（中径位置）
  ctx.lineTo(
    cx + midR * Math.cos(toRad(plan.tipDeg)),
    cy + midR * Math.sin(toRad(plan.tipDeg))
  );
  // 回到外径末端
  ctx.lineTo(
    cx + outerR * Math.cos(toRad(bodyEndDeg)),
    cy + outerR * Math.sin(toRad(bodyEndDeg))
  );
  // 外径上的逆时针弧回到起点
  ctx.arc(cx, cy, outerR, toRad(bodyEndDeg), toRad(plan.bodyStartDeg), true);
  ctx.closePath();
  ctx.fill();
}

/** 给定一个 InterchangeShape，告诉 caller 该画什么层次的元素。 */
export type InterchangePlan = {
  shape: InterchangeShape;
  /** 外圈描边颜色提示 */
  outerStroke: 'dark' | 'lineColor' | 'none';
  /** 等分扇形/弧段（用于 lineColorArcs；curvedArrows 不用这个，用 curvedArrows 字段） */
  sectors: Sector[];
  /** 弧形箭头规划（用于 curvedArrows） */
  curvedArrows: CurvedArrowPlan[];
};

export function planInterchange(
  shape: InterchangeShape,
  outerStroke: 'dark' | 'lineColor' | 'none',
  lineColors: string[]
): InterchangePlan {
  return {
    shape,
    outerStroke,
    sectors: shape === 'lineColorArcs' ? computeEqualSectors(lineColors) : [],
    curvedArrows: shape === 'curvedArrows' ? planCurvedArrows(lineColors) : []
  };
}

/** 把度数换成弧度（Canvas 2D 用） */
export const degToRad = (deg: number) => (deg * Math.PI) / 180;

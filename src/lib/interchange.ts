// 换乘站绘制的几何计算 —— Canvas（Konva）和 exportVideo（Canvas 2D）共用。
// 不做实际绘制，只算"该画几个扇形 / 弧段、起止角度、半径"。
//
// 共同的角度约定：
//  - 0 度 = 正右方（3 点钟方向）
//  - 角度沿顺时针递增（与 Konva.Arc.rotation 一致；Canvas 2D 的 arc() 也是 CW + 弧度）
//  - 多线扇形 / 弧段从 -90 度（12 点钟）开始，按 lines 数组顺序顺时针展开

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
 * 按线路数等分一圈，给每条线分一个扇形/弧段。
 * 从 12 点位置开始顺时针展开，让视觉对称感最强。
 *
 * @param lineColors 该换乘站经过的线路颜色，order 决定扇形顺序（用 lines.indexOf 维持稳定）
 */
export function computeEqualSectors(lineColors: string[]): Sector[] {
  if (lineColors.length === 0) return [];
  const sweep = 360 / lineColors.length;
  // 12 点位置 = -90°（Konva 的 rotation 是 deg，0=右；-90=上）
  const start = -90;
  return lineColors.map((color, i) => ({
    startDeg: start + i * sweep,
    sweepDeg: sweep,
    color
  }));
}

/**
 * 给定一个 InterchangeShape，告诉 caller 该画什么层次的元素。
 * caller 自己决定用什么图形库（Konva / Canvas 2D）实际画。
 */
export type InterchangePlan = {
  shape: InterchangeShape;
  /** 外圈描边的颜色提示：'dark' = 用画布主题对比色；'lineColor' = 用第一条线的颜色；'none' = 不描边 */
  outerStroke: 'dark' | 'lineColor' | 'none';
  /** 等分扇形（仅 pie / lineColorArcs 时有意义；concentricRing 不用） */
  sectors: Sector[];
};

export function planInterchange(
  shape: InterchangeShape,
  outerStroke: 'dark' | 'lineColor' | 'none',
  lineColors: string[]
): InterchangePlan {
  return {
    shape,
    outerStroke,
    sectors: computeEqualSectors(lineColors)
  };
}

/** 把度数换成弧度（Canvas 2D 用） */
export const degToRad = (deg: number) => (deg * Math.PI) / 180;

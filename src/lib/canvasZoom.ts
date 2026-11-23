import { LabelDensity } from '../types';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * 高德地理模式统一基准缩放级别（约城区轨道线网总览尺度，~40m/px）。
 * 所有地理模式下的元素尺寸仅由 (density, zoom) 纯函数决定，杜绝跨地图或刷新前后的随机锚点漂移。
 */
export const AMAP_REFERENCE_ZOOM = 11.8;

export interface VisualScales {
  /** 站点圆点、换乘站环、途经点控制柄缩放系数 */
  dotScale: number;
  /** 线路描边宽度与共线平行偏移缩放系数 */
  strokeScale: number;
  /** 站名文字与避让包围盒缩放系数 */
  labelScale: number;
  /** 线路首末站胶囊铭牌（如“1号线”）缩放系数 */
  pillScale: number;
  /** 当前视野是否处于缩远密集态（允许在 8 向候选全部硬碰撞时隐藏低优先级 T1 标签，防止文字叠字） */
  allowTier1OverlapCull: boolean;
}

/**
 * 纯画布模式元素补偿缩放：与实时滚轮手势（liveElementScaleRatio）共享同一公式，保证缩放落停零跳变。
 * - paper: 严格跟随世界坐标（返回 1）
 * - adaptive / key: 在 [0.54, 1.82] 常用缩放区间内保持屏幕字号恒定可读，极端缩远/放大时平滑限幅
 */
export function plainCanvasElementScale(density: LabelDensity, viewportScale: number): number {
  const safeScale = Math.max(viewportScale, 0.0001);
  return density === 'paper' ? 1 : clamp(1 / safeScale, 0.55, 1.85);
}

export function liveElementScaleRatio(
  density: LabelDensity,
  viewportScale: number,
  renderedElementScale: number
): number {
  return plainCanvasElementScale(density, viewportScale) / Math.max(renderedElementScale, 0.0001);
}

/**
 * 高德底图模式下的分层视觉缩放曲线：
 * - 圆点与线宽在缩远至都市圈尺度（zoom 9~10.5）时显著收窄，消除密集设站串珠重叠；
 * - 站名字号保留可读下限（约 0.76×），配合碰撞裁剪实现“缩远疏朗、放大精细”；
 * - 线路名胶囊采用更克制的斜率，避免在缩远视野中喧宾夺主。
 */
export function computeAmapVisualScales(density: LabelDensity, zoom: number): VisualScales {
  const safeZoom = Number.isFinite(zoom) ? zoom : AMAP_REFERENCE_ZOOM;
  const dz = safeZoom - AMAP_REFERENCE_ZOOM;

  if (density === 'paper') {
    return {
      dotScale: clamp(Math.pow(1.3, dz), 0.44, 1.55),
      strokeScale: clamp(Math.pow(1.26, dz), 0.5, 1.5),
      labelScale: clamp(Math.pow(1.18, dz), 0.76, 1.38),
      pillScale: clamp(Math.pow(1.15, dz), 0.72, 1.25),
      allowTier1OverlapCull: safeZoom < 12.6
    };
  }

  return {
    dotScale: clamp(Math.pow(1.22, dz), 0.52, 1.32),
    strokeScale: clamp(Math.pow(1.18, dz), 0.58, 1.3),
    labelScale: clamp(Math.pow(1.1, dz), 0.82, 1.18),
    pillScale: clamp(Math.pow(1.13, dz), 0.74, 1.15),
    allowTier1OverlapCull: safeZoom < 12.6
  };
}

export function computePlainVisualScales(density: LabelDensity, viewportScale: number): VisualScales {
  const elementScale = plainCanvasElementScale(density, viewportScale);
  return {
    dotScale: elementScale,
    strokeScale: elementScale,
    labelScale: elementScale,
    pillScale: elementScale,
    allowTier1OverlapCull: viewportScale < 0.85
  };
}

/**
 * 估算中英文混排单行文本像素宽度，避免粗体中文/字母混排因低估宽度导致 Konva Text 折行或碰撞漏检。
 */
export function estimateSingleLineTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x2e7f) {
      units += 1.04;
    } else if ((code >= 65 && code <= 90) || code === 87 || code === 77) {
      units += 0.68;
    } else {
      units += 0.58;
    }
  }
  return units * fontSize;
}

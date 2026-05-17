import { CityStyle, MapSettings } from './types';

// 换乘站的"结构外形"——这是 4 个预设之间真正拉开视觉差异的关键。
// 之前所有预设都用同一个 "外圆 + 当前线色实心" 的画法，只差几像素，所以怎么切都长得像。
// 现在每个预设走完全不同的结构：
//  - pie:             外圈细深环 + 内部按线路色等分扇形（默认现代风）
//  - lineColorArcs:   大白圆 + 周长按线路色分弧段（经典北京 / 老地铁图风）
//  - concentricRing:  黑色双圆环 + 白心、不显示线路色（上海 / 上海粗体风）
export type InterchangeShape = 'pie' | 'lineColorArcs' | 'concentricRing';

// 普通站点（非换乘）的画法：
//  - dot:   线路色实心圆 + 浅色描边（视觉清晰）
//  - ring:  白色实心 + 线路色描边圆（经典图册风，跟线路色弧段呼应）
export type StationShape = 'dot' | 'ring';

export type CityStylePreset = {
  id: CityStyle;
  label: string;
  lineWidth: number;
  lineShadowBlur: number;
  lineShadowOpacity: number;
  normalStationRadius: number;
  normalStationStrokeWidth: number;
  interchangeRadius: number;
  interchangeInnerRadius: number;
  interchangeStrokeWidth: number;
  interchangeShape: InterchangeShape;
  stationShape: StationShape;
  // 换乘站的外圈描边颜色——靠它把多线身份与线条衬开
  // 'dark' 时根据画布主题动态切（浅画布 ≈ slate-900，深画布 ≈ slate-50）
  interchangeOuterStroke: 'dark' | 'lineColor' | 'none';
  lineLabelFontSize: number;
  lineLabelFontWeight: number;
  lineLabelPaddingX: number;
  lineLabelPaddingY: number;
  lineLabelFill: string;
  lineLabelText: string;
  lineLabelStrokeWidth: number;
};

export const CITY_STYLE_PRESETS: Record<CityStyle, CityStylePreset> = {
  // ──── 现代（原"通用专业"）：clean schematic 风 ────
  // 换乘站 = 按线路色等分扇形 + 外圈细深环
  // 普通站 = 线路色实心圆
  standard: {
    id: 'standard',
    label: '现代',
    lineWidth: 4,
    lineShadowBlur: 7,
    lineShadowOpacity: 0.26,
    normalStationRadius: 6,
    normalStationStrokeWidth: 2,
    interchangeRadius: 10,
    interchangeInnerRadius: 0,
    interchangeStrokeWidth: 2,
    interchangeShape: 'pie',
    stationShape: 'dot',
    interchangeOuterStroke: 'dark',
    lineLabelFontSize: 12,
    lineLabelFontWeight: 700,
    lineLabelPaddingX: 8,
    lineLabelPaddingY: 4,
    lineLabelFill: '#ffffff',
    lineLabelText: '#0f172a',
    lineLabelStrokeWidth: 2
  },
  // ──── 经典（原"北京"）：传统地铁图册风 ────
  // 换乘站 = 大白圆 + 周长上的线路色弧段
  // 普通站 = 白填充 + 线路色描边圆
  beijing: {
    id: 'beijing',
    label: '经典',
    lineWidth: 5,
    lineShadowBlur: 4,
    lineShadowOpacity: 0.18,
    normalStationRadius: 5,
    normalStationStrokeWidth: 2.5,
    interchangeRadius: 12,
    interchangeInnerRadius: 6,
    interchangeStrokeWidth: 3.5,
    interchangeShape: 'lineColorArcs',
    stationShape: 'ring',
    interchangeOuterStroke: 'lineColor',
    lineLabelFontSize: 12,
    lineLabelFontWeight: 800,
    lineLabelPaddingX: 9,
    lineLabelPaddingY: 4,
    lineLabelFill: '#ffffff',
    lineLabelText: '#111827',
    lineLabelStrokeWidth: 2
  },
  // ──── 粗体（原"上海"）：上海现行风 ────
  // 换乘站 = 黑色双圆环（外粗内细 + 白心），不显示线路色 —— 靠线条颜色穿入识别
  // 普通站 = 线路色实心点
  shanghai: {
    id: 'shanghai',
    label: '粗体',
    lineWidth: 5,
    lineShadowBlur: 3,
    lineShadowOpacity: 0.14,
    normalStationRadius: 5,
    normalStationStrokeWidth: 2,
    interchangeRadius: 11,
    interchangeInnerRadius: 5,
    interchangeStrokeWidth: 3,
    interchangeShape: 'concentricRing',
    stationShape: 'dot',
    interchangeOuterStroke: 'dark',
    lineLabelFontSize: 12,
    lineLabelFontWeight: 700,
    lineLabelPaddingX: 8,
    lineLabelPaddingY: 3,
    lineLabelFill: '#ffffff',
    lineLabelText: '#172033',
    lineLabelStrokeWidth: 1.5
  },
  // ──── 管道（原"港铁"）：tube map 风 ────
  // 换乘站 = 大白圆 + 内部按线路色等分扇形（视觉重头戏），外圈深色加粗
  // 普通站 = 线路色实心圆 + 白色细描边
  mtr: {
    id: 'mtr',
    label: '管道',
    lineWidth: 7,
    lineShadowBlur: 5,
    lineShadowOpacity: 0.2,
    normalStationRadius: 5.5,
    normalStationStrokeWidth: 2,
    interchangeRadius: 12,
    interchangeInnerRadius: 0,
    interchangeStrokeWidth: 3,
    interchangeShape: 'pie',
    stationShape: 'dot',
    interchangeOuterStroke: 'dark',
    lineLabelFontSize: 12,
    lineLabelFontWeight: 800,
    lineLabelPaddingX: 10,
    lineLabelPaddingY: 4,
    lineLabelFill: '#ffffff',
    lineLabelText: '#0b1220',
    lineLabelStrokeWidth: 2
  }
};

export const getCityStylePreset = (settings: Pick<MapSettings, 'cityStyle'>) =>
  CITY_STYLE_PRESETS[settings.cityStyle] || CITY_STYLE_PRESETS.standard;

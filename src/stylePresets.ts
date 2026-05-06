import { CityStyle, MapSettings } from './types';

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
  lineLabelFontSize: number;
  lineLabelFontWeight: number;
  lineLabelPaddingX: number;
  lineLabelPaddingY: number;
  lineLabelFill: string;
  lineLabelText: string;
  lineLabelStrokeWidth: number;
};

export const CITY_STYLE_PRESETS: Record<CityStyle, CityStylePreset> = {
  standard: {
    id: 'standard',
    label: '通用专业',
    lineWidth: 4,
    lineShadowBlur: 7,
    lineShadowOpacity: 0.26,
    normalStationRadius: 6,
    normalStationStrokeWidth: 2,
    interchangeRadius: 9,
    interchangeInnerRadius: 4,
    interchangeStrokeWidth: 3,
    lineLabelFontSize: 12,
    lineLabelFontWeight: 700,
    lineLabelPaddingX: 8,
    lineLabelPaddingY: 4,
    lineLabelFill: '#ffffff',
    lineLabelText: '#0f172a',
    lineLabelStrokeWidth: 2
  },
  beijing: {
    id: 'beijing',
    label: '北京',
    lineWidth: 5,
    lineShadowBlur: 4,
    lineShadowOpacity: 0.18,
    normalStationRadius: 5,
    normalStationStrokeWidth: 2,
    interchangeRadius: 11,
    interchangeInnerRadius: 5,
    interchangeStrokeWidth: 3,
    lineLabelFontSize: 12,
    lineLabelFontWeight: 800,
    lineLabelPaddingX: 9,
    lineLabelPaddingY: 4,
    lineLabelFill: '#ffffff',
    lineLabelText: '#111827',
    lineLabelStrokeWidth: 2
  },
  shanghai: {
    id: 'shanghai',
    label: '上海',
    lineWidth: 4,
    lineShadowBlur: 3,
    lineShadowOpacity: 0.14,
    normalStationRadius: 4.5,
    normalStationStrokeWidth: 2,
    interchangeRadius: 10,
    interchangeInnerRadius: 4,
    interchangeStrokeWidth: 2.5,
    lineLabelFontSize: 11,
    lineLabelFontWeight: 700,
    lineLabelPaddingX: 8,
    lineLabelPaddingY: 3,
    lineLabelFill: '#ffffff',
    lineLabelText: '#172033',
    lineLabelStrokeWidth: 1.5
  },
  mtr: {
    id: 'mtr',
    label: '港铁',
    lineWidth: 6,
    lineShadowBlur: 5,
    lineShadowOpacity: 0.2,
    normalStationRadius: 5,
    normalStationStrokeWidth: 2,
    interchangeRadius: 12,
    interchangeInnerRadius: 5,
    interchangeStrokeWidth: 3,
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

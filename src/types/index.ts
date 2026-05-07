export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
  lng?: number;
  lat?: number;
  note?: string;
  labelPosition?: 'auto' | 'top' | 'right' | 'bottom' | 'left' | 'hidden';
}

export interface Section {
  id: string;
  lineId: string;
  startStationId: string;
  endStationId: string;
}

export interface Line {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
  sectionIds: string[];
  lastAddedStationId?: string;
}

export type MapStyle = 'classic-badge' | 'dot-label';
export type CanvasTheme = 'light' | 'dark';
export type CityStyle = 'standard' | 'beijing' | 'shanghai' | 'mtr';
export type DotLabelStyle = {
  fontSize: number;
  fontWeight: number;
  color: string;
};
export type BaseMapMode = 'plain' | 'amap';
export type AmapStyle = 'normal' | 'dark' | 'grey' | 'fresh';
export type AmapBaseMapSettings = {
  center: [number, number];
  zoom: number;
  style: AmapStyle;
};
export type BaseMapSettings = {
  mode: BaseMapMode;
  amap?: AmapBaseMapSettings;
};

export interface MapSettings {
  mapStyle: MapStyle;
  canvasTheme: CanvasTheme;
  cityStyle: CityStyle;
  showLineNameLabels: boolean;
  dotLabelStyle: DotLabelStyle;
  baseMap: BaseMapSettings;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  mapStyle: 'classic-badge',
  canvasTheme: 'light',
  cityStyle: 'standard',
  showLineNameLabels: true,
  dotLabelStyle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a'
  },
  baseMap: {
    mode: 'plain',
    amap: {
      center: [116.397428, 39.90923],
      zoom: 11,
      style: 'normal'
    }
  }
};

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numberValue));
};

export const normalizeMapSettings = (settings?: Partial<MapSettings> | null): MapSettings => {
  const dotLabelStyle = (settings?.dotLabelStyle || {}) as Partial<DotLabelStyle>;
  const baseMap = (settings?.baseMap || {}) as Partial<BaseMapSettings>;
  const amap = (baseMap.amap || {}) as Partial<AmapBaseMapSettings>;
  const cityStyle =
    settings?.cityStyle === 'beijing' ||
    settings?.cityStyle === 'shanghai' ||
    settings?.cityStyle === 'mtr'
      ? settings.cityStyle
      : 'standard';
  return {
    mapStyle: settings?.mapStyle === 'dot-label' ? 'dot-label' : 'classic-badge',
    canvasTheme: settings?.canvasTheme === 'dark' ? 'dark' : 'light',
    cityStyle,
    showLineNameLabels: settings?.showLineNameLabels !== false,
    dotLabelStyle: {
      fontSize: normalizeNumber(dotLabelStyle.fontSize, DEFAULT_MAP_SETTINGS.dotLabelStyle.fontSize, 10, 24),
      fontWeight: normalizeNumber(dotLabelStyle.fontWeight, DEFAULT_MAP_SETTINGS.dotLabelStyle.fontWeight, 300, 900),
      color:
        typeof dotLabelStyle.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(dotLabelStyle.color)
          ? dotLabelStyle.color
          : DEFAULT_MAP_SETTINGS.dotLabelStyle.color
    },
    baseMap: {
      mode: baseMap.mode === 'amap' ? 'amap' : 'plain',
      amap: {
        center:
          Array.isArray(amap.center) &&
          amap.center.length === 2 &&
          amap.center.every(value => typeof value === 'number' && Number.isFinite(value))
            ? [amap.center[0], amap.center[1]]
            : DEFAULT_MAP_SETTINGS.baseMap.amap!.center,
        zoom: normalizeNumber(amap.zoom, DEFAULT_MAP_SETTINGS.baseMap.amap!.zoom, 3, 20),
        style:
          amap.style === 'dark' || amap.style === 'grey' || amap.style === 'fresh'
            ? amap.style
            : 'normal'
      }
    }
  };
};

export const LINE_COLORS = [
  '#1890ff',
  '#f5222d',
  '#52c41a',
  '#faad14',
  '#722ed1',
  '#13c2c2',
  '#eb2f96',
  '#fa8c16'
];

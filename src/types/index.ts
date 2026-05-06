export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
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

export interface MapSettings {
  mapStyle: MapStyle;
  canvasTheme: CanvasTheme;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  mapStyle: 'classic-badge',
  canvasTheme: 'light'
};

export const normalizeMapSettings = (settings?: Partial<MapSettings> | null): MapSettings => ({
  mapStyle: settings?.mapStyle === 'dot-label' ? 'dot-label' : 'classic-badge',
  canvasTheme: settings?.canvasTheme === 'dark' ? 'dark' : 'light'
});

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

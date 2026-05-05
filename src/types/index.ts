export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
  note?: string;
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

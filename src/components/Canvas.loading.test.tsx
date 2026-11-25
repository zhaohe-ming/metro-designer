import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import Canvas from './Canvas';
import { DEFAULT_MAP_SETTINGS } from '../types';

let mockGroupProps: any[] = [];
let mockReadyDocument: string | null = null;
let mockError = '';
const mockProject = jest.fn(([lng, lat]: number[]) => ({ x: (lng - 117) * 1000, y: (39.5 - lat) * 1000 }));
const mockUnproject = jest.fn(({ x, y }: { x: number; y: number }) => ({
  lng: Number((117 + x / 1000).toFixed(6)),
  lat: Number((39.5 - y / 1000).toFixed(6))
}));
jest.mock('../lib/useAmapViewport', () => ({ useAmapViewport: (options: any) => ({
  mapRef: { current: { lngLatToContainer: mockProject, containerToLngLat: mockUnproject, getZoom: () => 12 } },
  ready: options.documentKey === mockReadyDocument, error: mockError, renderTick: 0
}) }));
jest.mock('../lib/useElasticToolbar', () => ({ useElasticToolbar: () => require('react').useRef(null) }));
jest.mock('konva', () => ({ hitOnDragEnabled: false }));
jest.mock('./DraggableModal', () => ({open,children,title}:any) => open?require('react').createElement('section',{'data-modal':title},children):null);
jest.mock('./MobileViewControls', () => () => null);
jest.mock('./CanvasStartPrompt', () => () => null);
jest.mock('antd', () => {
  const React = require('react');
  const pass = ({ children }: any) => React.createElement('div', null, children);
  const Input = Object.assign(pass, { TextArea: pass });
  return { Input, Button: pass, message: {}, ColorPicker: pass, Select: pass, Dropdown: pass, Tooltip: pass, Spin: pass, Slider: pass };
});
jest.mock('react-konva', () => {
  const React = require('react');
  const node = (kind: string) => React.forwardRef((props:any, _ref:any) => {if(kind==='group')mockGroupProps.push(props);return React.createElement('div', { 'data-node': kind }, props.children);});
  const Stage = React.forwardRef(({ children, style }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({ scale() {}, position() {}, batchDraw() {}, find: () => [],
      x: () => 0, y: () => 0, scaleX: () => 1, scaleY: () => 1 }));
    return React.createElement('div', { 'data-testid': 'stage', style }, children);
  });
  return { Stage, Layer: node('layer'), Circle: node('circle'), Text: node('text'), Group: node('group'),
    Line: node('line'), Rect: node('rect'), Arc: node('arc'), Path: node('path') };
});
const stations = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), name: `站点${index}`,
  x: 9000 + index, y: 9000 + index, lng: 117 + index % 40 * 0.005, lat: 39 + Math.floor(index / 40) * 0.005 }));
const line = { id: 'l', name: '一号线', color: '#ef4444', stationIds: stations.map(station => station.id), sectionIds: [] };
const settings = { ...DEFAULT_MAP_SETTINGS, labelDensity: 'key' as const, showLineNameLabels: false,
  baseMap: { mode: 'amap' as const, amap: { center: [117.1, 39.1] as [number, number], zoom: 12, style: 'normal' as const } } };
let host: HTMLDivElement; let root: Root;
const render = (documentKey: string, extra: any = {}) => act(() => root.render(<Canvas currentLineId="l" lines={[line]}
  stations={stations} sections={[]} mapSettings={settings} documentKey={documentKey} {...extra} {...({} as any)} />));
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mockGroupProps=[];mockReadyDocument = null; mockError = '';
  mockProject.mockImplementation(([lng, lat]: number[]) => ({ x: (lng - 117) * 1000, y: (39.5 - lat) * 1000 }));
  mockUnproject.mockImplementation(({ x, y }: { x: number; y: number }) => ({
    lng: Number((117 + x / 1000).toFixed(6)),
    lat: Number((39.5 - y / 1000).toFixed(6))
  }));
  window.matchMedia = jest.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('1000 站加载期间没有坐标投影、旧图形或标签绘制', () => {
  render('a');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在加载地图与线网');
  expect(host.querySelectorAll('[data-node="circle"], [data-node="line"], [data-node="text"]')).toHaveLength(0);
  expect(mockProject).not.toHaveBeenCalled();
  expect((host.querySelector('[data-testid="stage"]') as HTMLElement).style.visibility).toBe('hidden');
  mockReadyDocument = 'a'; render('a');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelectorAll('[data-node="circle"]').length).toBeGreaterThanOrEqual(1000);
  expect(mockProject).toHaveBeenCalled();
});
test('切换存档的首帧不显示上一张地图的图形和标签', () => {
  mockReadyDocument = 'a'; render('a'); const calls = mockProject.mock.calls.length;
  render('b');
  expect(host.querySelectorAll('[data-node="circle"], [data-node="text"]')).toHaveLength(0);
  expect(mockProject.mock.calls.length).toBe(calls);
  mockReadyDocument = 'b'; render('b');
  expect(host.querySelectorAll('[data-node="circle"]').length).toBeGreaterThanOrEqual(1000);
});
test('底图失败及云端文档未返回时保持清晰加载态', () => {
  mockError = '测试底图错误'; render('a');
  expect(host.querySelector('[role="status"]')?.textContent).toBe('测试底图错误');
  expect(mockProject).not.toHaveBeenCalled();
  mockError = ''; mockReadyDocument = 'a'; render('a', { isDocumentLoading: true });
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(mockProject).not.toHaveBeenCalled();
});

test('公开预览保留导航与站点信息，同时关闭拖动编辑和保存标注', () => {
  const onUpdateStation=jest.fn();mockReadyDocument='public';
  render('public',{readOnly:true,stations:stations.slice(0,3),lines:[{...line,stationIds:['0','1','2']}],onUpdateStation});
  expect(host.querySelector('[data-active-tool]')?.getAttribute('data-active-tool')).toBe('pan');
  const station=mockGroupProps.find(props=>props.id==='0');expect(station).toBeDefined();expect(station.draggable).toBe(false);
  act(()=>station.onClick({evt:{button:0}}));
  expect(host.querySelector('[data-modal="站点信息"]')?.textContent).toContain('站点0');
  expect(host.querySelector('[data-modal="站点信息"]')?.textContent).toContain('暂无公开标注');
  expect(host.textContent).not.toContain('保存标注');expect(onUpdateStation).not.toHaveBeenCalled();
});


test('纯画布或轻城市线网切入地理底图后自动绑定经纬度，且轻城市编辑底图按钮可点击切换造景栏', () => {
  mockReadyDocument = 'convert';
  const plainStations = [
    { id: 's1', name: '起点', x: 320, y: 260 },
    { id: 's2', name: '终点', x: 560, y: 340 }
  ];
  const plainSections = [
    { id: 'sec1', lineId: 'l', startStationId: 's1', endStationId: 's2', waypoints: [{ x: 440, y: 280 }] }
  ];
  let capturedGraph: any = null;
  const onApplyGraphTransaction = jest.fn((updater: any) => {
    capturedGraph = updater({
      lines: [{ ...line, stationIds: ['s1', 's2'], sectionIds: ['sec1'] }],
      stations: plainStations,
      sections: plainSections
    });
  });

  render('convert', {
    stations: plainStations,
    sections: plainSections,
    lines: [{ ...line, stationIds: ['s1', 's2'], sectionIds: ['sec1'] }],
    onApplyGraphTransaction
  });

  expect(onApplyGraphTransaction).toHaveBeenCalled();
  expect(typeof capturedGraph.stations[0].lng).toBe('number');
  expect(typeof capturedGraph.stations[0].lat).toBe('number');
  expect(typeof capturedGraph.sections[0].waypoints[0].lng).toBe('number');
  expect(typeof capturedGraph.sections[0].waypoints[0].lat).toBe('number');

  act(() => {
    root.render(
      <Canvas
        currentLineId="l"
        lines={[{ ...line, stationIds: ['s1', 's2'], sectionIds: ['sec1'] }]}
        stations={plainStations as any}
        sections={plainSections as any}
        mapSettings={{
          ...DEFAULT_MAP_SETTINGS,
          baseMap: {
            mode: 'light-city',
            lightCity: {
              theme: 'paper-grey',
              archetype: 'river',
              seed: 100,
              opacity: 1,
              layerVisibility: { zones: true, water: true, roads: true, labels: true },
              features: []
            }
          }
        }}
        documentKey="lc"
        onAddStation={() => {}}
        onUpdateStation={() => {}}
        onAddStationToLine={() => {}}
        onRenameStation={() => {}}
        onDeleteSection={() => {}}
        onReorderStations={() => {}}
        onDeleteStation={() => {}}
      />
    );
  });

  const editBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('编辑底图'));
  expect(editBtn).toBeDefined();
  act(() => {
    editBtn!.click();
  });
  expect(host.textContent).toContain('正在造景');
  expect(host.textContent).toContain('完成造景');
});

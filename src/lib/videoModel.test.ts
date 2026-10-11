import { Line, Section, Station } from '../types';
import { activeVideoStationLines, buildVideoRouteGeometry, easeVideoProgress, mercatorProject,
  resolveVideoRoute, staticMapViewport, videoArrivalProgress, videoFrameAtTime, VideoSegmentInput } from './videoModel';

const stations: Station[] = [
  { id: 'a', name: '甲', x: 0, y: 0 },
  { id: 'b', name: '乙', x: 100, y: 100 },
  { id: 'c', name: '丙', x: 200, y: 100 }
];
const line: Line = { id: 'l', name: '一号线', color: '#f00', stationIds: ['a', 'b', 'c'], sectionIds: ['ab', 'bc'] };
const sections: Section[] = [
  { id: 'ab', lineId: 'l', startStationId: 'a', endStationId: 'b', waypoints: [{ x: 100, y: 0 }] },
  { id: 'bc', lineId: 'l', startStationId: 'b', endStationId: 'c' }
];
const segment: VideoSegmentInput = { id: '1', lineId: 'l', startStationId: 'a', endStationId: 'c', openDate: '2020-01-01' };
const stationById = new Map(stations.map(station => [station.id, station]));
const geometry = (input = segment, edges = sections, radius = 0) => buildVideoRouteGeometry(
  resolveVideoRoute(input, [line], stations, edges), stationById, point => ({ x: point.x, y: point.y }), radius
);

test('导出经过实际折点，站点到达距离不受采样点数量影响', () => {
  const path = geometry();
  expect(path.points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
  expect(path.stationDistances).toEqual([0, 200, 300]);
  const rounded = geometry(segment, sections, 20);
  expect(rounded.points.length).toBeGreaterThan(path.points.length);
  expect(rounded.points).not.toContainEqual({ x: 100, y: 0 });
  expect(rounded.stationDistances[1]).toBeGreaterThan(185);
  expect(rounded.stationDistances[1]).toBeLessThan(200);
  expect(rounded.stationDistances[2] - rounded.stationDistances[1]).toBeCloseTo(100);
});

test('反向播放保留折点与圆角，站点距离从反向起点计算', () => {
  const reverse = { ...segment, startStationId: 'c', endStationId: 'a' };
  expect(geometry(reverse).points).toEqual([...geometry().points].reverse());
  expect(geometry(reverse).stationDistances).toEqual([0, 100, 300]);
  expect(geometry(reverse, sections, 20).points).toEqual([...geometry(segment, sections, 20).points].reverse());
});

test('不能跨过未连接的站点；分支路径从真实区间寻找', () => {
  expect(() => geometry(segment, sections.slice(0, 1))).toThrow('找不到视频路径');
  const branches = [sections[0], { id: 'ac', lineId: 'l', startStationId: 'a', endStationId: 'c' }];
  expect(resolveVideoRoute(segment, [line], stations, branches).stationIds).toEqual(['a', 'c']);
});

test('拒绝不存在的日期和重合区间', () => {
  expect(() => geometry({ ...segment, openDate: '2023-02-29' })).toThrow('配置无效');
  expect(() => geometry({ ...segment, openDate: '2024-02-29' })).not.toThrow();
  expect(() => geometry({ ...segment, endStationId: 'a' })).toThrow('配置无效');
});

test.each([60, 120, 144])('%iHz 回调不能缩短 10 秒动画', refreshRate => {
  let doneAt = 0;
  for (let tick = 0; tick <= refreshRate * 11; tick += 1) {
    const elapsed = tick * 1000 / refreshRate;
    const result = videoFrameAtTime(elapsed, 30, 300);
    expect(result.frame).toBeLessThanOrEqual(Math.floor(elapsed * 30 / 1000));
    if (result.done) { doneAt = elapsed; break; }
  }
  expect(doneAt).toBeGreaterThanOrEqual(10000);
  expect(doneAt).toBeLessThan(10000 + 1000 / refreshRate + 1);
  expect(videoFrameAtTime(4200, 30, 300)).toEqual({ frame: 126, done: false });
});

test('站名到达时间与缓动后的线路距离相同', () => {
  [0, 0.1, 0.25, 0.5, 0.8, 1].forEach(distance => {
    expect(easeVideoProgress(videoArrivalProgress(distance))).toBeCloseTo(distance, 10);
  });
});

test('换乘关系按开通区间去重，不显示未来线路', () => {
  const opened = [{ line, stationIds: ['a', 'b'] }, { line, stationIds: ['b'] }];
  const future = { line: { ...line, id: 'future' }, stationIds: ['c', 'b'], stationDistances: [0, 100] };
  expect(Array.from(activeVideoStationLines(opened).get('b')!)).toEqual(['l']);
  expect(Array.from(activeVideoStationLines(opened, future, 99).get('b')!)).toEqual(['l']);
  expect(Array.from(activeVideoStationLines(opened, future, 100).get('b')!)).toEqual(['l', 'future']);
});

test.each([[1920, 1080], [1080, 1920], [1920, 1920]])('底图 %ix%i 保持宽高比和一致的投影比例', (width, height) => {
  const viewport = staticMapViewport(width, height, 11.6);
  expect(viewport.width).toBeLessThanOrEqual(1024);
  expect(viewport.height).toBeLessThanOrEqual(1024);
  expect(viewport.width / viewport.height).toBeCloseTo(width / height);
  expect(viewport.zoom).toBe(12);
  const center = mercatorProject(116.4, 39.9, viewport.zoom);
  const station = mercatorProject(116.5, 40, viewport.zoom);
  const imagePixelX = viewport.width / 2 + station.x - center.x;
  const overlayPixelX = width / 2 + (station.x - center.x) * viewport.scale;
  expect(imagePixelX * viewport.scale).toBeCloseTo(overlayPixelX);
  expect(staticMapViewport(width, height, 20).zoom).toBe(17);
});

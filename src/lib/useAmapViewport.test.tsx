import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useAmapViewport } from './useAmapViewport';
import { loadAmap } from '../amapLoader';
import { AmapBaseMapSettings } from '../types';

jest.mock('../amapLoader', () => ({ getAmapConfig: () => ({ key: 'test', securityCode: 'test' }), loadAmap: jest.fn() }));

class FakeMap {
  center: [number, number]; zoom: number; width = 960; height = 640;
  events = new Map<string, Set<() => void>>();
  setMapStyle = jest.fn();
  destroy = jest.fn();
  setZoomAndCenter = jest.fn((zoom: number, center: [number, number]) => {
    this.zoom = zoom; this.center = center;
    this.emit('movestart'); this.emit('zoomstart'); this.emit('moveend'); this.emit('zoomend');
  });
  constructor(_host: HTMLElement, opts: any) { this.center = opts.center; this.zoom = opts.zoom; maps.push(this); }
  getCenter() { return { lng: this.center[0], lat: this.center[1] }; }
  getZoom() { return this.zoom; }
  getSize() { return { width: this.width, height: this.height }; }
  on(event: string, fn: () => void) { if (!this.events.has(event)) this.events.set(event, new Set()); this.events.get(event)!.add(fn); }
  off(event: string, fn: () => void) { this.events.get(event)?.delete(fn); }
  emit(event: string) { this.events.get(event)?.forEach(fn => fn()); }
}
const maps: FakeMap[] = [];
const viewport: AmapBaseMapSettings = { center: [117.2, 39.1], zoom: 12, style: 'normal' };
let host: HTMLDivElement; let root: Root;
let result: ReturnType<typeof useAmapViewport>;
const onViewportChange = jest.fn(); const onInteractionChange = jest.fn();
type Props = { enabled?: boolean; documentKey?: string; documentLoading?: boolean; viewport?: AmapBaseMapSettings; width?: number };
const commits: Array<{ key: string; ready: boolean }> = [];
function Harness(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  result = useAmapViewport({ enabled: true, documentKey: 'a', documentLoading: false, viewport, width: 960,
    height: 640, containerRef, onViewportChange, onInteractionChange, ...props });
  commits.push({ key: props.documentKey || 'a', ready: result.ready });
  return <div ref={containerRef} aria-busy={!result.ready}>{result.error || (result.ready ? 'ready' : 'loading')}</div>;
}
const render = async (props: Props = {}) => { await act(async () => { root.render(<Harness {...props} />); }); };
const emit = (event: string, map = maps[maps.length - 1]) => act(() => map.emit(event));
beforeEach(() => {
  jest.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  maps.length = 0; commits.length = 0; onViewportChange.mockReset(); onInteractionChange.mockReset();
  (loadAmap as jest.Mock).mockReset().mockResolvedValue({ Map: FakeMap });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); expect(jest.getTimerCount()).toBe(0); host.remove(); jest.useRealTimers(); });

test('首次加载等待 complete；超时提示后仍可在实际就绪时恢复', async () => {
  await render(); expect(result.ready).toBe(false);
  act(() => jest.advanceTimersByTime(21_000));
  expect(result.ready).toBe(false); expect(result.error).toContain('加载较慢');
  emit('complete'); expect(result.ready).toBe(true); expect(result.error).toBe('');
});
test('SDK 异步到达时读取最新存档视野', async () => {
  let resolve!: (value: any) => void;
  (loadAmap as jest.Mock).mockImplementation(() => new Promise(done => { resolve = done; }));
  await render();
  const next = { ...viewport, center: [121.5, 31.2] as [number, number], zoom: 14 };
  await render({ documentKey: 'b', viewport: next });
  await act(async () => resolve({ Map: FakeMap }));
  expect(maps[0].center).toEqual(next.center); expect(maps[0].zoom).toBe(14);
  emit('complete'); expect(result.ready).toBe(true);
});
test('跨存档首帧隐藏线网，旧视野 complete 无法释放新场景', async () => {
  await render(); emit('complete'); expect(result.ready).toBe(true);
  const next = { ...viewport, center: [121.5, 31.2] as [number, number], zoom: 14 };
  await render({ documentKey: 'b', viewport: next });
  expect(result.ready).toBe(false);
  expect(commits.find(commit => commit.key === 'b')?.ready).toBe(false);
  expect(maps[0].setZoomAndCenter).toHaveBeenCalledWith(14, next.center, true, 0);
  expect(onViewportChange).not.toHaveBeenCalled();
  maps[0].center = viewport.center; maps[0].zoom = viewport.zoom;
  emit('complete'); expect(result.ready).toBe(false);
  maps[0].center = next.center; maps[0].zoom = next.zoom;
  emit('complete'); expect(result.ready).toBe(true);
});
test('相同视野切换存档复用已完成的底图，不等待不存在的新网络事件', async () => {
  await render(); emit('complete');
  await render({ documentKey: 'b' });
  expect(result.ready).toBe(true); expect(maps).toHaveLength(1);
});
test('正常拖动回写不触发加载层或重复设置地图风格', async () => {
  await render(); emit('complete');
  const map = maps[0]; emit('movestart'); map.center = [117.4, 39.2]; emit('moveend');
  expect(onViewportChange).toHaveBeenCalledWith(map.center, map.zoom);
  await render({ viewport: { ...viewport, center: map.center } });
  expect(result.ready).toBe(true); expect(map.setMapStyle).not.toHaveBeenCalled();
});
test('尺寸变化后等新尺寸底图完成，再重新显示投影', async () => {
  await render(); emit('complete');
  await render({ width: 1200 }); emit('complete'); expect(result.ready).toBe(false);
  maps[0].width = 1200; emit('resize'); emit('complete'); expect(result.ready).toBe(true);
});
test('加载新存档期间，旧地图的移动事件不回写视野', async () => {
  await render(); emit('complete'); await render({ documentLoading: true });
  maps[0].center = [118, 40]; emit('moveend'); expect(onViewportChange).not.toHaveBeenCalled();
  await render({ documentLoading: false, documentKey: 'b' });
  expect(maps[0].center).toEqual(viewport.center);
});
test('深浅色切换等待相应底图完成', async () => {
  await render(); emit('complete');
  await render({ viewport: { ...viewport, style: 'dark' } });
  expect(result.ready).toBe(false); expect(maps[0].setMapStyle).toHaveBeenCalledWith('amap://styles/dark');
  emit('complete'); expect(result.ready).toBe(true);
});
test('退出高德后销毁实例和监听器，再进入时重新等待真实完成', async () => {
  await render(); emit('complete'); const previous = maps[0];
  await render({ enabled: false }); expect(previous.destroy).toHaveBeenCalledTimes(1);
  expect(Array.from(previous.events.values()).every(handlers => handlers.size === 0)).toBe(true);
  await render(); expect(result.ready).toBe(false);
  emit('complete', previous); expect(result.ready).toBe(false);
  emit('complete'); expect(result.ready).toBe(true);
});
test('SDK 加载失败保留错误状态', async () => {
  (loadAmap as jest.Mock).mockRejectedValue(new Error('测试网络错误'));
  await render(); expect(result.ready).toBe(false); expect(result.error).toBe('测试网络错误');
});

test('真实高德场景：切换第 2、第 3 个存档及切换风格时不再二次触发 complete 也能立即就绪', async () => {
  await render(); emit('complete'); expect(result.ready).toBe(true);
  // 第二个存档（不同城市 + 不同缩放，且模拟高德墨卡托微小舍入与缩放限幅，不触发第二次 complete）
  const second: AmapBaseMapSettings = { center: [121.473701, 31.230416], zoom: 2, style: 'normal' };
  maps[0].setZoomAndCenter.mockImplementationOnce((_zoom: number, center: [number, number]) => {
    maps[0].zoom = 3; // 模拟高德最小缩放限幅 2 -> 3
    maps[0].center = [center[0] + 0.00012, center[1] - 0.00008];
    maps[0].emit('movestart'); maps[0].emit('moveend');
  });
  await render({ documentKey: 'map-2', viewport: second });
  expect(result.ready).toBe(false); // 首帧隐藏旧投影
  act(() => jest.advanceTimersByTime(32));
  expect(result.ready).toBe(true);
  expect(result.error).toBe('');

  // 第三个存档同时切换暗夜底图风格（setMapStyle 不触发任何高德事件）
  const third: AmapBaseMapSettings = { center: [113.264385, 23.129112], zoom: 11.5, style: 'dark' };
  await render({ documentKey: 'map-3', viewport: third });
  expect(result.ready).toBe(false);
  act(() => jest.advanceTimersByTime(32));
  expect(result.ready).toBe(true);
  expect(result.error).toBe('');
});

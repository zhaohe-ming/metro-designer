import { recordVideoCanvas } from './recordVideo';

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'video/webm';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  onstart?: () => void;
  constructor() { FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; this.onstart?.(); }
  stop() {
    this.state = 'inactive';
    setTimeout(() => { this.ondataavailable?.({ data: new Blob(['video']) }); this.onstop?.(); }, 0);
  }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
}

let track: EventTarget & { stop: jest.Mock };
let capture: jest.Mock;
let hidden: jest.SpyInstance;
const originalRecorder = global.MediaRecorder;
beforeEach(() => {
  jest.useFakeTimers('modern');
  FakeRecorder.instances = [];
  global.MediaRecorder = FakeRecorder as any;
  track = Object.assign(new EventTarget(), { stop: jest.fn() });
  capture = jest.fn(() => ({ getVideoTracks: () => [track], getTracks: () => [track] }));
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: capture });
  hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => {
  hidden.mockRestore();
  global.MediaRecorder = originalRecorder;
  jest.useRealTimers();
});
const record = (extra = {}) => recordVideoCanvas({
  canvas: document.createElement('canvas'), fps: 30, totalFrames: 90, drawFrame: jest.fn(), ...extra
});

test('完整录制到计划时长后才停止，并释放视频流', async () => {
  const drawFrame = jest.fn();
  const promise = record({ drawFrame });
  jest.advanceTimersByTime(1500);
  expect(FakeRecorder.instances[0].state).toBe('recording');
  expect(drawFrame.mock.calls[drawFrame.mock.calls.length - 1][0]).toBeLessThanOrEqual(45);
  jest.advanceTimersByTime(1600);
  expect((await promise).size).toBeGreaterThan(0);
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('编码器启动延迟不消耗片头和动画的播放时间', async () => {
  const delayedStart = jest.spyOn(FakeRecorder.prototype, 'start').mockImplementation(function (this: FakeRecorder) {
    this.state = 'recording';
    setTimeout(() => this.onstart?.(), 500);
  });
  const drawFrame = jest.fn();
  const onProgress = jest.fn();
  const promise = record({ drawFrame, onProgress });
  jest.advanceTimersByTime(500);
  expect(drawFrame.mock.calls[drawFrame.mock.calls.length - 1][0]).toBe(0);
  jest.advanceTimersByTime(2500);
  expect(FakeRecorder.instances[0].state).toBe('recording');
  jest.advanceTimersByTime(600);
  await expect(promise).resolves.toHaveProperty('type', 'video/webm');
  expect(onProgress.mock.calls[onProgress.mock.calls.length - 1][0]).toMatchObject({ totalSec: 3.5 });
  delayedStart.mockRestore();
});

test('取消会立即拒绝结果、停止录制并清理定时器', async () => {
  const controller = new AbortController();
  const promise = record({ signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  jest.runOnlyPendingTimers();
  expect(FakeRecorder.instances[0].state).toBe('inactive');
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('编码失败与流意外结束都不能让导出一直等待', async () => {
  const errorPromise = record();
  FakeRecorder.instances[0].onerror?.();
  await expect(errorPromise).rejects.toThrow('编码失败');
  const endedPromise = record();
  track.dispatchEvent(new Event('ended'));
  await expect(endedPromise).rejects.toThrow('意外中断');
  expect(track.stop).toHaveBeenCalledTimes(2);
});

test('后台暂停不消耗动画时间，返回后继续录制', async () => {
  const onProgress = jest.fn();
  const promise = record({ onProgress });
  jest.advanceTimersByTime(1000);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(FakeRecorder.instances[0].state).toBe('paused');
  jest.advanceTimersByTime(5000);
  expect(onProgress.mock.calls[onProgress.mock.calls.length - 1][0]).toMatchObject({ phase: 'paused', elapsedSec: 1 });
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  jest.advanceTimersByTime(2100);
  await expect(promise).resolves.toHaveProperty('type', 'video/webm');
  expect(track.stop).toHaveBeenCalledTimes(1);
});

test('开始前已取消时不创建流；编码器初始化失败也释放流', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(record({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(capture).not.toHaveBeenCalled();
  const failingRecorder = jest.fn(() => { throw new Error('constructor failed'); });
  Object.assign(failingRecorder, { isTypeSupported: () => true });
  global.MediaRecorder = failingRecorder as any;
  await expect(record()).rejects.toThrow('constructor failed');
  expect(track.stop).toHaveBeenCalledTimes(1);
});

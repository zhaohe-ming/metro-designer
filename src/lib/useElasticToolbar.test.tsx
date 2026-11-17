import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useElasticToolbar } from './useElasticToolbar';

let host: HTMLDivElement;
let root: Root;
let reduced = false;
let resize: () => void;
let width = 56;
const select = jest.fn();
const click = jest.fn();

function Harness({ enabled = true, active = 4 }: { enabled?: boolean; active?: number }) {
  const ref = useElasticToolbar(active, 5, enabled, select);
  return <div ref={ref}>{Array.from({ length: 5 }, (_, index) =>
    <button key={index} className="metro-tool-button" onClick={click}>{index}</button>)}</div>;
}
const group = () => host.firstElementChild as HTMLDivElement;
function pointer(type: string, x: number, y = 30, id = 1, primary = true) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } });
  act(() => { group().dispatchEvent(event); });
}
const settle = () => act(() => { jest.advanceTimersByTime(1200); });

beforeEach(() => {
  jest.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  reduced = false; width = 56; select.mockClear(); click.mockClear();
  window.matchMedia = jest.fn().mockImplementation(() => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
  global.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
    observe() {} disconnect() {} unobserve() {}
  };
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('metro-tool-button') ? width : 5 * (width + 2) + 6; });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const index = this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : 0;
    return { left: 10 + index * (width + 2), top: 4, width, height: 52, right: 10 + index * (width + 2) + width, bottom: 56, x: 10, y: 4, toJSON() {} };
  });
  HTMLElement.prototype.setPointerCapture = jest.fn();
  HTMLElement.prototype.hasPointerCapture = jest.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = jest.fn();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<Harness />)); settle();
});
afterEach(() => { act(() => root.unmount()); host.remove(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('拖动中仅预览，松手确认一次并吞掉后续原生 click', () => {
  pointer('pointerdown', 270); pointer('pointermove', 154); settle();
  expect(select).not.toHaveBeenCalled();
  expect(group().dataset.previewIndex).toBe('2');
  pointer('pointerup', 154);
  expect(select.mock.calls).toEqual([[2]]);
  act(() => { group().children[2].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  expect(click).not.toHaveBeenCalled();
  settle();
});
test('两端拖出仍限幅，松手吸附，下一次拖动可继续使用', () => {
  pointer('pointerdown', 270); pointer('pointermove', -400); settle();
  expect(parseFloat(group().style.getPropertyValue('--phone-tool-position'))).toBeGreaterThan(-15);
  expect(Math.abs(parseFloat(group().style.getPropertyValue('--phone-shell-x')))).toBeLessThanOrEqual(4);
  pointer('pointerup', -400); settle();
  expect(group().style.getPropertyValue('--phone-tool-position')).toBe('0px');
  expect(select.mock.calls).toEqual([[0]]);
  pointer('pointerdown', 96); pointer('pointerup', 96);
  expect(select.mock.calls).toEqual([[0], [1]]);
});
test.each(['pointercancel', 'lostpointercapture', 'second-touch', 'resize', 'escape'])('%s 撤回预览并保留原工具', reason => {
  pointer('pointerdown', 270); pointer('pointermove', 96); settle();
  if (reason === 'second-touch') pointer('pointerdown', 154, 30, 2, false);
  else if (reason === 'resize') act(() => { window.dispatchEvent(new Event('resize')); });
  else if (reason === 'escape') act(() => { group().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  else pointer(reason, 96);
  pointer('pointerup', 96); settle();
  expect(select).not.toHaveBeenCalled();
  expect(group().dataset.previewIndex).toBe('4');
  expect(group().style.getPropertyValue('--phone-shell-sx')).toBe('1');
});
test('窄屏尺寸变化取消手势，按新宽度对齐；键盘激活继续生效', () => {
  pointer('pointerdown', 270); pointer('pointermove', 96);
  width = 51; act(() => resize()); settle();
  expect(group().style.getPropertyValue('--phone-tool-position')).toBe('212px');
  expect(select).not.toHaveBeenCalled();
  act(() => { group().children[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
  expect(click).toHaveBeenCalledTimes(1);
});
test.each([-300, 400])('纵向离开栏体至 y=%s 后仍按 X 预览和确认', y => {
  pointer('pointerdown', 270); pointer('pointermove', 270, y);
  pointer('pointermove', 96, y); settle();
  expect(select).not.toHaveBeenCalled();
  expect(group().dataset.previewIndex).toBe('1');
  pointer('pointerup', 96, y);
  act(() => { group().children[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  expect(select.mock.calls).toEqual([[1]]);
  expect(click).not.toHaveBeenCalled();
});
test('释放位置更新到最后的 X，快速抬手无需等待滑块追上', () => {
  pointer('pointerdown', 270); pointer('pointermove', 212, 200);
  pointer('pointerup', 96, 400);
  expect(select.mock.calls).toEqual([[1]]);
  settle();
  expect(group().style.getPropertyValue('--phone-tool-position')).toBe('58px');
});
test.each([[-400, 0], [800, 4]])('在栏体外 x=%s 释放时吸附到端点 %s', (x, expected) => {
  act(() => root.render(<Harness active={2} />)); settle();
  pointer('pointerdown', 154); pointer('pointermove', x, 400); pointer('pointerup', x, 400);
  expect(select.mock.calls).toEqual([[expected]]);
});
test('减少动态效果时保留拖动，壳体静止且松手直接对齐', () => {
  reduced = true;
  act(() => root.render(<Harness enabled={false} />));
  act(() => root.render(<Harness />));
  pointer('pointerdown', 270); pointer('pointermove', 96);
  expect(group().style.getPropertyValue('--phone-shell-sx')).toBe('1');
  expect(group().dataset.previewIndex).toBe('1');
  pointer('pointerup', 96);
  expect(group().style.getPropertyValue('--phone-tool-position')).toBe('58px');
});
test('桌面停用手势，原生按钮保持可点击', () => {
  act(() => root.render(<Harness enabled={false} />));
  expect(group().dataset.elasticReady).toBeUndefined();
  expect(group().style.getPropertyValue('--phone-tool-position')).toBe('');
  pointer('pointerdown', 270); pointer('pointermove', 96); pointer('pointerup', 96);
  expect(select).not.toHaveBeenCalled();
  act(() => { group().children[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  expect(click).toHaveBeenCalledTimes(1);
});

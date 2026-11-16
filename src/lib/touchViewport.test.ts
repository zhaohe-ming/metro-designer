import { TouchViewportGesture } from './touchViewport';

const p = (id: number, x: number, y: number) => ({ id, x, y });
const initial = { x: 20, y: 30, scale: 1 };

test('双指缩放固定手指中心下的世界坐标，并同时允许平移', () => {
  const g = new TouchViewportGesture();
  g.start([p(1, 100, 100), p(2, 200, 100)]);
  const v = g.move([p(1, 70, 120), p(2, 270, 120)], initial, false)!;
  expect(v.scale).toBe(2);
  expect((170 - v.x) / v.scale).toBe((150 - initial.x) / initial.scale);
  expect((120 - v.y) / v.scale).toBe((100 - initial.y) / initial.scale);
  expect(g.end([])).toBe(false);
});

test('双指变单指继续平移，离屏后才允许下一次编辑', () => {
  const g = new TouchViewportGesture();
  g.start([p(1, 10, 10)]);
  g.start([p(1, 10, 10), p(2, 20, 20)]);
  expect(g.end([p(1, 10, 10)])).toBe(false);
  expect(g.move([p(1, 30, 40)], initial, false)).toEqual({ ...initial, x: 40, y: 60 });
  expect(g.end([])).toBe(false);
  g.start([p(3, 40, 40)]);
  expect(g.end([])).toBe(true);
});

test('绘图模式拖动、长按和系统取消均不会误触成点击', () => {
  const g = new TouchViewportGesture();
  g.start([p(1, 0, 0)]);
  expect(g.move([p(1, 30, 0)], initial, false)).toBeNull();
  expect(g.canLongPress).toBe(false);
  expect(g.end([])).toBe(false);
  g.start([p(1, 0, 0)]);
  g.consume();
  expect(g.end([])).toBe(false);
  g.start([p(1, 0, 0)]);
  g.cancel();
  expect(g.end([])).toBe(false);
});

test('缩放上限保持锚点，触点顺序改变与零距离保持稳定', () => {
  const g = new TouchViewportGesture();
  g.start([p(1, 100, 100), p(2, 200, 100)]);
  const v = g.move([p(2, 250, 100), p(1, 50, 100)], { ...initial, scale: 4 }, true)!;
  expect(v.scale).toBe(5);
  expect((150 - v.x) / v.scale).toBe((150 - initial.x) / 4);
  g.cancel();
  g.start([p(1, 10, 10), p(2, 10, 10)]);
  expect(g.move([p(1, 10, 10), p(2, 20, 20)], initial, true)).toBeNull();
});

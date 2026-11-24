import {
  computeCornerHandleInfo,
  radiusFromCornerHandleDrag,
  roundCorners,
  roundLineFlat,
  RPoint
} from './roundedPath';

const dist = (a: RPoint, b: RPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const hasPointNear = (pts: RPoint[], target: RPoint, eps = 0.5) =>
  pts.some((p) => dist(p, target) <= eps);

describe('roundCorners', () => {
  it('radius<=0 或点数<3 时原样返回', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(roundCorners(pts, 0)).toEqual(pts);
    expect(roundCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('端点保持不动', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const out = roundCorners(pts, 20);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 100, y: 100 });
  });

  it('90° 拐角被替换成正确的圆弧（切点、半径、不含原拐点）', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const r = 20;
    const out = roundCorners(pts, r);

    // 输出比输入更密（拐角被采样成多个点）
    expect(out.length).toBeGreaterThan(pts.length);
    // 原拐点 (100,0) 被切掉，不应出现
    expect(hasPointNear(out, { x: 100, y: 0 })).toBe(false);
    // 切点：沿两臂回退 r=20 → (80,0) 与 (100,20)
    expect(hasPointNear(out, { x: 80, y: 0 })).toBe(true);
    expect(hasPointNear(out, { x: 100, y: 20 })).toBe(true);
    // 弧上每个点到圆心 (80,20) 的距离都 ≈ 20
    const center = { x: 80, y: 20 };
    const arcPoints = out.slice(1, out.length - 1); // 去掉两个端点
    for (const p of arcPoints) {
      expect(Math.abs(dist(p, center) - r)).toBeLessThan(0.01);
    }
  });

  it('相邻段过短时半径被夹紧（不超过段长一半）', () => {
    // 两臂各长 10，请求半径 20 → 实际半径夹到 5
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const out = roundCorners(pts, 20);
    const center = { x: 5, y: 5 };
    const arcPoints = out.slice(1, out.length - 1);
    for (const p of arcPoints) {
      expect(Math.abs(dist(p, center) - 5)).toBeLessThan(0.01);
    }
    // 切点不会越过段中点
    expect(hasPointNear(out, { x: 5, y: 0 })).toBe(true);
  });

  it('接近直线的拐角（小于阈值）不处理', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 1 }];
    const out = roundCorners(pts, 20, 10);
    expect(out).toEqual(pts); // 原样：拐点保留
  });

  it('多个拐角各自独立圆角', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 100 }
    ];
    const out = roundCorners(pts, 20);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 200, y: 100 });
    // 两个原拐点都被切掉
    expect(hasPointNear(out, { x: 100, y: 0 })).toBe(false);
    expect(hasPointNear(out, { x: 100, y: 100 })).toBe(false);
  });

  it('不修改入参', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const snapshot = JSON.stringify(pts);
    roundCorners(pts, 20);
    expect(JSON.stringify(pts)).toEqual(snapshot);
  });
});

describe('roundLineFlat', () => {
  it('扁平数组进、扁平数组出，端点保持', () => {
    const flat = [0, 0, 100, 0, 100, 100];
    const out = roundLineFlat(flat, 20);
    expect(out.length % 2).toBe(0);
    expect(out.slice(0, 2)).toEqual([0, 0]);
    expect(out.slice(-2)).toEqual([100, 100]);
    expect(out.length).toBeGreaterThan(flat.length);
  });

  it('radius<=0 或点太少时原样返回', () => {
    expect(roundLineFlat([0, 0, 10, 10], 20)).toEqual([0, 0, 10, 10]);
    expect(roundLineFlat([0, 0, 100, 0, 100, 100], 0)).toEqual([0, 0, 100, 0, 100, 100]);
  });
});

describe('per-waypoint custom radius & 3-point arc mode', () => {
  it('supports independent radius per waypoint even when fallbackRadius is 0', () => {
    const pts: RPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0, radius: 30 },
      { x: 100, y: 100, radius: 0 },
      { x: 200, y: 100 }
    ];
    const out = roundCorners(pts, 0);
    // 第一个拐角被导圆为 r=30，第二个拐角 radius=0 保持尖角 (100, 100)
    expect(hasPointNear(out, { x: 100, y: 0 })).toBe(false);
    expect(hasPointNear(out, { x: 100, y: 100 }, 1e-4)).toBe(true);
  });

  it('supports mode="arc" 3-point circular arc passing right through the waypoint', () => {
    // 起点 (-50, 0) -> 拱顶途经点 (0, -50, mode: 'arc') -> 终点 (50, 0)：标准上半圆，圆心 (0,0)，半径 50
    const pts: RPoint[] = [
      { x: -50, y: 0 },
      { x: 0, y: -50, mode: 'arc' },
      { x: 50, y: 0 }
    ];
    const out = roundCorners(pts, 0);
    expect(out.length).toBeGreaterThan(10);
    expect(out[0]).toEqual({ x: -50, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 50, y: 0 });
    for (const p of out) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 50)).toBeLessThan(0.05);
      expect(p.y).toBeLessThanOrEqual(0.05);
    }
  });

  it('computes corner handle geometry and inverse drag radius accurately', () => {
    const prev = { x: 0, y: 0 };
    const curr = { x: 100, y: 0 };
    const next = { x: 100, y: 100 };
    const info = computeCornerHandleInfo(prev, curr, next, 30);
    expect(info).not.toBeNull();
    // 拖动圆弧手柄回当前圆弧顶点时，反推半径应接近 30
    const draggedR = radiusFromCornerHandleDrag(prev, curr, next, {
      x: info!.arcApexX,
      y: info!.arcApexY
    });
    expect(Math.abs(draggedR - 30)).toBeLessThanOrEqual(1);
  });
});

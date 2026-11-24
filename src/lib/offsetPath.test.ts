import {
  buildSectionRenderGeometry,
  computeDirectedParallelOffset,
  findWaypointInsertIndex,
  offsetPolylinePoints
} from './offsetPath';

describe('computeDirectedParallelOffset', () => {
  it('fixes opposite-direction overlap: A->B and B->A receive opposite world-space shifts', () => {
    // 1 号线 s1 -> s2 (slot 0 of 2)
    const d1 = computeDirectedParallelOffset('s1', 's2', 0, 2, 8);
    // 2 号线反向存储 s2 -> s1 (slot 1 of 2)
    const d2 = computeDirectedParallelOffset('s2', 's1', 1, 2, 8);

    const line1Shifted = offsetPolylinePoints([{ x: 0, y: 0 }, { x: 100, y: 0 }], d1);
    const line2Shifted = offsetPolylinePoints([{ x: 100, y: 0 }, { x: 0, y: 0 }], d2);

    // 1 号线落在 y = -4，2 号线落在 y = +4，间距 8px，绝不重叠
    expect(line1Shifted[0].y).toBeCloseTo(-4, 5);
    expect(line1Shifted[1].y).toBeCloseTo(-4, 5);
    expect(line2Shifted[0].y).toBeCloseTo(4, 5);
    expect(line2Shifted[1].y).toBeCloseTo(4, 5);
  });
});

describe('offsetPolylinePoints & concentric corner rounding', () => {
  it('computes exact miter bisector at 90-degree bends and concentric inner/outer radii', () => {
    const base = [
      { x: 0, y: 0 },
      { x: 100, y: 0, radius: 20 },
      { x: 100, y: 100 }
    ];

    const inner = offsetPolylinePoints(base, 4, 0);
    const outer = offsetPolylinePoints(base, -4, 0);

    // 内圈拐点平移到 (96, 4)，半径缩小为 16；外圈拐点平移到 (104, -4)，半径增大为 24
    expect(inner[1].x).toBeCloseTo(96, 5);
    expect(inner[1].y).toBeCloseTo(4, 5);
    expect(inner[1].radius).toBeCloseTo(16, 5);

    expect(outer[1].x).toBeCloseTo(104, 5);
    expect(outer[1].y).toBeCloseTo(-4, 5);
    expect(outer[1].radius).toBeCloseTo(24, 5);

    const innerGeom = buildSectionRenderGeometry(base, 4, 0);
    const outerGeom = buildSectionRenderGeometry(base, -4, 0);
    expect(innerGeom.renderPoints.length).toBeGreaterThan(4);
    expect(outerGeom.renderPoints.length).toBeGreaterThan(4);
  });
});

describe('findWaypointInsertIndex', () => {
  it('inserts into the exact sub-segment clicked regardless of start/end station order or U-turns', () => {
    // 区间存储为右站(200,0) -> W0(120, 60) -> W1(60, 60) -> 左站(0,0)
    const start = { x: 200, y: 0 };
    const waypoints = [
      { x: 120, y: 60 },
      { x: 60, y: 60 }
    ];
    const end = { x: 0, y: 0 };

    // 用户点击靠近左站 ~ W1 的子段 (30, 30) -> 应插在 W1 与 end 之间 (index = 2)
    expect(findWaypointInsertIndex(start, waypoints, end, { x: 30, y: 31 }).insertIndex).toBe(2);
    // 用户点击中间子段 W0 ~ W1 (90, 60) -> 应插在 W0 与 W1 之间 (index = 1)
    expect(findWaypointInsertIndex(start, waypoints, end, { x: 90, y: 58 }).insertIndex).toBe(1);
    // 用户点击靠近右站 ~ W0 的子段 (160, 30) -> 应插在 start 与 W0 之间 (index = 0)
    expect(findWaypointInsertIndex(start, waypoints, end, { x: 160, y: 29 }).insertIndex).toBe(0);
  });
});

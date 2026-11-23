import { Box2D, SpatialBoxGrid } from './spatialGrid';

const overlaps = (a: Box2D, b: Box2D) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('空间网格查询与全量暴力遍历的重叠集合完全一致（1200 节点规模）', () => {
  const grid = new SpatialBoxGrid<Box2D & { id: number }>(128);
  const boxes: Array<Box2D & { id: number }> = [];
  for (let i = 0; i < 1200; i += 1) {
    const box = {
      id: i,
      x: ((i * 73) % 4000) - 1000,
      y: ((i * 137) % 3000) - 800,
      width: 24 + (i % 60),
      height: 16 + (i % 24)
    };
    boxes.push(box);
    grid.insert(box);
  }

  for (let q = 0; q < 80; q += 1) {
    const probe: Box2D = {
      x: ((q * 191) % 3600) - 900,
      y: ((q * 251) % 2600) - 700,
      width: 68,
      height: 28
    };
    const expected = boxes.filter((b) => overlaps(probe, b)).map((b) => b.id).sort((a, b) => a - b);
    const actual: number[] = [];
    grid.forEachInBox(probe, (b) => {
      if (overlaps(probe, b)) actual.push(b.id);
    });
    actual.sort((a, b) => a - b);
    expect(actual).toEqual(expected);
  }
});

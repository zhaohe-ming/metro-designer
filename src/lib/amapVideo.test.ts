import { hasVideoGeoPoint, mercatorUnproject, planAmapVideoMap } from './amapVideo';
import { mercatorProject } from './videoModel';

const points = [{ lng: 117.05, lat: 39.02 }, { lng: 117.20, lat: 39.15 }, { lng: 117.72, lat: 39.42 }];

test.each([[1920, 1080], [1080, 1920], [1920, 1920], [1920, 800]])('高清底图覆盖 %ix%i 全景及全部跟随机位', (width, height) => {
  const plan = planAmapVideoMap(points, width, height);
  expect(plan.patches.length).toBeLessThanOrEqual(12);
  expect(plan.patches.reduce((sum, patch) => sum + patch.imageWidth * patch.imageHeight, 0)).toBeLessThan(25_000_000);
  plan.patches.forEach(patch => {
    expect(patch.width).toBeLessThanOrEqual(1024);
    expect(patch.height).toBeLessThanOrEqual(1024);
    expect(patch.imageWidth).toBe(patch.width * 2);
    expect(patch.zoom + 1).toBe(plan.zoom);
    expect(patch.center.every(value => value * 1e6 === Math.round(value * 1e6) || Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-6)).toBe(true);
    const center = mercatorProject(...patch.center, plan.zoom);
    expect(center.x - patch.imageX).toBeCloseTo(patch.imageWidth / 2);
    expect(center.y - patch.imageY).toBeCloseTo(patch.imageHeight / 2);
  });
  const left = Math.min(...plan.patches.map(patch => patch.x));
  const top = Math.min(...plan.patches.map(patch => patch.y));
  const right = Math.max(...plan.patches.map(patch => patch.x + patch.coreWidth));
  const bottom = Math.max(...plan.patches.map(patch => patch.y + patch.coreHeight));
  points.forEach(point => {
    const target = mercatorProject(point.lng, point.lat, plan.zoom);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const x = plan.camera.x + (target.x - plan.camera.x) * t;
      const y = plan.camera.y + (target.y - plan.camera.y) * t;
      const scale = plan.camera.scale * (1 + 0.6 * t);
      expect(x - width / (2 * scale)).toBeGreaterThanOrEqual(left);
      expect(x + width / (2 * scale)).toBeLessThanOrEqual(right);
      expect(y - height / (2 * scale)).toBeGreaterThanOrEqual(top);
      expect(y + height / (2 * scale)).toBeLessThanOrEqual(bottom);
    }
  });
});

test('缺失或越界经纬度在请求地图和录制前报错', () => {
  [undefined, NaN, Infinity, 181].forEach(lng => expect(hasVideoGeoPoint({ lng, lat: 39 })).toBe(false));
  expect(() => planAmapVideoMap([{ lng: 117 }], 1920, 1080)).toThrow('经纬度');
  expect(() => planAmapVideoMap([], 1920, 1080)).toThrow('经纬度');
});

test('高清级别上限和极小范围也有确定的预算', () => {
  const plan = planAmapVideoMap([{ lng: 117.20001, lat: 39.1 }, { lng: 117.20002, lat: 39.10001 }], 1080, 1920);
  expect(plan.zoom).toBeLessThanOrEqual(17);
  expect(plan.patches.length).toBeLessThanOrEqual(12);
  expect(mercatorUnproject(mercatorProject(117.123456, 39.123456, 17), 17)).toEqual([117.123456, 39.123456]);
});

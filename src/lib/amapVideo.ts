import { mercatorProject, VideoPoint } from './videoModel';

export type GeoVideoPoint = { lng?: number; lat?: number };
export const hasVideoGeoPoint = (point: GeoVideoPoint) => Number.isFinite(point.lng) &&
  Number.isFinite(point.lat) && Math.abs(point.lng!) <= 180 && Math.abs(point.lat!) <= 85.05112878;

export function mercatorUnproject(point: VideoPoint, zoom: number): [number, number] {
  const size = 256 * Math.pow(2, zoom);
  return [Number((point.x / size * 360 - 180).toFixed(6)),
    Number((Math.atan(Math.sinh(Math.PI * (1 - 2 * point.y / size))) * 180 / Math.PI).toFixed(6))];
}

export function planAmapVideoMap(points: GeoVideoPoint[], width: number, height: number) {
  if (!points.length || points.some(point => !hasVideoGeoPoint(point))) {
    throw new Error('导出区间存在缺少经纬度的站点或折点，请补齐地理位置后重试');
  }
  const boundsAtZoom = (zoom: number) => {
    const projected = points.map(point => mercatorProject(point.lng!, point.lat!, zoom));
    return { left: Math.min(...projected.map(p => p.x)), right: Math.max(...projected.map(p => p.x)),
      top: Math.min(...projected.map(p => p.y)), bottom: Math.max(...projected.map(p => p.y)) };
  };
  const zero = boundsAtZoom(0);
  const fit = (bounds: typeof zero) => Math.min(width * 0.8 / Math.max(1e-9, bounds.right - bounds.left),
    height * 0.72 / Math.max(1e-9, bounds.bottom - bounds.top));
  // 以跟随放大后的清晰度选图级别，再用请求数和解码像素预算约束移动端内存。
  let zoom = Math.max(2, Math.min(17, Math.ceil(Math.log2(fit(zero) * 1.6))));
  for (;;) {
    const bounds = boundsAtZoom(zoom);
    const scale = Math.min(1.25, fit(bounds));
    const camera = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, scale };
    // 相机的中心始终在路径包围盒内，倍率始终 >= 全景倍率；此范围覆盖整个平滑运镜。
    const left = Math.floor(bounds.left - width / (2 * scale));
    const top = Math.floor(bounds.top - height / (2 * scale));
    const right = Math.ceil(bounds.right + width / (2 * scale));
    const bottom = Math.ceil(bounds.bottom + height / (2 * scale));
    const columns = Math.ceil((right - left) / 2044);
    const rows = Math.ceil((bottom - top) / 2044);
    if (zoom > 2 && (columns * rows > 12 || (right - left + columns * 4) * (bottom - top + rows * 4) > 24_000_000)) {
      zoom -= 1;
      continue;
    }
    const patches = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = left + column * 2044;
        const y = top + row * 2044;
        const coreWidth = Math.min(2044, right - x);
        const coreHeight = Math.min(2044, bottom - y);
        const imageWidth = Math.ceil((coreWidth + 4) / 2) * 2;
        const imageHeight = Math.ceil((coreHeight + 4) / 2) * 2;
        const center = mercatorUnproject({ x: x + coreWidth / 2, y: y + coreHeight / 2 }, zoom);
        // 使用服务实际收到的六位坐标定位图片，避免中心点舍入积累成拼接误差。
        const actualCenter = mercatorProject(center[0], center[1], zoom);
        patches.push({ center, zoom: zoom - 1, width: imageWidth / 2, height: imageHeight / 2,
          imageWidth, imageHeight, imageX: actualCenter.x - imageWidth / 2,
          imageY: actualCenter.y - imageHeight / 2, x, y, coreWidth, coreHeight });
      }
    }
    return { zoom, camera, bounds, patches };
  }
}

// 静态 API 提供标准地图；其余三种风格在高清图上一次性调色，录制时直接复用。
export function amapVideoFilter(style: string) {
  if (style === 'grey') return 'grayscale(1) brightness(1.06) contrast(0.88)';
  if (style === 'dark') return 'invert(0.92) hue-rotate(180deg) saturate(0.45) brightness(0.72)';
  if (style === 'fresh') return 'saturate(0.65) brightness(1.04)';
  return 'none';
}

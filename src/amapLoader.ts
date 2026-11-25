import { GeoBounds, GeoPixel, GeoTileMap } from './lib/geoTileMap';

export interface GeoBaseMapSDK {
  Map: typeof GeoTileMap;
  Pixel: typeof GeoPixel;
  Bounds: typeof GeoBounds;
}

const SDK_INSTANCE: GeoBaseMapSDK = {
  Map: GeoTileMap,
  Pixel: GeoPixel,
  Bounds: GeoBounds
};

/**
 * 免 Key 开源瓦片底图已取代旧版高德 JS API，无需任何外部 Key 或安全密钥即可直接使用。
 * 保留同名导出符号以兼容既有调用方与测试桩。
 */
export const getAmapConfig = () => ({
  key: 'open-tile-builtin',
  securityCode: 'open-tile-builtin'
});

export const loadAmap = (): Promise<GeoBaseMapSDK> => {
  if (typeof window !== 'undefined') {
    (window as any).AMap = SDK_INSTANCE;
  }
  return Promise.resolve(SDK_INSTANCE);
};

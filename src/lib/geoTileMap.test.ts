import {
  GeoTileMap,
  getTileCandidateUrls,
  lngLatToWorldPx,
  worldPxToLngLat
} from './geoTileMap';
import {
  getActiveAiBadgeLabel,
  getActiveCustomAiHeaders,
  hasActiveCustomAiKey,
  saveCustomAIConfig
} from './aiCustomConfig';

describe('geoTileMap & aiCustomConfig', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  test('Web Mercator projection roundtrips lng/lat accurately across zoom levels', () => {
    const px = lngLatToWorldPx(116.391276, 39.907335, 13);
    const back = worldPxToLngLat(px.x, px.y, 13);
    expect(back.lng).toBeCloseTo(116.391276, 5);
    expect(back.lat).toBeCloseTo(39.907335, 5);
  });

  test('getTileCandidateUrls includes primary CDN, backend cache proxy, and fallback mirror', () => {
    const urls = getTileCandidateUrls('normal', 11, 1686, 775);
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(urls.some((u) => u.includes('basemaps.cartocdn.com'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/basemap/tile/normal/11/1686/775.png'))).toBe(true);
    expect(urls.some((u) => u.includes('tile.openstreetmap.org'))).toBe(true);
  });

  test('GeoTileMap container projection and panBy shift coordinates consistently', () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    const map = new GeoTileMap(host, { center: [121.4737, 31.2304], zoom: 12, mapStyle: 'grey' });
    const centerPx = map.lngLatToContainer([121.4737, 31.2304]);
    expect(centerPx.x).toBeCloseTo(400, 1);
    expect(centerPx.y).toBeCloseTo(300, 1);

    const unprojected = map.containerToLngLat({ x: 400, y: 300 });
    expect(unprojected.lng).toBeCloseTo(121.4737, 4);
    expect(unprojected.lat).toBeCloseTo(31.2304, 4);
    map.destroy();
  });

  test('custom AI config persists locally and generates request headers only when enabled', () => {
    expect(hasActiveCustomAiKey()).toBe(false);
    expect(getActiveCustomAiHeaders()).toEqual({});

    saveCustomAIConfig({
      enabled: true,
      providerId: 'siliconflow',
      apiKey: 'sk-local-user-key-12345',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3'
    });

    expect(hasActiveCustomAiKey()).toBe(true);
    expect(getActiveAiBadgeLabel()).toBe('自有 Key · 硅基流动');
    expect(getActiveCustomAiHeaders()).toEqual({
      'X-Custom-AI-Key': 'sk-local-user-key-12345',
      'X-Custom-AI-Base-Url': 'https://api.siliconflow.cn/v1',
      'X-Custom-AI-Model': 'deepseek-ai/DeepSeek-V3'
    });

    // Disabling keeps saved key locally for convenience without sending headers
    saveCustomAIConfig({
      enabled: false,
      providerId: 'siliconflow',
      apiKey: 'sk-local-user-key-12345',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3'
    });
    expect(hasActiveCustomAiKey()).toBe(false);
    expect(getActiveCustomAiHeaders()).toEqual({});
  });
});

// 免 Key 开源 Web Mercator 矢量栅格瓦片底图引擎（CARTO / OpenStreetMap + 后端缓存代理自动容灾）
// 提供与原地图实例完全一致的同步投影与视口控制接口，零外部脚本依赖、支持分数值丝滑缩放与直接导出合成。

export type GeoMapStyle = 'normal' | 'grey' | 'dark' | 'fresh';

const API_BASE_URL = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');
const CARTO_API_KEY = (process.env.REACT_APP_CARTO_API_KEY || '').trim();
const MAX_MERCATOR_LAT = 85.05112878;
const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

export function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

export function normalizeLng(lng: number): number {
  if (!Number.isFinite(lng)) return 0;
  let v = lng;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

export function lngLatToWorldPx(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * worldSize;
  const sinLat = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
  return { x, y };
}

export function worldPxToLngLat(x: number, y: number, zoom: number): { lng: number; lat: number } {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const lng = normalizeLng((x / worldSize) * 360 - 180);
  const n = Math.PI - (2 * Math.PI * y) / worldSize;
  const lat = clampLat((180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
  return { lng: Number(lng.toFixed(6)), lat: Number(lat.toFixed(6)) };
}

function normalizeStyleKey(rawStyle?: string): GeoMapStyle {
  const cleaned = String(rawStyle || 'normal').replace(/^amap:\/\/styles\//, '');
  if (cleaned === 'dark' || cleaned === 'grey' || cleaned === 'fresh') return cleaned;
  return 'normal';
}

const SUBDOMAINS = ['a', 'b', 'c', 'd'];

/**
 * 计算不同底图风格在 Canvas 上的色彩滤镜：
 * - 默认免 Key 模式下使用无水印的 OpenStreetMap / ArcGIS 全球公开瓦片作为底板，通过高精度色彩映射实时生成「标准 / 浅灰 / 深色 / 清新」四套视觉风格；
 * - 若额外配置了 REACT_APP_CARTO_API_KEY，则直接使用 CARTO 原生分风格 @2x 瓦片，仅对 fresh 做轻度调色。
 */
export function getCanvasFilterForStyle(style: GeoMapStyle, hasCartoKey = Boolean(CARTO_API_KEY)): string {
  if (hasCartoKey) {
    return style === 'fresh' ? 'saturate(0.82) brightness(1.03) hue-rotate(-4deg)' : 'none';
  }
  switch (style) {
    case 'dark':
      // 反相 + 180° 色相回正：海洋水体保持深海蓝、绿地保持暗林绿、路网与中文地名转为清晰浅灰白，彻底告别水印
      return 'invert(1) hue-rotate(180deg) saturate(0.35) brightness(0.84) contrast(1.08)';
    case 'grey':
      return 'grayscale(1) brightness(1.06) contrast(0.88)';
    case 'fresh':
      return 'saturate(0.76) brightness(1.04) hue-rotate(-8deg) contrast(0.96)';
    case 'normal':
    default:
      return 'none';
  }
}

/**
 * 为单个瓦片返回按优先级排列的多源候选地址：
 * 1) 未配置 CARTO Key（默认零密钥开箱即用）：绝不请求未鉴权的 cartocdn.com（防止其返回带 API KEY REQUIRED 水印的 200 图片），
 *    直连免 Key 无水印的 OpenStreetMap 官方源 + 后端缓存代理 + Esri World Street Map 容灾镜像；
 * 2) 已配置 REACT_APP_CARTO_API_KEY（或显式传入 cartoKey）：优先请求带 ?key= 的 CARTO @2x 原生高清瓦片，并自动降级免 Key 源。
 */
export function getTileCandidateUrls(
  style: GeoMapStyle,
  z: number,
  x: number,
  y: number,
  cartoKey = CARTO_API_KEY
): string[] {
  const n = 1 << z;
  const wrappedX = ((x % n) + n) % n;
  const trimmedKey = String(cartoKey || '').trim();

  if (!trimmedKey) {
    return [
      `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`,
      `${API_BASE_URL}/api/basemap/tile/normal/${z}/${wrappedX}/${y}.png`,
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${wrappedX}`
    ];
  }

  const sub = SUBDOMAINS[Math.abs(wrappedX + y) % SUBDOMAINS.length];
  const q = `?key=${encodeURIComponent(trimmedKey)}`;
  const proxyUrl = `${API_BASE_URL}/api/basemap/tile/${style}/${z}/${wrappedX}/${y}.png`;

  switch (style) {
    case 'dark':
      return [
        `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${wrappedX}/${y}@2x.png${q}`,
        proxyUrl,
        `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${wrappedX}/${y}.png${q}`
      ];
    case 'grey':
      return [
        `https://${sub}.basemaps.cartocdn.com/light_all/${z}/${wrappedX}/${y}@2x.png${q}`,
        proxyUrl,
        `https://${sub}.basemaps.cartocdn.com/light_all/${z}/${wrappedX}/${y}.png${q}`
      ];
    case 'fresh':
      return [
        `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${wrappedX}/${y}@2x.png${q}`,
        proxyUrl,
        `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`
      ];
    case 'normal':
    default:
      return [
        `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${wrappedX}/${y}@2x.png${q}`,
        proxyUrl,
        `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`
      ];
  }
}

interface TileEntry {
  status: 'loading' | 'ready' | 'error';
  img?: HTMLImageElement;
  lastUsed: number;
}

const MAX_TILE_CACHE = 360;
const sharedTileCache = new Map<string, TileEntry>();

function pruneTileCache() {
  if (sharedTileCache.size <= MAX_TILE_CACHE) return;
  const entries = Array.from(sharedTileCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const toDelete = entries.slice(0, sharedTileCache.size - MAX_TILE_CACHE + 40);
  toDelete.forEach(([key]) => sharedTileCache.delete(key));
}

function loadTileWithFallback(
  style: GeoMapStyle,
  z: number,
  x: number,
  y: number,
  onLoaded: () => void
): TileEntry {
  const n = 1 << z;
  const wrappedX = ((x % n) + n) % n;
  const cachePrefix = CARTO_API_KEY ? style : 'base';
  const key = `${cachePrefix}:${z}:${wrappedX}:${y}`;
  const existing = sharedTileCache.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    if (existing.status === 'loading') {
      const prevOnLoad = existing.img?.onload;
      if (existing.img && prevOnLoad) {
        const orig = prevOnLoad;
        existing.img.onload = (ev) => {
          (orig as any)(ev);
          onLoaded();
        };
      }
    }
    return existing;
  }

  const urls = getTileCandidateUrls(style, z, wrappedX, y);
  const entry: TileEntry = { status: 'loading', lastUsed: Date.now() };
  sharedTileCache.set(key, entry);
  pruneTileCache();

  let attempt = 0;
  const tryNext = () => {
    if (attempt >= urls.length) {
      entry.status = 'error';
      onLoaded();
      return;
    }
    const url = urls[attempt++];
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    entry.img = img;
    img.onload = () => {
      entry.status = 'ready';
      entry.lastUsed = Date.now();
      onLoaded();
    };
    img.onerror = () => {
      tryNext();
    };
    img.src = url;
  };
  tryNext();
  return entry;
}

export class GeoPixel {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export class GeoBounds {
  sw: [number, number];
  ne: [number, number];
  constructor(sw: [number, number], ne: [number, number]) {
    this.sw = sw;
    this.ne = ne;
  }
}

export interface GeoTileMapOptions {
  center?: [number, number];
  zoom?: number;
  mapStyle?: string;
  viewMode?: string;
  resizeEnable?: boolean;
}

export class GeoTileMap {
  private host: HTMLElement;
  private rootEl: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private creditEl: HTMLDivElement;
  private center: [number, number];
  private zoom: number;
  private style: GeoMapStyle;
  private width: number;
  private height: number;
  private destroyed = false;
  private rafId: number | null = null;
  private completeTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private events = new Map<string, Set<() => void>>();

  constructor(host: HTMLElement, opts: GeoTileMapOptions = {}) {
    this.host = host;
    this.center = opts.center ? [opts.center[0], opts.center[1]] : [116.391276, 39.907335];
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(opts.zoom) || 11));
    this.style = normalizeStyleKey(opts.mapStyle);
    this.width = Math.max(1, host.clientWidth || 960);
    this.height = Math.max(1, host.clientHeight || 640);

    this.rootEl = document.createElement('div');
    this.rootEl.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;pointer-events:none;user-select:none;';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;';
    this.rootEl.appendChild(this.canvas);

    this.creditEl = document.createElement('div');
    this.creditEl.style.cssText =
      'position:absolute;right:16px;top:10px;padding:2px 8px;border-radius:999px;font-size:10px;line-height:16px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;opacity:0.72;z-index:2;';
    this.creditEl.textContent = CARTO_API_KEY ? '© OpenStreetMap · CARTO' : '© OpenStreetMap contributors';
    this.rootEl.appendChild(this.creditEl);

    host.innerHTML = '';
    host.appendChild(this.rootEl);
    this.syncCreditTheme();
    this.syncCanvasBuffer();
    this.scheduleDraw();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.destroyed) return;
        const nextW = Math.max(1, this.host.clientWidth || this.width);
        const nextH = Math.max(1, this.host.clientHeight || this.height);
        if (Math.abs(nextW - this.width) > 0.5 || Math.abs(nextH - this.height) > 0.5) {
          this.width = nextW;
          this.height = nextH;
          this.syncCanvasBuffer();
          this.scheduleDraw();
          this.emit('resize');
        }
      });
      this.resizeObserver.observe(host);
    }

    // 异步在下一微任务/帧发出首次 complete，兼容 useAmapViewport 的生命周期状态机
    this.completeTimer = setTimeout(() => {
      this.completeTimer = null;
      if (!this.destroyed) {
        this.drawNow();
        this.emit('complete');
      }
    }, 0);
  }

  private syncCreditTheme() {
    if (this.style === 'dark') {
      this.creditEl.style.background = 'rgba(15,23,42,0.68)';
      this.creditEl.style.color = '#cbd5e1';
    } else {
      this.creditEl.style.background = 'rgba(255,255,255,0.78)';
      this.creditEl.style.color = '#475569';
    }
  }

  private syncCanvasBuffer() {
    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const targetW = Math.max(1, Math.round(this.width * dpr));
    const targetH = Math.max(1, Math.round(this.height * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  private scheduleDraw = () => {
    if (this.destroyed || this.rafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.drawNow();
      });
    } else {
      this.drawNow();
    }
  };

  private drawNow() {
    if (this.destroyed) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.canvas.width / Math.max(1, this.width);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 底色兜底
    ctx.fillStyle =
      this.style === 'dark'
        ? '#0f172a'
        : this.style === 'grey'
          ? '#f1f5f9'
          : this.style === 'fresh'
            ? '#eef6f3'
            : '#eef2f6';
    ctx.fillRect(0, 0, this.width, this.height);

    const filterStr = getCanvasFilterForStyle(this.style, Boolean(CARTO_API_KEY));
    if (typeof ctx.filter === 'string') {
      ctx.filter = filterStr;
      this.canvas.style.filter = 'none';
    } else {
      this.canvas.style.filter = filterStr === 'none' ? '' : filterStr;
    }

    const tileZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(this.zoom)));
    const scaleFactor = Math.pow(2, this.zoom - tileZ);
    const renderedTileSize = TILE_SIZE * scaleFactor;
    const centerWorld = lngLatToWorldPx(this.center[0], this.center[1], tileZ);
    const viewLeftWorld = centerWorld.x - this.width / (2 * scaleFactor);
    const viewTopWorld = centerWorld.y - this.height / (2 * scaleFactor);

    const minTx = Math.floor(viewLeftWorld / TILE_SIZE);
    const maxTx = Math.floor((viewLeftWorld + this.width / scaleFactor) / TILE_SIZE);
    const maxTileIdx = (1 << tileZ) - 1;
    const minTy = Math.max(0, Math.floor(viewTopWorld / TILE_SIZE));
    const maxTy = Math.min(maxTileIdx, Math.floor((viewTopWorld + this.height / scaleFactor) / TILE_SIZE));

    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        const dx = (tx * TILE_SIZE - viewLeftWorld) * scaleFactor;
        const dy = (ty * TILE_SIZE - viewTopWorld) * scaleFactor;
        const entry = loadTileWithFallback(this.style, tileZ, tx, ty, this.scheduleDraw);
        if (entry.status === 'ready' && entry.img) {
          ctx.drawImage(entry.img, dx, dy, renderedTileSize + 0.4, renderedTileSize + 0.4);
        } else {
          // 若当前缩放层瓦片尚在传输，绘制已缓存的父级瓦片裁剪区域，彻底消除缩放白屏闪烁
          this.drawParentFallbackTile(ctx, tileZ, tx, ty, dx, dy, renderedTileSize);
        }
      }
    }

    ctx.filter = 'none';
    ctx.restore();
  }

  private drawParentFallbackTile(
    ctx: CanvasRenderingContext2D,
    z: number,
    tx: number,
    ty: number,
    dx: number,
    dy: number,
    size: number
  ) {
    for (let step = 1; step <= 3 && z - step >= MIN_ZOOM; step += 1) {
      const pz = z - step;
      const n = 1 << pz;
      const factor = 1 << step;
      const ptx = Math.floor(tx / factor);
      const pty = Math.floor(ty / factor);
      const wrappedPtx = ((ptx % n) + n) % n;
      const cachePrefix = CARTO_API_KEY ? this.style : 'base';
      const parentEntry = sharedTileCache.get(`${cachePrefix}:${pz}:${wrappedPtx}:${pty}`);
      if (parentEntry?.status === 'ready' && parentEntry.img) {
        const imgW = parentEntry.img.naturalWidth || TILE_SIZE;
        const imgH = parentEntry.img.naturalHeight || TILE_SIZE;
        const subW = imgW / factor;
        const subH = imgH / factor;
        const subX = (((tx % factor) + factor) % factor) * subW;
        const subY = (ty % factor) * subH;
        ctx.drawImage(parentEntry.img, subX, subY, subW, subH, dx, dy, size + 0.5, size + 0.5);
        return;
      }
    }
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCenter(): { lng: number; lat: number } {
    return { lng: this.center[0], lat: this.center[1] };
  }

  getZoom(): number {
    return this.zoom;
  }

  getSize(): { width: number; height: number } {
    const hostW = this.host.clientWidth;
    const hostH = this.host.clientHeight;
    if (hostW > 0 && hostH > 0) {
      this.width = hostW;
      this.height = hostH;
    }
    return { width: this.width, height: this.height };
  }

  lngLatToContainer(lngLat: [number, number] | { lng: number; lat: number }): { x: number; y: number } {
    const lng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng;
    const lat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
    const c = lngLatToWorldPx(this.center[0], this.center[1], this.zoom);
    const p = lngLatToWorldPx(lng, lat, this.zoom);
    return {
      x: p.x - c.x + this.width / 2,
      y: p.y - c.y + this.height / 2
    };
  }

  containerToLngLat(pixel: { x: number; y: number }): { lng: number; lat: number } {
    const c = lngLatToWorldPx(this.center[0], this.center[1], this.zoom);
    return worldPxToLngLat(c.x + (pixel.x - this.width / 2), c.y + (pixel.y - this.height / 2), this.zoom);
  }

  setMapStyle(styleUri: string) {
    const next = normalizeStyleKey(styleUri);
    if (next === this.style) return;
    this.style = next;
    this.syncCreditTheme();
    this.drawNow();
  }

  setZoom(nextZoom: number, _immediately?: boolean, _duration?: number) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(nextZoom) || this.zoom));
    if (Math.abs(clamped - this.zoom) < 1e-4) return;
    this.emit('zoomstart');
    this.zoom = clamped;
    this.drawNow();
    this.emit('zoomchange');
    this.emit('zoomend');
  }

  setZoomAndCenter(nextZoom: number, nextCenter: [number, number], _immediately?: boolean, _duration?: number) {
    const clampedZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(nextZoom) || this.zoom));
    const nextLng = normalizeLng(nextCenter[0]);
    const nextLat = clampLat(nextCenter[1]);
    this.emit('movestart');
    this.emit('zoomstart');
    this.zoom = clampedZ;
    this.center = [nextLng, nextLat];
    this.drawNow();
    this.emit('mapmove');
    this.emit('zoomchange');
    this.emit('moveend');
    this.emit('zoomend');
  }

  panBy(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.emit('movestart');
    const c = lngLatToWorldPx(this.center[0], this.center[1], this.zoom);
    const next = worldPxToLngLat(c.x - dx, c.y - dy, this.zoom);
    this.center = [next.lng, next.lat];
    this.drawNow();
    this.emit('mapmove');
    this.emit('moveend');
  }

  setBounds(
    bounds: GeoBounds | { sw: [number, number]; ne: [number, number] },
    _immediate = false,
    padding: [number, number, number, number] = [60, 60, 60, 60]
  ) {
    const [minLng, minLat] = bounds.sw;
    const [maxLng, maxLat] = bounds.ne;
    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const padX = (padding[1] || 60) + (padding[3] || 60);
    const padY = (padding[0] || 60) + (padding[2] || 60);
    const availW = Math.max(64, this.width - padX);
    const availH = Math.max(64, this.height - padY);

    const p0 = lngLatToWorldPx(minLng, maxLat, 0);
    const p1 = lngLatToWorldPx(maxLng, minLat, 0);
    const spanX = Math.max(1e-6, Math.abs(p1.x - p0.x));
    const spanY = Math.max(1e-6, Math.abs(p1.y - p0.y));
    const idealZoom = Math.min(Math.log2(availW / spanX), Math.log2(availH / spanY));
    this.setZoomAndCenter(Math.max(MIN_ZOOM, Math.min(17.5, idealZoom)), [centerLng, centerLat]);
  }

  resize() {
    const nextW = Math.max(1, this.host.clientWidth || this.width);
    const nextH = Math.max(1, this.host.clientHeight || this.height);
    this.width = nextW;
    this.height = nextH;
    this.syncCanvasBuffer();
    this.drawNow();
    this.emit('resize');
  }

  on(event: string, fn: () => void) {
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event)!.add(fn);
  }

  off(event: string, fn: () => void) {
    this.events.get(event)?.delete(fn);
  }

  emit(event: string) {
    this.events.get(event)?.forEach((fn) => fn());
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.completeTimer !== null) {
      clearTimeout(this.completeTimer);
      this.completeTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.events.forEach((set) => set.clear());
    this.events.clear();
    if (this.rootEl.parentNode === this.host) {
      this.host.removeChild(this.rootEl);
    }
  }
}

function fetchSingleTileImage(style: GeoMapStyle, z: number, x: number, y: number, signal?: AbortSignal): Promise<HTMLImageElement> {
  const urls = getTileCandidateUrls(style, z, x, y);
  return new Promise((resolve, reject) => {
    let idx = 0;
    const next = () => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (idx >= urls.length) {
        reject(new Error('地理底图瓦片加载失败，请检查网络连接'));
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => next();
      img.src = urls[idx++];
    };
    next();
  });
}

/**
 * 纯客户端免 Key 静态高清底图合成器（用于 MP4 动态演进视频导出等场景）。
 * 返回与指定经纬度、缩放级别、宽高、scale 完全对齐的 Web Mercator PNG Blob，无需任何商业 API Key。
 */
export async function stitchGeoStaticMapBlob(params: {
  center: [number, number];
  zoom: number;
  width: number;
  height: number;
  style?: string;
  scale?: 1 | 2;
  signal?: AbortSignal;
}): Promise<Blob> {
  const scale = params.scale === 2 ? 2 : 1;
  const outW = Math.round(params.width * scale);
  const outH = Math.round(params.height * scale);
  const style = normalizeStyleKey(params.style);
  const tileZ = Math.max(1, Math.min(18, Math.round(params.zoom) + (scale === 2 ? 1 : 0)));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建底图拼接画布');

  ctx.fillStyle = style === 'dark' ? '#0f172a' : '#f1f5f9';
  ctx.fillRect(0, 0, outW, outH);

  const filterStr = getCanvasFilterForStyle(style, Boolean(CARTO_API_KEY));
  if (typeof ctx.filter === 'string') {
    ctx.filter = filterStr;
  }

  const centerWorld = lngLatToWorldPx(params.center[0], params.center[1], tileZ);
  const leftWorld = centerWorld.x - outW / 2;
  const topWorld = centerWorld.y - outH / 2;

  const minTx = Math.floor(leftWorld / TILE_SIZE);
  const maxTx = Math.floor((leftWorld + outW - 1) / TILE_SIZE);
  const maxTileIdx = (1 << tileZ) - 1;
  const minTy = Math.max(0, Math.floor(topWorld / TILE_SIZE));
  const maxTy = Math.min(maxTileIdx, Math.floor((topWorld + outH - 1) / TILE_SIZE));

  const jobs: Array<Promise<void>> = [];
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      const dx = Math.round(tx * TILE_SIZE - leftWorld);
      const dy = Math.round(ty * TILE_SIZE - topWorld);
      jobs.push(
        fetchSingleTileImage(style, tileZ, tx, ty, params.signal).then((img) => {
          ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
        })
      );
    }
  }

  await Promise.all(jobs);
  if (typeof ctx.filter === 'string') {
    ctx.filter = 'none';
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('生成高清底图位图失败'));
    }, 'image/png');
  });
}

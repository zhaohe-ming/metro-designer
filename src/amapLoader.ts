import { GeoBounds, GeoPixel, GeoTileMap } from './lib/geoTileMap';
import { gcj02ToWgs84, wgs84ToGcj02 } from './lib/coordTransform';
import { isCustomAmapActive, loadCustomAmapConfig } from './lib/amapCustomConfig';

export interface GeoBaseMapSDK {
  Map: any;
  Pixel: any;
  Bounds: any;
}

const BUILTIN_TILE_SDK: GeoBaseMapSDK = {
  Map: GeoTileMap,
  Pixel: GeoPixel,
  Bounds: GeoBounds
};

let cachedScriptKey = '';
let cachedRealAMap: any = null;
let inflightLoadPromise: Promise<any> | null = null;

/**
 * 将高德 JS API 2.0 原生 GCJ-02 地图实例透明包装为统一 WGS-84 接口，
 * 使内置标准瓦片与用户自配高德矢量底图来回一键切换时，车站与线路坐标零偏移、无需改存档。
 */
class AmapWgs84AdapterMap {
  private realMap: any;
  private realAMap: any;

  constructor(host: HTMLElement, opts: { center: [number, number]; zoom: number; viewMode?: string; mapStyle?: string; resizeEnable?: boolean }) {
    const RealAMap = cachedRealAMap || (window as any).__metroRealAMap || (window as any).AMap;
    this.realAMap = RealAMap;
    const gcjCenter = wgs84ToGcj02(opts.center[0], opts.center[1]);
    this.realMap = new RealAMap.Map(host, {
      center: gcjCenter,
      zoom: opts.zoom,
      viewMode: opts.viewMode || '2D',
      mapStyle: opts.mapStyle || 'amap://styles/normal',
      resizeEnable: opts.resizeEnable !== false,
      WebGLParams: {
        preserveDrawingBuffer: true
      }
    });
  }

  getCenter(): { lng: number; lat: number } | null {
    const c = this.realMap.getCenter?.();
    if (!c || !Number.isFinite(c.lng) || !Number.isFinite(c.lat)) return null;
    const [lng, lat] = gcj02ToWgs84(Number(c.lng), Number(c.lat));
    return { lng, lat };
  }

  getZoom(): number {
    return Number(this.realMap.getZoom?.());
  }

  getSize(): { width: number; height: number } {
    const s = this.realMap.getSize?.();
    const width = Number(s?.width ?? s?.getWidth?.() ?? 0);
    const height = Number(s?.height ?? s?.getHeight?.() ?? 0);
    return { width, height };
  }

  lngLatToContainer(lngLat: [number, number] | { lng: number; lat: number }): { x: number; y: number } | null {
    const wgsLng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng;
    const wgsLat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
    const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
    const arg = this.realAMap?.LngLat ? new this.realAMap.LngLat(gcjLng, gcjLat) : [gcjLng, gcjLat];
    const px = this.realMap.lngLatToContainer?.(arg);
    if (!px) return null;
    const x = Number(px.x ?? px.getX?.());
    const y = Number(px.y ?? px.getY?.());
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  containerToLngLat(pixel: { x: number; y: number } | any): { lng: number; lat: number } | null {
    const pxX = Number(pixel?.x ?? pixel?.getX?.() ?? 0);
    const pxY = Number(pixel?.y ?? pixel?.getY?.() ?? 0);
    const arg = this.realAMap?.Pixel ? new this.realAMap.Pixel(pxX, pxY) : pixel;
    const ll = this.realMap.containerToLngLat?.(arg);
    if (!ll) return null;
    const rawLng = Number(ll.lng ?? ll.getLng?.());
    const rawLat = Number(ll.lat ?? ll.getLat?.());
    if (!Number.isFinite(rawLng) || !Number.isFinite(rawLat)) return null;
    const [lng, lat] = gcj02ToWgs84(rawLng, rawLat);
    return { lng, lat };
  }

  setMapStyle(styleUri: string) {
    this.realMap.setMapStyle?.(styleUri);
  }

  setZoom(nextZoom: number, immediately?: boolean, duration?: number) {
    this.realMap.setZoom?.(nextZoom, immediately, duration);
  }

  setCenter(nextCenter: [number, number], immediately?: boolean, duration?: number) {
    const gcj = wgs84ToGcj02(nextCenter[0], nextCenter[1]);
    this.realMap.setCenter?.(gcj, immediately, duration);
  }

  setZoomAndCenter(nextZoom: number, nextCenter: [number, number], immediately?: boolean, duration?: number) {
    const gcj = wgs84ToGcj02(nextCenter[0], nextCenter[1]);
    this.realMap.setZoomAndCenter?.(nextZoom, gcj, immediately, duration);
  }

  panBy(dx: number, dy: number) {
    this.realMap.panBy?.(dx, dy);
  }

  setBounds(bounds: GeoBounds | { sw: [number, number]; ne: [number, number] }, immediate = false, padding: [number, number, number, number] = [60, 60, 60, 60]) {
    const sw = (bounds as any).sw;
    const ne = (bounds as any).ne;
    if (Array.isArray(sw) && Array.isArray(ne) && this.realAMap?.Bounds) {
      const gcjSw = wgs84ToGcj02(sw[0], sw[1]);
      const gcjNe = wgs84ToGcj02(ne[0], ne[1]);
      this.realMap.setBounds?.(new this.realAMap.Bounds(gcjSw, gcjNe), immediate, padding);
      return;
    }
    this.realMap.setBounds?.(bounds, immediate, padding);
  }

  resize() {
    this.realMap.resize?.();
  }

  on(event: string, fn: () => void) {
    this.realMap.on?.(event, fn);
  }

  off(event: string, fn: () => void) {
    this.realMap.off?.(event, fn);
  }

  destroy() {
    this.realMap.destroy?.();
  }
}

function loadOfficialAmapJsSdk(apiKey: string, securityJsCode: string): Promise<any> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境不支持加载高德地图脚本'));
  }

  const cleanKey = apiKey.trim();
  const cleanSec = securityJsCode.trim();
  const compositeKey = `${cleanKey}::${cleanSec}`;

  if (cachedRealAMap && cachedScriptKey === compositeKey) {
    return Promise.resolve(cachedRealAMap);
  }

  if (inflightLoadPromise && cachedScriptKey === compositeKey) {
    return inflightLoadPromise;
  }

  // 配置高德 JS API 2.0 安全密钥（2021年12月后申请的 Key 必填）
  if (cleanSec) {
    (window as any)._AMapSecurityConfig = {
      securityJsCode: cleanSec
    };
  } else {
    delete (window as any)._AMapSecurityConfig;
  }

  const prevScript = document.getElementById('metro-custom-amap-js-sdk');
  if (prevScript) {
    prevScript.remove();
  }
  cachedRealAMap = null;
  delete (window as any).__metroRealAMap;
  // 清理内置瓦片挂载在 window.AMap 上的占位对象，让高德官方脚本正常注入
  if ((window as any).AMap === BUILTIN_TILE_SDK) {
    delete (window as any).AMap;
  }

  cachedScriptKey = compositeKey;
  inflightLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'metro-custom-amap-js-sdk';
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(cleanKey)}`;

    const timer = window.setTimeout(() => {
      inflightLoadPromise = null;
      reject(new Error('高德 JS API 脚本加载超时，请检查网络连接'));
    }, 12_000);

    script.onload = () => {
      window.clearTimeout(timer);
      inflightLoadPromise = null;
      const injected = (window as any).AMap;
      if (injected && typeof injected.Map === 'function' && injected.Map !== GeoTileMap) {
        cachedRealAMap = injected;
        (window as any).__metroRealAMap = injected;
        resolve(injected);
      } else {
        reject(new Error('高德地图初始化失败：请确认填写的是「Web端 (JS API)」类型的 Key'));
      }
    };

    script.onerror = () => {
      window.clearTimeout(timer);
      inflightLoadPromise = null;
      reject(new Error('无法连接高德开放平台服务器（webapi.amap.com），请检查网络'));
    };

    document.head.appendChild(script);
  });

  return inflightLoadPromise;
}

export const getAmapConfig = () => {
  if (isCustomAmapActive()) {
    const cfg = loadCustomAmapConfig();
    return {
      key: `custom-amap:${cfg.apiKey}:${cfg.securityJsCode}`,
      securityCode: cfg.securityJsCode || 'none'
    };
  }
  return {
    key: 'open-tile-builtin',
    securityCode: 'open-tile-builtin'
  };
};

export const loadAmap = async (): Promise<GeoBaseMapSDK> => {
  if (isCustomAmapActive()) {
    const cfg = loadCustomAmapConfig();
    const RealAMap = await loadOfficialAmapJsSdk(cfg.apiKey, cfg.securityJsCode);
    const wrappedSdk: GeoBaseMapSDK = {
      Map: AmapWgs84AdapterMap,
      Pixel: GeoPixel,
      Bounds: GeoBounds
    };
    if (typeof window !== 'undefined') {
      (window as any).__metroRealAMap = RealAMap;
      (window as any).AMap = wrappedSdk;
    }
    return wrappedSdk;
  }

  if (typeof window !== 'undefined') {
    (window as any).AMap = BUILTIN_TILE_SDK;
  }
  return BUILTIN_TILE_SDK;
};

/**
 * 实机测试用户填写的高德 Web 端（JS API）Key 与安全密钥是否能真实渲染地图完成。
 */
export async function testCustomAmapConnection(
  apiKey: string,
  securityJsCode: string
): Promise<{ ok: boolean; latencyMs?: number; message: string }> {
  const cleanKey = apiKey.trim();
  if (cleanKey.length < 16) {
    return { ok: false, message: '请输入有效的 32 位高德 Web 端（JS API）Key' };
  }

  const t0 = Date.now();
  try {
    const RealAMap = await loadOfficialAmapJsSdk(cleanKey, securityJsCode);
    const probeHost = document.createElement('div');
    probeHost.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:160px;height:120px;opacity:0;pointer-events:none;';
    document.body.appendChild(probeHost);

    return await new Promise((resolve) => {
      let settled = false;
      let mapInstance: any = null;

      const finish = (res: { ok: boolean; latencyMs?: number; message: string }) => {
        if (settled) return;
        settled = true;
        try {
          mapInstance?.destroy?.();
        } catch {
          /* ignore */
        }
        probeHost.remove();
        resolve(res);
      };

      const timer = window.setTimeout(() => {
        finish({
          ok: false,
          message:
            '底图瓦片鉴权超时：请检查 1) Key 服务平台是否选对了「Web端 (JS API)」（不能选 Web服务）；2) 安全密钥 (jscode) 是否填写正确'
        });
      }, 7500);

      try {
        mapInstance = new RealAMap.Map(probeHost, {
          center: [116.397428, 39.90923],
          zoom: 11,
          viewMode: '2D'
        });
        mapInstance.on('complete', () => {
          window.clearTimeout(timer);
          finish({
            ok: true,
            latencyMs: Date.now() - t0,
            message: `高德矢量底图验证成功（耗时 ${Date.now() - t0}ms）`
          });
        });
      } catch (err: any) {
        window.clearTimeout(timer);
        finish({
          ok: false,
          message: err?.message || '高德地图实例创建失败，请核对 Key 类型与安全密钥'
        });
      }
    });
  } catch (err: any) {
    return {
      ok: false,
      message: err?.message || '高德脚本加载失败'
    };
  }
}

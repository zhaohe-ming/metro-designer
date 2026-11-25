// 免 Key 开源地理底图瓦片缓存代理：
// 1. 聚合 CARTO Fastly CDN 与 OpenStreetMap 多源上游，自动容灾重试；
// 2. 进程内 LRU 内存缓存（默认 600 张瓦片，24 小时有效）+ 浏览器 7 天强缓存，大幅降低上游带宽与国内访问延迟；
// 3. 完整返回 Access-Control-Allow-Origin: *，保证前端 Canvas 导出 PNG / MP4 视频绝不触发跨域污染（Tainted Canvas）。

const MAX_CACHE_ENTRIES = 600;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUBDOMAINS = ['a', 'b', 'c', 'd'];

const tileMemoryCache = new Map(); // key -> { buffer, contentType, expiresAt }

function getCachedTile(key) {
  const hit = tileMemoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    tileMemoryCache.delete(key);
    return null;
  }
  // Refresh LRU order
  tileMemoryCache.delete(key);
  tileMemoryCache.set(key, hit);
  return hit;
}

function setCachedTile(key, buffer, contentType) {
  if (tileMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = tileMemoryCache.keys().next().value;
    if (oldestKey !== undefined) tileMemoryCache.delete(oldestKey);
  }
  tileMemoryCache.set(key, {
    buffer,
    contentType: contentType || 'image/png',
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function buildUpstreamUrls(style, z, x, y) {
  const sub = SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
  switch (style) {
    case 'dark':
      return [
        `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`,
        `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`
      ];
    case 'grey':
      return [
        `https://${sub}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}@2x.png`,
        `https://${sub}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`
      ];
    case 'fresh':
      return [
        `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}@2x.png`,
        `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,
        `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
      ];
    case 'normal':
    default:
      return [
        `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}@2x.png`,
        `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
      ];
  }
}

async function fetchUpstreamTile(urls, fetchImpl = fetch) {
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'MetroDesigner/1.2 (+https://www.metro-designer.com)',
          Accept: 'image/png,image/webp,image/*;q=0.8'
        },
        signal: controller.signal
      });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || 'image/png';
        if (contentType.startsWith('image/')) {
          const ab = await response.arrayBuffer();
          return { ok: true, buffer: Buffer.from(ab), contentType };
        }
      }
    } catch {
      // Try next mirror
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false };
}

function createTileProxyHandler({ fetchImpl = fetch } = {}) {
  return async function handleTileProxy(req, res) {
    const rawStyle = String(req.params.style || 'normal');
    const style = ['normal', 'grey', 'dark', 'fresh'].includes(rawStyle) ? rawStyle : null;
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const rawY = String(req.params.y || '').replace(/\.(png|webp|jpg)$/i, '');
    const y = Number(rawY);

    if (!style || !Number.isInteger(z) || z < 0 || z > 19) {
      return res.status(400).json({ message: '无效的瓦片层级或样式参数' });
    }
    const maxCoord = 1 << z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= maxCoord || y < 0 || y >= maxCoord) {
      return res.status(400).json({ message: '瓦片行列坐标超出范围' });
    }

    const cacheKey = `${style}:${z}:${x}:${y}`;
    const cached = getCachedTile(cacheKey);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      res.setHeader('X-Tile-Cache', 'HIT');
      return res.send(cached.buffer);
    }

    const fetched = await fetchUpstreamTile(buildUpstreamUrls(style, z, x, y), fetchImpl);
    if (!fetched.ok) {
      return res.status(502).json({ message: '上游地理底图瓦片暂时不可达，请稍后重试' });
    }

    setCachedTile(cacheKey, fetched.buffer, fetched.contentType);
    res.setHeader('Content-Type', fetched.contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    res.setHeader('X-Tile-Cache', 'MISS');
    return res.send(fetched.buffer);
  };
}

module.exports = {
  createTileProxyHandler,
  buildUpstreamUrls
};

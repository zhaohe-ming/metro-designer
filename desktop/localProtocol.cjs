const fs = require('node:fs');
const path = require('node:path');
const { isSite, API_ORIGIN } = require('./policy.cjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function hasBundledWeb(webRoot) {
  try {
    return fs.statSync(path.join(webRoot, 'index.html')).isFile();
  } catch {
    return false;
  }
}

/**
 * 将 https://www.metro-designer.com/<pathname> 安全映射到内置 web 目录下的静态文件：
 * - 严格拦截任何 .. 路径穿越；
 * - 命中真实静态文件则直接返回该文件路径；
 * - 无扩展名的前端路由（如 /、/gallery、/works/123）统一回退到 index.html；
 * - 带扩展名但不存在的资源返回 null（404）。
 */
function resolveBundledAssetPath(webRoot, rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname || '/');
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;

  const normalizedPosix = decoded.replace(/\\/g, '/');
  const trimmed = normalizedPosix.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(webRoot);
  const indexFile = path.join(resolvedRoot, 'index.html');

  if (!trimmed) {
    return hasBundledWeb(resolvedRoot) ? indexFile : null;
  }

  const candidate = path.resolve(resolvedRoot, trimmed);
  const rel = path.relative(resolvedRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
  } catch {
    /* fall through to SPA route check */
  }

  // 无文件扩展名的路径视为前端 SPA 路由，离线直接返回 index.html
  if (!path.extname(trimmed)) {
    return hasBundledWeb(resolvedRoot) ? indexFile : null;
  }

  return null;
}

function attachLocalFirstProtocol({ session, webRoot, apiOrigin = API_ORIGIN }) {
  session.protocol.handle('https', async (request) => {
    if (isSite(request.url)) {
      const parsed = new URL(request.url);

      // 兜底转发相对 /api/* 请求至生产 API 服务
      if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) {
        const targetUrl = `${apiOrigin}${parsed.pathname}${parsed.search}`;
        return session.fetch(new Request(targetUrl, request), {
          bypassCustomProtocolHandlers: true
        });
      }

      if (hasBundledWeb(webRoot)) {
        const assetPath = resolveBundledAssetPath(webRoot, parsed.pathname);
        if (!assetPath) {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
        const body = await fs.promises.readFile(assetPath);
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': mimeTypeForPath(assetPath),
            'Cache-Control': 'no-cache'
          }
        });
      }
    }

    return session.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

module.exports = {
  mimeTypeForPath,
  hasBundledWeb,
  resolveBundledAssetPath,
  attachLocalFirstProtocol
};

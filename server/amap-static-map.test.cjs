const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const start = source.indexOf("app.get('/api/amap/static-map'");
const end = source.indexOf('\n// 注册：', start);
const base = { lng: 117.123456789, lat: 39.987654321, zoom: 12, width: 1024, height: 540, scale: 2 };
function setup({ key = 'test-key', upstream } = {}) {
  let handler, params;
  vm.runInNewContext(source.slice(start, end), {
    app: { get: (_path, _auth, _limiter, fn) => { handler = fn; } },
    auth: null, amapLimiter: null, asyncHandler: fn => fn, AMAP_WEB_SERVICE_KEY: key,
    DEFAULT_MAP_SETTINGS: { baseMap: { amap: { zoom: 11 } } },
    URLSearchParams, AbortController, setTimeout, clearTimeout, Buffer, console: { error() {} },
    fetch: async (url, options) => {
      params = new URL(url).searchParams;
      return upstream ? upstream(options) : { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
  });
  return { params: () => params, request: async (query = base) => {
    const res = Object.assign(new EventEmitter(), { code: 200, destroyed: false, headers: {},
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
      setHeader(key, value) { this.headers[key] = value; }, send(body) { this.body = body; } });
    await handler({ query }, res);
    assert.equal(res.listenerCount('close'), 0);
    return res;
  } };
}
test('高清参数与六位坐标准确发送，不变更原地理覆盖范围', async () => {
  const api = setup(); const result = await api.request();
  assert.equal(result.code, 200);
  assert.equal(api.params().get('scale'), '2');
  assert.equal(api.params().get('size'), '1024*540');
  assert.equal(api.params().get('location'), '117.123457,39.987654');
  assert.equal((await api.request({ ...base, scale: 3 })).code, 400);
  assert.equal((await api.request({ ...base, width: 2048 })).code, 400);
});
test('缺少 Key 时明确报告配置错误', async () => {
  const result = await setup({ key: '' }).request();
  assert.equal(result.code, 400);
  assert.match(result.body.message, /AMAP_WEB_SERVICE_KEY/);
});
test('保留可识别的上游错误码，提示 Key 类型或配额', async () => {
  for (const [code, hint] of [['10009', 'Web服务'], ['10003', '配额']]) {
    const result = await setup({ upstream: async () => ({ ok: true, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ status: '0', infocode: code, info: 'USERKEY_PLAT_NOMATCH' }) }) }).request();
    assert.equal(result.code, 502);
    assert.ok(result.body.message.includes(code) && result.body.message.includes(hint));
  }
});
test('代理失败不会把上游原文和密钥回传到前端', async () => {
  const result = await setup({ upstream: async () => ({ ok: false, headers: { get: () => 'text/html' }, text: async () => 'private-key-secret' }) }).request();
  assert.equal(result.code, 502);
  assert.ok(!result.body.message.includes('private-key-secret'));
  const network = await setup({ upstream: async () => { throw new Error('private-key-secret'); } }).request();
  assert.equal(network.code, 502);
  assert.ok(!network.body.message.includes('private-key-secret'));
});

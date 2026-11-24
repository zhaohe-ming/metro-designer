const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveBundledAssetPath,
  attachLocalFirstProtocol
} = require('./localProtocol.cjs');

function makeTempWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-web-test-'));
  fs.mkdirSync(path.join(dir, 'static', 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root">local</div>', 'utf8');
  fs.writeFileSync(path.join(dir, 'privacy.html'), '<h1>隐私说明</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'static', 'js', 'main.js'), 'console.log("ok");', 'utf8');
  return dir;
}

test('resolves static files, falls back SPA routes to index.html, and blocks path traversal', () => {
  const root = makeTempWebRoot();
  try {
    assert.equal(resolveBundledAssetPath(root, '/'), path.join(root, 'index.html'));
    assert.equal(resolveBundledAssetPath(root, '/gallery'), path.join(root, 'index.html'));
    assert.equal(resolveBundledAssetPath(root, '/works/w_123'), path.join(root, 'index.html'));
    assert.equal(resolveBundledAssetPath(root, '/privacy.html'), path.join(root, 'privacy.html'));
    assert.equal(
      resolveBundledAssetPath(root, '/static/js/main.js'),
      path.join(root, 'static', 'js', 'main.js')
    );
    assert.equal(resolveBundledAssetPath(root, '/static/js/missing.js'), null);
    assert.equal(resolveBundledAssetPath(root, '/%2e%2e/%2e%2e/Windows/win.ini'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local-first protocol serves bundled SPA offline and forwards API & external requests', async () => {
  const root = makeTempWebRoot();
  let handler = null;
  const forwarded = [];
  const mockSession = {
    protocol: {
      handle(scheme, fn) {
        assert.equal(scheme, 'https');
        handler = fn;
      }
    },
    async fetch(req, opts) {
      const url = typeof req === 'string' ? req : req.url;
      forwarded.push({ url, opts });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  };

  try {
    attachLocalFirstProtocol({
      session: mockSession,
      webRoot: root,
      apiOrigin: 'https://metro-designer-api.onrender.com'
    });

    const homeRes = await handler(new Request('https://www.metro-designer.com/?workbench=1'));
    assert.equal(homeRes.status, 200);
    assert.match(await homeRes.text(), /id="root"/);
    assert.equal(forwarded.length, 0);

    const apiRes = await handler(new Request('https://www.metro-designer.com/api/health?x=1'));
    assert.equal(apiRes.status, 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, 'https://metro-designer-api.onrender.com/api/health?x=1');
    assert.equal(forwarded[0].opts.bypassCustomProtocolHandlers, true);

    await handler(new Request('https://webapi.amap.com/maps?v=2.0'));
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[1].url, 'https://webapi.amap.com/maps?v=2.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

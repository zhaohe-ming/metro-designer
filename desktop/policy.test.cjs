const test = require('node:test');
const assert = require('node:assert/strict');
const { isSite, isExternalLink, isExport } = require('./policy.cjs');

test('navigation is restricted to exact HTTPS site origins', () => {
  for (const url of ['https://www.metro-designer.com/', 'https://metro-designer.com/?token=x']) assert.equal(isSite(url), true);
  for (const url of ['http://www.metro-designer.com/', 'https://metro-designer.com.evil.test', 'https://metro-designer.com@evil.test', 'file:///C:/Windows/system.ini', 'javascript:alert(1)', 'invalid']) assert.equal(isSite(url), false);
});
test('external handler accepts HTTPS and email only', () => {
  assert.equal(isExternalLink('https://github.com/zhaohe-ming/metro-designer'), true);
  assert.equal(isExternalLink('mailto:hello@example.com'), true);
  for (const url of ['file:///C:/Windows', 'cmd:calc.exe', 'javascript:alert(1)', 'http://example.com']) assert.equal(isExternalLink(url), false);
});
test('only site-owned blobs and supported data exports are recognized', () => {
  assert.equal(isExport('blob:https://www.metro-designer.com/123'), true);
  assert.equal(isExport('data:image/png;base64,AAAA'), true);
  assert.equal(isExport('data:video/webm;base64,AAAA'), true);
  assert.equal(isExport('blob:https://evil.test/123'), false);
  assert.equal(isExport('data:text/html,<script></script>'), false);
});

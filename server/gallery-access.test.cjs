const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveGalleryAdmins } = require('./lib/galleryAccess');

test('reviewed server configuration grants only the approved account', () => {
  assert.deepEqual([...resolveGalleryAdmins(undefined)], ['3855166698@qq.com']);
});
test('environment override replaces rather than expands the configured accounts', () => {
  assert.deepEqual([...resolveGalleryAdmins(' ADMIN@EXAMPLE.TEST, admin@example.test ')], ['admin@example.test']);
});
test('explicitly empty environment override disables all moderation accounts', () => {
  assert.equal(resolveGalleryAdmins('').size, 0);
});

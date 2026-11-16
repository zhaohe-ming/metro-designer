const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachUpdates } = require('./updates.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(responses = []) {
  const updater = new EventEmitter();
  const calls = { check: 0, download: 0, install: 0, dialogs: [], progress: [] };
  updater.checkForUpdates = async () => { calls.check += 1; };
  updater.downloadUpdate = async () => { calls.download += 1; };
  updater.quitAndInstall = () => { calls.install += 1; };
  const controller = attachUpdates({ updater, isPackaged: true, getVersion: () => '1.1.0',
    getWindow: () => ({ isDestroyed: () => false, setProgressBar: value => calls.progress.push(value) }),
    dialog: { showMessageBox: async (_win, options) => {
      calls.dialogs.push(options); return { response: responses.shift() ?? 1 };
    } }
  });
  return { updater, calls, controller };
}
test('updates require consent to download and separate consent to install', async () => {
  const { updater, calls, controller } = fixture([0, 1, 0]);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  await controller.check();
  updater.emit('update-available', { version: '1.2.0' }); await settle();
  assert.equal(calls.download, 1);
  updater.emit('update-downloaded'); await settle();
  assert.equal(calls.install, 0);
  await controller.check(true);
  assert.equal(calls.install, 1); assert.match(calls.dialogs[1].detail, /保存/);
});
test('postponing update keeps current app running', async () => {
  const { updater, calls, controller } = fixture([1]);
  await controller.check(); updater.emit('update-available', { version: '1.2.0' }); await settle();
  assert.equal(calls.download, 0); assert.equal(calls.install, 0);
});
test('background checks stay quiet when current or offline; manual checks report status', async () => {
  const { updater, calls, controller } = fixture();
  await controller.check(); updater.emit('update-not-available'); await settle();
  assert.equal(calls.dialogs.length, 0);
  await controller.check(); updater.emit('error', new Error('offline')); await settle();
  assert.equal(calls.dialogs.length, 0);
  await controller.check(true); updater.emit('update-not-available'); await settle();
  assert.match(calls.dialogs[0].message, /1\.1\.0/);
});

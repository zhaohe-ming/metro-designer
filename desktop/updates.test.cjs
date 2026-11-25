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

test('never prompts when remote release version is older than or equal to current version (e.g. 1.1.0 vs 1.2.0)', async () => {
  const updater = new EventEmitter();
  const dialogs = [];
  updater.checkForUpdates = async () => {};
  const controller = attachUpdates({
    updater,
    isPackaged: true,
    getVersion: () => '1.2.0',
    getWindow: () => ({ isDestroyed: () => false, setProgressBar: () => {} }),
    dialog: { showMessageBox: async (_w, opts) => { dialogs.push(opts); return { response: 1 }; } }
  });
  await controller.check(false);
  updater.emit('update-available', { version: '1.1.0' });
  await settle();
  assert.equal(dialogs.length, 0);

  await controller.check(true);
  updater.emit('update-available', { version: '1.1.0' });
  await settle();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /已是最新版本 v1\.2\.0/);
});

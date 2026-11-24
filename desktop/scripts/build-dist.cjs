const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const prepareScript = path.join(__dirname, 'prepare-web.cjs');

const prep = spawnSync(process.execPath, [prepareScript], {
  cwd: desktopDir,
  stdio: 'inherit'
});
if (prep.status !== 0) {
  process.exit(prep.status || 1);
}

const localElectronCache = path.join(desktopDir, '.cache', 'electron');
const localBuilderCache = path.join(desktopDir, '.cache', 'builder');

const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false',
  ...(fs.existsSync(localElectronCache) && !process.env.ELECTRON_CACHE
    ? { ELECTRON_CACHE: localElectronCache }
    : {}),
  ...(fs.existsSync(localBuilderCache) && !process.env.ELECTRON_BUILDER_CACHE
    ? { ELECTRON_BUILDER_CACHE: localBuilderCache }
    : {})
};

console.log('[desktop] Packaging Windows x64 NSIS installer...');
const builderCli = path.join(desktopDir, 'node_modules', 'electron-builder', 'cli.js');
const dist = spawnSync(
  process.execPath,
  [builderCli, '--win', 'nsis', '--x64', '--publish', 'never'],
  {
    cwd: desktopDir,
    stdio: 'inherit',
    env
  }
);

process.exit(dist.status || 0);

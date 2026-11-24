const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { API_ORIGIN } = require('../policy.cjs');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const buildDir = path.join(repoRoot, 'build');
const targetWebDir = path.join(desktopDir, 'web');

const skipBuild = process.argv.includes('--skip-build');

if (!skipBuild) {
  console.log('[desktop] Building frontend bundle for local-first desktop app...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      REACT_APP_API_BASE_URL: process.env.REACT_APP_API_BASE_URL || API_ORIGIN,
      GENERATE_SOURCEMAP: 'false'
    }
  });

  if (result.status !== 0) {
    console.error('[desktop] Frontend build failed.');
    process.exit(result.status || 1);
  }
}

if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
  console.error('[desktop] Missing build/index.html. Run `npm run build` in repo root first.');
  process.exit(1);
}

fs.rmSync(targetWebDir, { recursive: true, force: true });

let copiedFiles = 0;
let copiedBytes = 0;

function copyFiltered(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const relFromBuild = path.relative(buildDir, srcPath).replace(/\\/g, '/');

    // 不将 Android APK 安装包与 sourcemap 打入 Windows 客户端，保持安装包精简
    if (relFromBuild === 'downloads' || relFromBuild.startsWith('downloads/')) {
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.map')) {
      continue;
    }

    if (entry.isDirectory()) {
      copyFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      copiedFiles += 1;
      copiedBytes += fs.statSync(destPath).size;
    }
  }
}

copyFiltered(buildDir, targetWebDir);

console.log(
  `[desktop] Synced ${copiedFiles} files (${(copiedBytes / (1024 * 1024)).toFixed(2)} MB) -> desktop/web/`
);

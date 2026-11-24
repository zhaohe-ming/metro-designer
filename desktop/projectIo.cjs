const fs = require('node:fs');
const path = require('node:path');

const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const MAX_RECENT_FILES = 8;

function sanitizeFilename(raw, fallback = 'metro-project') {
  const cleaned = String(raw || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const base = cleaned || fallback;
  return base.length > 96 ? base.slice(0, 96).trim() : base;
}

function isSupportedProjectPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  return /\.(metro|json)$/i.test(filePath.trim());
}

/**
 * 从进程启动参数（双击 .metro 文件或命令行拖入）中提取首个合法本地工程路径。
 */
function extractProjectArg(argv, cwd = process.cwd(), startIndex = 1) {
  if (!Array.isArray(argv)) return null;
  for (let i = startIndex; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg || arg.startsWith('-')) continue;
    if (!isSupportedProjectPath(arg)) continue;
    const resolved = path.resolve(cwd, arg);
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* ignore missing candidate */
    }
  }
  return null;
}

function resolveExportFilter(suggestedName, mimeType) {
  const lowerName = String(suggestedName || '').toLowerCase();
  const lowerMime = String(mimeType || '').toLowerCase();
  if (lowerMime.includes('video/mp4') || lowerName.endsWith('.mp4')) {
    return { ext: '.mp4', filters: [{ name: 'MP4 视频 (*.mp4)', extensions: ['mp4'] }] };
  }
  if (lowerMime.includes('video/webm') || lowerName.endsWith('.webm')) {
    return { ext: '.webm', filters: [{ name: 'WebM 视频 (*.webm)', extensions: ['webm'] }] };
  }
  if (lowerMime.includes('image/png') || lowerName.endsWith('.png')) {
    return { ext: '.png', filters: [{ name: 'PNG 图片 (*.png)', extensions: ['png'] }] };
  }
  if (lowerMime.includes('image/svg') || lowerName.endsWith('.svg')) {
    return { ext: '.svg', filters: [{ name: 'SVG 矢量图 (*.svg)', extensions: ['svg'] }] };
  }
  if (lowerMime.includes('image/jpeg') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return { ext: '.jpg', filters: [{ name: 'JPEG 图片 (*.jpg)', extensions: ['jpg', 'jpeg'] }] };
  }
  return { ext: '.json', filters: [{ name: 'JSON 文件 (*.json)', extensions: ['json'] }] };
}

async function writeFileAtomic(targetPath, data, encoding) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(tmpPath, data, encoding ? { encoding } : undefined);
    await fs.promises.rename(tmpPath, targetPath);
  } catch {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    await fs.promises.writeFile(targetPath, data, encoding ? { encoding } : undefined);
  }
}

function createProjectController({ app, dialog, getWindow, onRecentChanged }) {
  const authorizedPaths = new Set();
  let lastProjectDir = '';
  let lastExportDir = '';

  const recentStorePath = () => path.join(app.getPath('userData'), 'recent-projects.json');

  function readRecentFiles() {
    try {
      const raw = fs.readFileSync(recentStorePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((p) => typeof p === 'string' && isSupportedProjectPath(p))
        .map((p) => path.resolve(p))
        .filter((p, idx, arr) => arr.indexOf(p) === idx && fs.existsSync(p))
        .slice(0, MAX_RECENT_FILES);
    } catch {
      return [];
    }
  }

  function writeRecentFiles(list) {
    try {
      const dir = path.dirname(recentStorePath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(recentStorePath(), JSON.stringify(list.slice(0, MAX_RECENT_FILES), null, 2), 'utf8');
    } catch {
      /* ignore storage errors */
    }
  }

  function recordAuthorizedProject(filePath) {
    const resolved = path.resolve(filePath);
    authorizedPaths.add(resolved);
    lastProjectDir = path.dirname(resolved);
    try { app.addRecentDocument?.(resolved); } catch { /* ignore */ }
    const next = [resolved, ...readRecentFiles().filter((item) => item !== resolved)].slice(0, MAX_RECENT_FILES);
    writeRecentFiles(next);
    onRecentChanged?.(next);
  }

  function clearRecentFiles() {
    writeRecentFiles([]);
    try { app.clearRecentDocuments?.(); } catch { /* ignore */ }
    onRecentChanged?.([]);
  }

  async function readProjectFromPath(filePath) {
    const resolved = path.resolve(filePath);
    if (!isSupportedProjectPath(resolved)) {
      throw new Error('仅支持打开 .metro 或 .json 工程文件');
    }
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) {
      throw new Error('所选路径不是有效文件');
    }
    if (stat.size > MAX_PROJECT_BYTES) {
      throw new Error('工程文件超过 50 MB 上限');
    }
    const content = await fs.promises.readFile(resolved, 'utf8');
    recordAuthorizedProject(resolved);
    return {
      filePath: resolved,
      name: path.basename(resolved),
      content
    };
  }

  async function openProjectDialog() {
    const win = getWindow();
    const defaultPath = lastProjectDir || app.getPath('documents');
    const result = await dialog.showOpenDialog(win || undefined, {
      title: '打开本地地铁线网工程',
      defaultPath,
      properties: ['openFile'],
      filters: [
        { name: 'Metro Designer 工程 (*.metro, *.json)', extensions: ['metro', 'json'] },
        { name: '所有文件 (*.*)', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true };
    }
    const loaded = await readProjectFromPath(result.filePaths[0]);
    return { canceled: false, ...loaded };
  }

  async function saveProjectFile(payload = {}) {
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!content || Buffer.byteLength(content, 'utf8') > MAX_PROJECT_BYTES) {
      throw new Error('工程内容为空或体积超出限制');
    }

    const candidatePath =
      !payload.saveAs && typeof payload.filePath === 'string' && payload.filePath.trim()
        ? path.resolve(payload.filePath)
        : null;

    let targetPath = candidatePath && authorizedPaths.has(candidatePath) ? candidatePath : null;

    if (!targetPath) {
      const win = getWindow();
      const baseName = sanitizeFilename(
        String(payload.suggestedName || '').replace(/\.(metro|json)$/i, ''),
        '未命名线路图'
      );
      const baseDir = lastProjectDir || app.getPath('documents');
      const saveRes = await dialog.showSaveDialog(win || undefined, {
        title: payload.saveAs ? '另存为本地工程' : '保存本地工程',
        defaultPath: path.join(baseDir, `${baseName}.metro`),
        filters: [
          { name: 'Metro Designer 工程 (*.metro)', extensions: ['metro'] },
          { name: 'JSON 工程备份 (*.json)', extensions: ['json'] }
        ]
      });
      if (saveRes.canceled || !saveRes.filePath) {
        return { canceled: true };
      }
      targetPath = path.resolve(saveRes.filePath);
      if (!isSupportedProjectPath(targetPath)) {
        targetPath = `${targetPath}.metro`;
      }
    }

    await writeFileAtomic(targetPath, content, 'utf8');
    recordAuthorizedProject(targetPath);
    return {
      canceled: false,
      filePath: targetPath,
      name: path.basename(targetPath)
    };
  }

  async function saveExportFile(payload = {}) {
    const rawBytes = payload.bytes;
    if (!rawBytes || typeof rawBytes.byteLength !== 'number' || rawBytes.byteLength < 1) {
      throw new Error('导出文件内容为空');
    }
    if (rawBytes.byteLength > MAX_EXPORT_BYTES) {
      throw new Error('导出文件超过 512 MB 上限');
    }

    const { ext, filters } = resolveExportFilter(payload.suggestedName, payload.mimeType);
    let safeName = sanitizeFilename(payload.suggestedName, `metro-export${ext}`);
    if (!safeName.toLowerCase().endsWith(ext)) {
      safeName += ext;
    }

    const win = getWindow();
    const baseDir = lastExportDir || app.getPath('downloads');
    const saveRes = await dialog.showSaveDialog(win || undefined, {
      title: '保存导出文件',
      defaultPath: path.join(baseDir, safeName),
      filters
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true };
    }

    const targetPath = path.resolve(saveRes.filePath);
    lastExportDir = path.dirname(targetPath);
    if (win && !win.isDestroyed()) win.setProgressBar(2);
    try {
      const buffer = Buffer.from(rawBytes.buffer || rawBytes, rawBytes.byteOffset || 0, rawBytes.byteLength);
      await fs.promises.writeFile(targetPath, buffer);
    } finally {
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
    }
    return { canceled: false, filePath: targetPath };
  }

  // 启动时将历史最近文件重新注册到授权集合，确保菜单「最近打开」可直接点击打开并继续 Ctrl+S 保存
  const initialRecent = readRecentFiles();
  initialRecent.forEach((p) => authorizedPaths.add(p));

  return {
    getRecentFiles: readRecentFiles,
    clearRecentFiles,
    readProjectFromPath,
    openProjectDialog,
    saveProjectFile,
    saveExportFile
  };
}

module.exports = {
  sanitizeFilename,
  isSupportedProjectPath,
  extractProjectArg,
  createProjectController
};

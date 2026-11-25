const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { attachUpdates } = require('./updates.cjs');
const { SITE_URL, START_URL, API_ORIGIN, isSite, isExternalLink, isExport } = require('./policy.cjs');
const { hasBundledWeb, attachLocalFirstProtocol } = require('./localProtocol.cjs');
const { extractProjectArg, createProjectController } = require('./projectIo.cjs');

let mainWindow = null;
let protocolAttached = false;
let projectController = null;
let pendingLaunchPath = extractProjectArg(
  process.argv,
  process.cwd(),
  app.isPackaged ? 1 : 2
);

const webRoot = path.join(__dirname, 'web');
const offlineFile = path.join(__dirname, 'offline.html');
const offlineURL = pathToFileURL(offlineFile).href;

app.setName('Metro Designer');
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    const incomingPath = extractProjectArg(commandLine, workingDirectory || process.cwd(), 1);
    if (incomingPath && projectController) {
      projectController
        .readProjectFromPath(incomingPath)
        .then((loaded) => {
          sendMenuCommand({ type: 'open-project-data', ...loaded });
        })
        .catch((err) => {
          dialog.showErrorBox('打开工程文件失败', err?.message || '无法读取所选的本地工程文件。');
        });
    }
  });

  app.whenReady().then(() => {
    setupIpcHandlers();
    createWindow();
  });
}

function sendMenuCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('metro:menu-command', command);
}

async function openExternal(url) {
  if (!isExternalLink(url)) return;
  try {
    await shell.openExternal(url);
  } catch {
    dialog.showErrorBox('打开链接失败', '请稍后在系统浏览器中打开此链接。');
  }
}

function loadWorkbench() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setProgressBar(-1);
  mainWindow.loadURL(START_URL).catch(() => {});
}

function setupIpcHandlers() {
  projectController = createProjectController({
    app,
    dialog,
    getWindow: () => mainWindow,
    onRecentChanged: () => rebuildApplicationMenu()
  });

  const assertTrustedSender = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('Untrusted IPC sender');
    }
  };

  ipcMain.handle('metro:open-project-dialog', async (event) => {
    assertTrustedSender(event);
    return projectController.openProjectDialog();
  });

  ipcMain.handle('metro:save-project-file', async (event, payload) => {
    assertTrustedSender(event);
    return projectController.saveProjectFile(payload);
  });

  ipcMain.handle('metro:save-export-file', async (event, payload) => {
    assertTrustedSender(event);
    return projectController.saveExportFile(payload);
  });

  ipcMain.handle('metro:consume-launch-project', async (event) => {
    assertTrustedSender(event);
    if (!pendingLaunchPath) return null;
    const target = pendingLaunchPath;
    pendingLaunchPath = null;
    try {
      return await projectController.readProjectFromPath(target);
    } catch (err) {
      dialog.showErrorBox('打开工程文件失败', err?.message || '无法读取启动工程文件。');
      return null;
    }
  });

  ipcMain.on('metro:window-state', (event, state) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    const rawTitle = typeof state?.title === 'string' && state.title.trim() ? state.title.trim() : '未命名方案';
    const dirtyMark = state?.dirty ? ' *' : '';
    const fileHint =
      typeof state?.filePath === 'string' && state.filePath.trim()
        ? ` (${path.basename(state.filePath)})`
        : '';
    mainWindow.setTitle(`${rawTitle}${dirtyMark}${fileHint} — Metro Designer`);
  });
}

let updatesController = null;

function rebuildApplicationMenu() {
  const recentFiles = projectController ? projectController.getRecentFiles() : [];
  const recentSubmenu = recentFiles.length
    ? [
        ...recentFiles.map((filePath) => ({
          label: `${path.basename(filePath)}  (${path.dirname(filePath)})`,
          click: () => {
            projectController
              .readProjectFromPath(filePath)
              .then((loaded) => sendMenuCommand({ type: 'open-project-data', ...loaded }))
              .catch((err) => {
                dialog.showErrorBox('打开最近工程失败', err?.message || '文件可能已被移动或删除。');
                rebuildApplicationMenu();
              });
          }
        })),
        { type: 'separator' },
        {
          label: '清空最近打开记录',
          click: () => projectController?.clearRecentFiles()
        }
      ]
    : [{ label: '暂无最近打开的本机工程', enabled: false }];

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '新建空白方案', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand({ type: 'new' }) },
          { label: '打开本地工程…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand({ type: 'open' }) },
          { label: '最近打开的工程', submenu: recentSubmenu },
          { type: 'separator' },
          { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand({ type: 'save' }) },
          {
            label: '另存为本地工程…',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => sendMenuCommand({ type: 'save-as' })
          },
          { type: 'separator' },
          { label: '导出 PNG 高清图片…', click: () => sendMenuCommand({ type: 'export-png' }) },
          { label: '导出动态演进视频 (MP4)…', click: () => sendMenuCommand({ type: 'export-video' }) },
          { type: 'separator' },
          { label: '在系统浏览器打开网页版', click: () => openExternal(SITE_URL) },
          { type: 'separator' },
          { role: 'quit', label: '退出' }
        ]
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' }
        ]
      },
      {
        label: '视图',
        submenu: [
          { label: '重新加载工作台', accelerator: 'CmdOrCtrl+R', click: loadWorkbench },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大界面' },
          { role: 'zoomOut', label: '缩小界面' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '切换全屏' }
        ]
      },
      {
        label: '帮助',
        submenu: [
          { label: '检查客户端更新…', click: () => { void updatesController?.check(true); } },
          { label: '前往客户端下载页', click: () => openExternal('https://www.metro-designer.com/downloads.html') },
          {
            label: '关于 Metro Designer',
            click: () => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Metro Designer',
                message: `Metro Designer v${app.getVersion()}`,
                detail:
                  '地铁线路图设计器 · Windows 本地原生客户端\n' +
                  '支持离线绘图、本地 .metro 工程读写及 PNG / SVG / MP4 导出；联网后同步云端地图、开源地理底图与 AI 助手。'
              });
            }
          }
        ]
      }
    ])
  );
}

function createWindow() {
  app.setAppUserModelId('com.metro-designer.desktop');

  const ses = session.fromPartition('persist:metro-designer');
  if (!protocolAttached) {
    protocolAttached = true;
    attachLocalFirstProtocol({
      session: ses,
      webRoot,
      apiOrigin: API_ORIGIN
    });
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'Metro Designer',
    backgroundColor: '#e9eef5',
    show: false,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--metro-desktop-version=${app.getVersion()}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'persist:metro-designer',
      // Keep video export active while the native Save dialog or other window is focused.
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  });

  const win = mainWindow;
  const wc = win.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} MetroDesignerDesktop/${app.getVersion()}`);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
  });
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename());
    item.setSaveDialogOptions({
      title: '保存导出文件',
      defaultPath: path.join(app.getPath('downloads'), filename)
    });
    item.on('updated', () => {
      const total = item.getTotalBytes();
      win.setProgressBar(total > 0 ? item.getReceivedBytes() / total : 2);
    });
    item.once('done', (_event, state) => {
      if (win.isDestroyed()) return;
      win.setProgressBar(-1);
      if (state === 'interrupted') {
        dialog.showErrorBox('保存中断', '文件写入未完成，请重试导出。');
      }
    });
  });

  // 未保存离开保护：前端 beforeunload 拦截时展示原生中文确认框
  wc.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['关闭并放弃未保存修改', '返回继续编辑'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '尚未保存修改',
      message: '当前画布有尚未保存的修改',
      detail: '直接关闭将丢失未保存的内容，建议先按 Ctrl+S 保存到本地或云端。'
    });
    if (choice === 0) {
      event.preventDefault();
    }
  });

  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('will-navigate', (event, url) => {
    if (isSite(url)) return;
    event.preventDefault();
    if (isExport(url)) wc.downloadURL(url);
    else if (url === 'metro-retry://reload') loadWorkbench();
    else void openExternal(url);
  });
  wc.on('will-redirect', (event, url) => {
    if (!isSite(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isSite(url) && new URL(url).pathname === '/downloads.html') void openExternal(url);
    else if (isSite(url)) wc.loadURL(url).catch(() => {});
    else if (isExport(url)) wc.downloadURL(url);
    else void openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isSite(url) && !hasBundledWeb(webRoot)) {
      wc.loadFile(offlineFile).catch(() => {});
    }
  });
  wc.on('render-process-gone', () => {
    if (hasBundledWeb(webRoot)) loadWorkbench();
    else wc.loadFile(offlineFile).catch(() => {});
  });
  wc.on('did-finish-load', () => {
    if (wc.getURL() === offlineURL) win.show();
  });

  // 仅保留菜单「帮助 → 检查客户端更新…」手动触发，启动时不自动弹窗打扰用户
  updatesController = attachUpdates({
    updater: autoUpdater,
    dialog,
    getWindow: () => mainWindow,
    isPackaged: app.isPackaged,
    getVersion: () => app.getVersion()
  });

  rebuildApplicationMenu();
  loadWorkbench();
}

app.on('window-all-closed', () => app.quit());

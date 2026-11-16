const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SITE_URL, isSite, isExternalLink, isExport } = require('./policy.cjs');

let mainWindow;
const offlineFile = path.join(__dirname, 'offline.html');
const offlineURL = pathToFileURL(offlineFile).href;

app.setName('Metro Designer');
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow);
}

async function openExternal(url) {
  if (!isExternalLink(url)) return;
  try { await shell.openExternal(url); }
  catch { dialog.showErrorBox('打开链接失败', '请稍后在浏览器中打开此链接。'); }
}

function loadSite() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setProgressBar(-1);
  mainWindow.loadURL(SITE_URL).catch(() => {});
}

function createWindow() {
  app.setAppUserModelId('com.metro-designer.desktop');
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 640,
    title: 'Metro Designer', backgroundColor: '#0b1930', show: false,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      partition: 'persist:metro-designer',
      // Keep video export active while the native Save dialog is open.
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  });
  const win = mainWindow;
  const wc = win.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} MetroDesignerDesktop/${app.getVersion()}`);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { mainWindow = null; });
  win.on('page-title-updated', event => { event.preventDefault(); });

  const ses = wc.session;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename());
    item.setSaveDialogOptions({
      title: '保存导出文件', defaultPath: path.join(app.getPath('downloads'), filename)
    });
    item.on('updated', () => {
      const total = item.getTotalBytes();
      win.setProgressBar(total > 0 ? item.getReceivedBytes() / total : 2);
    });
    item.once('done', (_event, state) => {
      if (win.isDestroyed()) return;
      win.setProgressBar(-1);
      if (state === 'interrupted') dialog.showErrorBox('下载中断', '请检查网络连接后重新导出。');
    });
  });

  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('will-navigate', (event, url) => {
    if (isSite(url)) return;
    event.preventDefault();
    if (isExport(url)) wc.downloadURL(url);
    else if (url === 'metro-retry://reload') loadSite();
    else openExternal(url);
  });
  wc.on('will-redirect', (event, url) => {
    if (!isSite(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isSite(url)) wc.loadURL(url).catch(() => {});
    else if (isExport(url)) wc.downloadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isSite(url)) wc.loadFile(offlineFile).catch(() => {});
  });
  wc.on('render-process-gone', () => {
    wc.loadFile(offlineFile).catch(() => {});
  });
  wc.on('did-finish-load', () => {
    if (wc.getURL() === offlineURL) win.show();
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '在浏览器打开', click: () => openExternal(SITE_URL) },
      { type: 'separator' }, { role: 'quit', label: '退出' }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
      { type: 'separator' }, { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' }
    ] },
    { label: '视图', submenu: [
      { label: '重新连接 / 刷新', accelerator: 'CmdOrCtrl+R', click: loadSite },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }
    ] },
    { label: '帮助', submenu: [
      { label: '下载新版', click: () => openExternal('https://www.metro-designer.com/downloads.html') },
      { label: '关于 Metro Designer', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'Metro Designer', message: `Metro Designer ${app.getVersion()}`,
        detail: '地铁线路图设计器 · Windows 客户端\n联网使用，与网页共用账号及云端地图。'
      }) }
    ] }
  ]));
  loadSite();
}

app.on('window-all-closed', () => app.quit());

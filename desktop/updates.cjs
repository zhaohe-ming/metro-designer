function attachUpdates({ updater, dialog, getWindow, isPackaged, getVersion }) {
  let checking = false;
  let downloading = false;
  let downloaded = false;
  let manual = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  const progress = value => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.setProgressBar(value);
  };
  const show = options => {
    const win = getWindow();
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : Promise.resolve({ response: 1 });
  };
  const fail = () => {
    checking = false;
    downloading = false;
    progress(-1);
    if (manual) {
      manual = false;
      void show({ type: 'info', title: '检查更新', message: '暂时未连接到更新服务',
        detail: '请稍后再试，或在“帮助 → 下载新版”中取得安装包。' });
    }
  };
  async function promptInstall() {
    const result = await show({
      type: 'info', title: '更新已下载', message: '新版客户端已准备好',
      detail: '请先保存当前作品。选择“已保存，安装新版”后，客户端将退出并打开安装程序。',
      buttons: ['已保存，安装新版', '稍后'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (result.response === 0) updater.quitAndInstall(false, true);
  }
  updater.on('error', fail);
  updater.on('update-not-available', () => {
    checking = false;
    if (manual) {
      manual = false;
      void show({ type: 'info', title: '检查更新', message: `当前已是最新版本 v${getVersion()}` });
    }
  });
  updater.on('update-available', info => {
    checking = false;
    void (async () => {
      const result = await show({
        type: 'info', title: '发现新版', message: `Metro Designer v${info.version} 已发布`,
        detail: '现在下载，继续保留当前作品。下载完成后，由你选择安装时间。',
        buttons: ['下载更新', '稍后'], defaultId: 1, cancelId: 1, noLink: true
      });
      manual = false;
      if (result.response !== 0 || downloading) return;
      downloading = true;
      progress(2);
      try { await updater.downloadUpdate(); }
      catch { manual = true; fail(); }
    })().catch(fail);
  });
  updater.on('download-progress', info => progress(Math.max(0, Math.min(1, info.percent / 100))));
  updater.on('update-downloaded', () => {
    downloading = false;
    downloaded = true;
    progress(-1);
    void promptInstall().catch(fail);
  });
  async function check(manualCheck = false) {
    if (!isPackaged) {
      if (manualCheck) await show({ type: 'info', title: '检查更新', message: '正式安装版提供在线更新。' });
      return;
    }
    if (downloaded) return promptInstall();
    if (checking || downloading) return;
    checking = true;
    manual = manualCheck;
    try { await updater.checkForUpdates(); } catch { fail(); }
  }
  return { check };
}
module.exports = { attachUpdates };

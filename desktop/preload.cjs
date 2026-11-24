const { contextBridge, ipcRenderer } = require('electron');

const versionArg = (process.argv || []).find((arg) =>
  typeof arg === 'string' && arg.startsWith('--metro-desktop-version=')
);
const version = versionArg ? versionArg.slice('--metro-desktop-version='.length) : '1.2.0';

contextBridge.exposeInMainWorld('metroDesktop', {
  version,
  openProjectDialog: () => ipcRenderer.invoke('metro:open-project-dialog'),
  saveProjectFile: (payload) => ipcRenderer.invoke('metro:save-project-file', payload),
  saveExportFile: (payload) => ipcRenderer.invoke('metro:save-export-file', payload),
  consumeLaunchProject: () => ipcRenderer.invoke('metro:consume-launch-project'),
  onMenuCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, command) => {
      callback(command);
    };
    ipcRenderer.on('metro:menu-command', listener);
    return () => {
      ipcRenderer.removeListener('metro:menu-command', listener);
    };
  },
  setDocumentWindowState: (state) => {
    ipcRenderer.send('metro:window-state', state);
  }
});

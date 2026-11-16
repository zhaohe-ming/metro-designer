import React, { useEffect, useState } from 'react';
import { CloseOutlined, DownloadOutlined } from '@ant-design/icons';
import { desktopVersion, isNewerDesktopVersion } from '../lib/desktopClient';

// v1.0 uses the hosted UI: this notice bridges its first upgrade to the native updater.
const DesktopUpdateNotice: React.FC = () => {
  const [version, setVersion] = useState('');
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const currentVersion = desktopVersion;
    if (!currentVersion || !isNewerDesktopVersion('1.1.0', currentVersion)) return;
    const controller = new AbortController();
    fetch('/desktop-release.json', { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(release => {
        if (typeof release?.version === 'string' && isNewerDesktopVersion(release.version, currentVersion)) setVersion(release.version);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!version || dismissed) return null;
  return (
    <aside className="desktop-update-notice" role="status" aria-label="客户端升级提醒">
      <div><strong>Windows 客户端 v{version} 已发布</strong><p>新版首屏与更新提醒已就绪。先保存作品，再覆盖安装。</p></div>
      <a href={`https://github.com/zhaohe-ming/metro-designer/releases/download/v${version}/Metro-Designer-Setup-${version}-x64.exe`}
        target="_blank" rel="noopener noreferrer"><DownloadOutlined /> 下载更新</a>
      <button type="button" aria-label="稍后更新" onClick={() => setDismissed(true)}><CloseOutlined /></button>
    </aside>
  );
};
export default DesktopUpdateNotice;

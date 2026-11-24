# Metro Designer Windows 客户端

Windows 10 / 11 x64 本地原生客户端（Electron 45.3.3，Local-First 架构）。

- **离线秒开与纯本地绘图**：前端静态包直接内置于 `app.asar/web/`，通过会话级本地协议拦截秒开工作台，无网络环境下可完整进行多线路绘制、换乘编排、纯本机 `.metro` 工程管理及高清 PNG / MP4 动态演进视频离线导出。
- **原生本地工程体系（`.metro`）**：支持 `Ctrl+O` 打开、`Ctrl+S` 原地静默写盘、`Ctrl+Shift+S` 另存为、最近打开文件记录，以及 Windows 资源管理器双击 `.metro` 文件直接启动打开。
- **在线能力自动叠加**：联网状态下与网页版共用账号、云端地图、高德真实地理底图、AI 线网助手及作品广场。

## 开发与打包

在仓库根目录已安装依赖的前提下（Node.js 22.12+）：

```powershell
cd desktop
npm ci
npm test
npm start
npm run dist
```

- `npm run prepare:web`：构建根目录 React 前端（默认指向生产 API `https://metro-designer-api.onrender.com`，自动剔除 sourcemap 与 Android APK），同步至忽略提交的 `desktop/web/`。
- `npm run dist`：先执行 `prepare:web`，再生成安装包 `../outputs/windows-app-v1.2.0/Metro-Designer-Setup-1.2.0-x64.exe`。

## 安全与沙箱边界

- 渲染进程保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- `preload.cjs` 仅暴露受控 `window.metroDesktop` 接口；主进程维护用户显式授权的工程路径集合（`authorizedPaths`），未经系统文件选择器、启动文件参数或历史最近列表授权的任意磁盘路径均拒绝静默写入。
- 外链统一交由系统默认浏览器打开，严禁任意协议执行与路径穿越（见 `policy.test.cjs`、`localProtocol.test.cjs`、`projectIo.test.cjs`）。

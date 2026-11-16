# Metro Designer Windows 客户端

Windows 10 / 11 x64，Electron 45.3.3；在线打开 `https://www.metro-designer.com/`。
账号、云存档、绘图和导出由现有网站提供，桌面会话独立于浏览器。需要联网。

## 开发与打包

使用 Node.js 22.12 或更高版本：

```powershell
cd desktop
npm ci
npm test
npm start
npm run dist
```

输出：`../outputs/windows-app-v1.1.0/Metro-Designer-Setup-1.1.0-x64.exe`。
安装范围为当前用户，可选择目录，创建桌面及开始菜单快捷方式。卸载保留登录和站点数据。
当前安装包未使用发布者证书签名，Windows 可能显示来源提示；正式大范围分发可配置组织代码签名证书。

## 更新与分发

- 网站内容发布后，客户端刷新即可获取；Electron 运行环境更新需要发布新安装包。
- v1.1.0 启动后自动检查 GitHub 正式版，帮助菜单可手动检查。
- 下载和安装分别征得用户确认；关闭客户端不会自动安装。安装前提示保存当前作品。
- v1.0.0 重开或刷新后，由网站界面提示下载 v1.1.0，覆盖安装后接入原生更新。
- 发布时同步上传安装包、`.blockmap` 和 `latest.yml`；保留同一 appId 和安装身份以执行覆盖升级。
- 安装包当前保持未签名状态；更新通过固定 GitHub 仓库 HTTPS 与生成的 SHA-512 元数据校验，尚未建立发布者证书身份。
- 安装包放在本仓库 GitHub Releases，网站 `/downloads.html` 链接到指定版本附件。
- 发布新版本时同步修改本目录 `package.json` 版本和下载页 URL、版本号。
- 安装包、缓存、用户会话及 `.env` 均不提交 Git。

## 窗口边界

远程页面保持沙箱、上下文隔离，关闭 Node 集成，不设置 preload 或 IPC 接口。
主窗口仅允许两种官方 HTTPS 域名；外链交给系统浏览器，导出交给原生保存对话框。
权限默认拒绝，网络或渲染故障显示本地重试页。保留系统证书校验与网页安全策略。

`policy.test.cjs` 检查域名仿冒、危险协议及跨站 blob 等边界。
应用图标沿用网站 `public/favicon.svg` 的品牌图形。

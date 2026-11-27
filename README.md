# TransitCanvas · 轨道工坊

在浏览器里绘制城市轨道线网、造景轻城市、推演运行图，并生成"按开通日期演进"的动态演示视频。

**在线访问：** https://www.transitcanvas.com

**Windows 客户端：** [下载页面](https://www.transitcanvas.com/downloads.html) · Windows 10 / 11 x64，离线可用，联网与网页版共用账号及云端地图。
桌面源码和打包说明见 [`desktop/README.md`](desktop/README.md)。

<!-- TODO: 放一张工作台截图 + 一段视频导出的 GIF 到 docs/，引用如下：
![Workbench](docs/screenshot.png)
![Demo](docs/video-demo.gif)
-->

## 主要功能

- **免登录预览**：[直接试用](https://www.transitcanvas.com/?preview=1)，可编辑示例线网、本机保存草稿，登录后继续云端保存。说明见 [免登录预览](docs/guest-preview.md)。

- **双模式画布**：纯示意图（自由排版）/ 高德底图（真实地理坐标），随时切换
- **完整的线网编辑**：站点拖拽、连线、区间途经点、自动吸附、Ctrl+Z 撤销重做
- **四档视觉风格**：现代 / 经典 / 粗体 / 管道 —— 换乘站、普通站、线路标签结构都跟随预设差异化
- **三种换乘站符号**：弧形互锁箭头（refresh icon 风）/ 线路色弧段 / 同心环
- **动画视频导出**：最长边 1920 的 WebM（16:9 时为 1920×1080），自定义片头，按开通日期沿真实折点和圆角逐段铺开，镜头跟随式平移，三秒完整线网片尾。支持进度、取消与后台暂停，站名及换乘关系随开通进度更新。
- **多用户云存档**：邮箱注册 + 一次性 token 验证 + 跨设备自动登录（手机点验证邮件、电脑端自动进系统）。地图同时保存标签密度和视频配置草稿；保存期间继续编辑仍提示未保存，切换地图不会被旧请求覆盖。
- **响应式布局**：桌面 252 px 侧栏，移动端抽屉式 + 触屏画布手势
- **i18n**：中 / 英双语界面

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 + TypeScript + Konva（Canvas 渲染）+ AntD 5 |
| 后端 | Node.js + Express + JWT + bcryptjs |
| 存储 | PostgreSQL（生产）/ JSON 文件（开发，自动回退） |
| 邮件 | Resend（可选；未配置时邮件正文落到后端控制台，方便 dev 走通流程） |
| 部署 | Vercel（前端 SPA）+ Render（后端 API） |

## 安全基线

- `helmet` + CORS 白名单 + JWT `purpose` 区分（业务令牌 vs 升级 / 验证令牌）
- bcrypt 密码哈希 + 输入长度收紧（防 bcrypt 72 字节静默截断攻击面）
- 四档速率限制：登录 / `/me` / 高德代理 / 全局兜底；以及高频小限制器供跨设备验证轮询
- 累计违规 24 h 内达 50 次自动封禁 IP 24 h（PostgreSQL 落表，重启不丢）
- 邮件验证 / 找回密码 token 仅存 SHA256 哈希，15 min 过期、单次使用

## 本地开发

```bash
git clone https://github.com/zhaohe-ming/metro-designer
cd metro-designer
npm install
npm run dev      # 同时启动前端 :3000 和后端 :4000
```

最小配置：什么环境变量都不填也能跑 —— 没有高德底图、邮件直接落到控制台。完整配置参考 [.env.example](./.env.example)。

## 架构概览

```
src/
  components/Canvas.tsx          主画布：工具切换 + 站点/线路渲染 + 拖拽
  components/AuthPanel.tsx       登录 / 注册 / 验证 / 找回密码状态机
  components/VideoExportModal    视频导出对话框
  lib/interchange.ts             换乘站几何（Canvas 和视频导出共用同一份）
  lib/videoModel.ts              视频路径、到站时序与地图投影
  lib/recordVideo.ts             录制、进度、取消与后台暂停
  lib/documentSession.ts         保存版本与加载请求顺序保护
  lib/exportVideo.ts             MediaRecorder + Canvas 2D 离屏渲染 + 跟随镜头
  stylePresets.ts                四档视觉风格定义
server/
  index.js                       Express 入口 + 路由 + 限流 + 自动封禁
  lib/email.js                   Resend 客户端 / console 兜底
  lib/mapSettings.js             设置与视频草稿归一化（与前端类型同步）
```

设计上有意识做的两件事：

1. **几何 / 渲染分离**：换乘站怎么画、视频里相机怎么动，都抽到 `lib/` 下纯函数模块。Canvas 和视频导出共用同一份几何代码，避免出现"画布上换乘点是 A 形状、视频里是 B 形状"。
2. **服务端最小信任**：所有用户输入都经过校验 + 长度收紧；所有令牌（JWT、邮件 token、升级令牌）都有明确的 purpose / type 字段，不能混用。

## Roadmap

- [x] 视频片尾：完整线网与已展示线路 / 车站数量
- [ ] 视频导出：段落之间定时全景拉远
- [ ] 视频导出 Phase 4：参考真实运营视频的 overlay 套装（顶左线路徽章 / 左侧大号年月日 / 底部已开通线路 chip strip）
- [ ] 真实城市数据导入（GTFS / OSM 站点经纬度）
- [ ] 协作编辑（基于 Yjs 的多人同时编辑）
- [ ] 单元 + e2e 测试基线

---

个人项目，仅供学习交流；如需商用 / 二次分发请先联系作者。


## 作品广场

`/gallery` 提供公开浏览、分类和搜索，`/works/:id` 为可缩放的作品详情。工作台头部及账户菜单提供入口；登录页面沿用现有设计。网站、Windows 在线客户端和 Android 在线客户端共用这些页面。

“我的地图”管理私人存档；发布时由服务端读取本人已保存的地图，创建独立待审快照，默认移除站点备注。允许复制的作品可以免登录复制到本机草稿，也可以登录保存为自己的地图；服务端签发并保存原作来源。更新公开内容需重新提交审核；审核期间原公开版本继续展示。撤回公开作品保留私人原稿。

### 审核配置

审核基准保存在服务器端 `server/config/gallery-admins.json`。2026年11月23日，经项目所有者明确批准，审核账号设为 `3855166698@qq.com`。后端环境变量 `GALLERY_ADMIN_EMAILS` 可覆盖这份配置，多名邮箱用英文逗号分隔；明确设置为空值时关闭全部审核权限。账号需要先完成邮箱验证。白名单账号在作品广场用户菜单中进入“作品审核”，可审核、退回、隐藏、恢复、精选作品和处理举报。前端字段与本地存储均无法授予审核权限。

六份架空示例会在首次访问时幂等初始化：云川 8 线97站、环湾 7 线91站、山海 9 线111站、澄湖 5 线56站、星港 6 线79站、林江 6 线69站。它们使用真实可编辑的线路与站点数据，公开署名为 TransitCanvas 示例；没有虚构互动数据。再次启动保留现有示例的公开与审核状态。

正式 PostgreSQL 部署新增 `gallery_works`、`gallery_reactions`、`gallery_reports`、`gallery_origins` 表；既有私人地图接口继续按账号隔离。带高德底图的作品封面使用已配置的 `AMAP_WEB_SERVICE_KEY`，在发布时生成快照；私人地图列表使用轻量矢量预览。密钥保留在后端环境变量中。

### 广场检查

- `node scripts/gallery.test.cjs`：使用临时数据库验证公开权限、审核、复制来源及互动流程。
- `node scripts/gallery-fixture.cjs`：启动隔离浏览器验收环境，前端 `http://127.0.0.1:4197`、后端4196端口，先运行本地构建。它仅供开发检查，使用测试账户和临时数据。
- `design-qa.md`：视觉目标、实际页面截图、修正历史和验证范围。截图保存在忽略提交的 `outputs/gallery/` 下。

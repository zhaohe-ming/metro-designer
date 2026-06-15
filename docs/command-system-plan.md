# 命令行系统 规划文档

> 状态：草案 v0.2（待评审）
> 形态：AutoCAD 式底部命令栏 · 引用模型：按名字 + 重名消歧 · 范围：v1 桌面优先
> 高德模式适配策略见对话记录，本文档从略。

## 1. 目标与产品形态

给 Metro Designer 加一条**常驻底部命令栏**，用键盘命令完成建网与视图/设置操作，
作为现有鼠标工具的并行高效通道（参照 AutoCAD 命令行）。

**v1 定位：键盘快速搭骨架**——建线/连站/批量建站/改色改名/视图/设置。
途经点、定点放站、距离感知这三件在 v1 只做到"能用"，**真正顺手靠 v2 的画布交互拾取**（点代替敲）。

配套：
- 命令历史（↑/↓）、自动补全（含颜色色块）、结果/报错行。
- **新手引导**：首次进工作台自动触发的分类演示弹窗（见 §7）。
- **比例尺 + 光标坐标 HUD**：右下角实时显示，帮用户感知坐标量程（见 §8）。
- 桌面优先；窄屏隐藏命令栏，移动端继续用触屏 UI。

## 2. 为什么可行：变更后端已现成（核心论点）

AI 助手已经把"结构化指令 → 安全落地 + 撤销"这条最难的链路打通：

```
AIOperation[]  ──►  applyAIOperations()  ──►  graphOps + pushHistory
（api.ts:59-76）     （App.tsx:~1157）          （含高德坐标 / 删站缝合 / 一次撤销单位）
```

命令行复用**同一套底层变更通道**（graphOps + state setter + 每命令一次 `pushHistory`）：
- 能对上现有 op 的（recolor/rename/delete/insert/extend/attach…）→ 走 `applyAIOperations`。
- 对不上的少数新命令（`create line` 空线、`connect` 端点链、`station` 孤立站、`waypoint`）→ 走几个**新增 handler**。

→ 最高风险的部分（撤销/坐标/缝合）全程复用；本特性主要是"加法"：新模块 + 新面板 + 几个小 handler，不动画布渲染与数据模型。

## 3. 架构与数据流

```
输入字符串
  │  parseCommand(input)               纯函数：词法/语法（带引号=名字、裸=关键字/数字/颜色）→ Tokenized | Error
  ▼
Tokenized
  │  resolveCommand(tokenized, ctx)    纯函数：ctx={lines,stations}；名字→id、重名消歧；产出 ops / action / error / guide
  ▼
ResolvedCommand
  │  executeCommand(resolved)          App 内（持有 state + handlers）
  ▼
  ├─ kind:'ops'    → applyAIOperations(ops)            （白嫖 undo）
  ├─ kind:'action' → 调 handler；可变更的自行 pushHistory()
  ├─ kind:'error'  → 命令栏报错行，不改图
  └─ kind:'guide'  → 打开新手引导 / 内联 help
```

`parseCommand` 与 `resolveCommand` 都是**纯函数**，可单测（接现有 Jest 基线）。执行器放 App。

```ts
type ResolvedCommand =
  | { kind: 'ops'; ops: AIOperation[]; summary: string }
  | { kind: 'action'; run: () => void; undoable: boolean; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'guide'; topic?: string };
```

## 4. v1 命令词汇（定稿）

**记法约定（`<>` 只是本文档占位，真实命令不打）**：
- **名字一律加引号** `"…"`；**关键字 / 数字 / 颜色裸写**。→ 语法零歧义（连站名叫 `connect` 也不会撞）。
- 引用：`"名"` ｜ `"名"@id前缀` ｜ `@完整id`（重名时用后两者精确指定）。
- 颜色：命名色 `blue yellow red green purple cyan pink orange`（对齐 `LINE_COLORS`）｜ `#rrggbb` ｜ 序号 `1`–`8`。

### 4.1 线路
```
create line "2号线" blue                          新建空线路（自动设为当前线路）
line "2号线" connect "西直门" "车公庄" "阜成门" …     按顺序连已有站：1→2→3…
connect "西直门" "车公庄" …                         同上，作用于“当前线路”（省略线名）
extend "2号线" end "积水潭" "鼓楼大街" …             端点延伸新站（名字是新的）
attach "2号线" start "某已有站"                      已有站接到端点
recolor "2号线" red                               改线色
rename line "2号线" "环线"                          改线名
delete line "2号线"                               删线（站保留）
select "2号线"                                    设为当前线路
```
`connect` 规则：站点须已存在；空线路 → 初始化整条路径；非空线路 → 第一个站必须是当前某端点，从那里往后接（线路保持简单路径）。

### 4.2 站点
```
station "西单" at 800,450                          绝对坐标建独立站
station "西单" right 300 down 100 from "复兴门"      相对锚站建独立站（方向 left/right/up/down，可叠加）
insert "2号线" between "西直门" "车公庄" "新站A" …     两相邻站间插新站（等距内插）
rename station "积水潭" "新街口"                      改站名
delete station "积水潭"                            删站（自动缝合前后邻站）
```
方向定义（屏幕）：`up = −y`、`down = +y`、`left = −x`、`right = +x`。

### 4.3 途经点（v1 坐标形保底；v2 画布拾取才是正解）
```
waypoint "2号线" between "西直门" "车公庄" at 820,300 [at 900,260 …]   按 A→B 顺序加拐点
waypoint clear "2号线" between "西直门" "车公庄"                        清空该区间拐点
```
> 拐点本质是视觉拐点，键盘敲坐标较反人类——引导里会明示"拐点更推荐鼠标"。

### 4.4 视图（→ 已有 handler，非撤销单位）
```
zoom 1.5 | zoom in | zoom out | fit | reset | center "西直门"
```

### 4.5 设置（→ setMapSettings，入撤销）
```
style classic|dot | theme light|dark | corner 12
```

### 4.6 编辑 / 文件 / 元
```
undo | redo | save | new
help            打开新手引导
help "extend"   内联显示某命令语法
help colors     展示调色板（命名色 + 色块）
```

合计约 26 条。

## 5. 引用解析与重名消歧

1. 引号内精确名匹配，唯一 → 用其 id。
2. 多个同名 → 报错并列候选：`线路「环线」有 2 条："环线"@a1b2c3 / "环线"@d4e5f6，请加 @id前缀 指定`。
3. 支持 `"名"@<id前缀>`（前缀唯一即可）与 `@<完整id>`。
4. 找不到 → 报错（区分"线不存在"/"站不存在"）。

## 6. 撤销集成

- `kind:'ops'`：`applyAIOperations` 内部已 `pushHistory`，天然一次撤销单位。
- 新 handler（create line / connect / station / waypoint）：执行前各 `pushHistory()` 一次。
- `kind:'action'` 且 `undoable`（style/theme/corner/rename/select-改动）：执行前 `pushHistory()`。
- 视图/缩放/save/help/纯 select：不入历史。

## 7. 新手引导（CommandGuide）

- 步进弹窗：命令分**几类**（建线 / 建站 / 视图 / 设置 / 编辑），每步一个演示 + "下一步" + 进度点。
- 首次进工作台**自动触发**（localStorage `metro_cmd_guide_seen`）；之后 `help`（无参）重新打开。
- **演示媒体（工作量分级）**：v1 先做**打字动画**（命令逐字敲进仿命令栏）+ 一张标注结果图，把框架（步进/分类/首launch/重开）做扎实；精致 GIF/Lottie 后续增量替换。

## 8. 坐标量程感知：比例尺 + 光标 HUD

- 右下角**比例尺**，随缩放实时更新（复用/扩展已有的 `.metro-canvas-hud`）：
  - 纯画布：标着单位数的标尺段（如"200 单位"），配合已有 24px 网格点，估出 `right 300` 大概多远。
  - 高德模式：真实距离（m/km）。
- 可选**光标坐标读数**（HUD 角落）：敲 `at x,y` 前能瞄当前位置。
- > v2 画布拾取后，"距离感知"问题基本消失（点代替敲）。

## 9. 文件清单

**新增**
- `src/lib/commandParser.ts` — `parseCommand`（纯，词法/语法）
- `src/lib/commandRegistry.ts` — 命令规范表 + `resolveCommand`（纯，名字→id、产出 ops/action）
- `src/lib/commandParser.test.ts` — 解析 + 消歧 + 各命令→期望 ops/action 的单测
- `src/components/CommandBar.tsx` — 命令栏 UI（输入/历史/补全/反馈）
- `src/components/CommandGuide.tsx` — 新手引导步进弹窗

**改动**
- `src/App.tsx` — 渲染 CommandBar/CommandGuide；`executeCommand`；新增 handler：`createEmptyLine` / `connectStationsOnLine` / `addStation` / `setSectionWaypoints`；提供 `{lines,stations}` 上下文；`/` 热键 + 全局 keydown 焦点判断；首launch 引导触发
- `src/components/Canvas.tsx` — 右下角比例尺 + 光标坐标 HUD（Canvas 持有 scale/cursor/amap）
- `src/styles.css` — 命令栏 / 引导 / 比例尺样式（套暖纸面 token）
- i18n：命令名英文稳定；引导/报错/help 文案 zh/en

## 10. 分期

- **v1（本次目标）**：命令栏 + parser/registry + §4 全部命令（按名字、含独立站绝对/相对、途经点坐标形）+ 命名色 + 引号规则 + 历史/补全 + 新手引导（框架+打字动画）+ 比例尺/HUD + 焦点处理 + 解析器单测。
- **v2**：AutoCAD 式**交互拾取**（命令提示 → 画布点选目标/落点），途经点与定点放站"点一下就好"；坐标实时输入；多步提示序列；解析不出时**一键转交 `aiEditStream`** 当自然语言兜底。
- **v3**：脚本/批处理、整张图导出为可重放命令脚本、宏录制。

## 11. 测试策略

纯函数为主：`parseCommand` / `resolveCommand` 全分支（引号/语法错误、缺参、重名消歧、颜色三记法、每命令→期望 op/action）。UI 维持项目现状不强制测。

## 12. 已决 / 开放问题

**已决**
- 独立站点（绝对 `at` + 相对 `from`）纳入 v1。
- 途经点 v1 走坐标形，画布拾取放 v2。
- 名字加引号、关键字/数字/颜色裸写。
- `connect` 支持省略线名作用于当前线路。

**开放**
- 命名色最终集合是否就这 8 个（对齐 LINE_COLORS）。
- 比例尺在高德模式取数来源（高德内置控件 vs 自算）。

## 13. v1 验收标准

- [ ] 命令栏常驻、`/` 聚焦、`Esc` 失焦、↑/↓ 历史
- [ ] §4 全部命令可执行；图/站命令可 Ctrl+Z 一步撤销
- [ ] 重名站/线触发清晰消歧报错，`@id前缀` 可精确指定
- [ ] 错误命令给出可读报错且不改图
- [ ] 命名色 + 自动补全色块可用；`help colors` 列表
- [ ] 首次自动弹新手引导，`help` 可重开；引导覆盖各类命令
- [ ] 右下角比例尺随缩放更新；光标坐标读数可用
- [ ] 命令栏聚焦时不误触发画布撤销
- [ ] 解析器单测全绿；`tsc` + build 通过
- [ ] 暖纸面视觉语言一致

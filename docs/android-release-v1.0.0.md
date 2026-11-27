# Android 1.0.0 发布记录

日期：2026-11-17。用户明确授权移动端改进上线，并要求制作 APK、在手机网站显示下载入口。

## 交付

- 官网下载页：/android.html
- 安装包：public/downloads/TransitCanvas-Android-1.0.0.apk
- 版本信息：public/android-release.json
- 校验文件：public/downloads/TransitCanvas-Android-1.0.0.sha256
- 本机构建输出及报告：outputs/android-app-v1.0.0
- 原生工程：android；文件保存协议：src/lib/androidClient.ts
- 手机未登录页在简介下展示下载按钮；Android 浏览器的账号菜单指向安卓下载页。应用内登录页隐藏重复下载入口。

APK 918,527 字节（十进制 0.9 MB），包名 com.metrodesigner.android，versionName 1.0.0 / versionCode 1，最低 API 26，target/compile API 35。以在线 WebView 方式加载正式网站，使用网站账号及云端地图，应用保留独立本机登录。

## 验证

- Gradle：lintRelease、testReleaseUnitTest、assembleRelease 全部完成。
- 原生 ClientPolicy 4 项测试通过：正式域名边界、外部协议、导出文件名/MIME、分块大小边界。
- 前端 17 项回归通过：原生导出协议 3 项，触屏手势 4 项，线路图编辑 10 项。
- 前端生产构建通过；生成的网页使用实际 APK 大小及校验值。
- Android Lint 0 错误、1 条经审查警告：SPA 必需的 JavaScript 支持；原生桥另有正式源与主框架限制。
- apksigner verify 通过，APK v2 签名、RSA 3072；ZIP 完整性通过，安装包未包含签名私钥或环境配置。
- 仅 INTERNET 权限；导入/导出使用系统文件选择器。拒绝明文主站、任意本地文件导航和 TLS 校验失败连接。
- APK SHA-256：5bb8d13832b01c949e98a09bd21dd44944fe1bfa865b3f512f5d2a211accf37a。
- 发布证书 SHA-256：7c3cc39b0a4bfe5b51f5705175558834dce121c3a48cee08cdb24fbac81282fd。
- 未进行实体手机或安卓模拟器运行验证。首版标为体验版；登录、系统文件窗口、键盘/手势及不同品牌 WebView 的实际体验待真机反馈。

## 维护

发布私钥及密码仅在 android/.private 内，受 ACL 与 Git 排除保护。后续升级使用同一把密钥，递增 versionCode。工具缓存、Gradle 缓存、SDK、本机路径与签名材料均未提交。

本机最新 JDK 的 AF_UNIX 回环连接失败，通过构建进程专用的 socket 临时目录配置使用 JDK 标准 TCP 回退路径；没有修改系统网络或证书验证。构建工具来源及归档散列经过核对，最终使用 JDK 17、Android CLI 19、Gradle 8.11.1、AGP 8.9.2。

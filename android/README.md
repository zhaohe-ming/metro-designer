# Metro Designer Android

原生 Android WebView 在线客户端，复用正式站点 https://www.metro-designer.com/。

- 包名：com.metrodesigner.android
- 首版：1.0.0 / versionCode 1
- Android 8.0（API 26）及以上；target/compile API 35。
- AGP 8.9.2、Gradle 8.11.1、JDK 17，AndroidX WebKit 1.14.0。
- 应用仅声明 INTERNET 权限。导入、导出采用系统文件选择器，无广泛存储读取权限。
- 正式域名内导航保留在应用；外部 HTTPS 和邮件链接交给系统。HTTP、file、intent 等跳转被拦截，TLS 失败按系统校验结果处理。
- 原生保存接口通过 WebViewCompat 的限定源消息通道，只接收正式域名的主框架消息。PNG/JPEG/WebM/MP4/JSON 以 64 KB 分块写入私有临时文件，完整校验后使用 ACTION_CREATE_DOCUMENT 保存；512 MB 上限。
- 网页在应用内检测 MetroDesignerAndroid/1.0.0，图片及视频导出使用原生保存协议；界面随网站更新，APK 升级从官网下载覆盖安装。

## 构建

在仓库根目录的 PowerShell 中执行 `./android/build.ps1`。

构建需要安装上述工具，设置 JAVA_HOME、Android SDK local.properties。此电脑的独立工具缓存位于 android/.cache，paths.json 记录本机路径。新环境可用已安装的 Gradle 和 SDK。

正式包需要本机 android/.private/release.jks 与 signing.properties。signing.properties 包含 storePassword、keyAlias、keyPassword；这些文件与全部工具缓存均已被 Git 排除。**请妥善离线备份发布密钥和密码；后续覆盖升级必须继续使用同一把密钥。** 源代码仓库和公开发布包均不包含私钥。

构建任务包含 Android Lint、ClientPolicy JVM 测试和 APK 编译。输出在 app/build/outputs/apk/release/app-release.apk。APK 发布前使用 Android SDK apksigner 验证签名，并生成 SHA-256 校验文件。

前端协议测试：src/lib/androidClient.test.ts。手机交互记录：docs/mobile-interactions.md。

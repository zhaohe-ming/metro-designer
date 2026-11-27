package com.metrodesigner.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String SITE = "https://www.metro-designer.com/";
    private static final int SAVE_DOCUMENT = 1001, PICK_DOCUMENT = 1002;
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private WebView web;
    private LinearLayout problem;
    private TextView problemText;
    private ProgressBar loading;
    private boolean rendererGone;
    private ValueCallback<Uri[]> fileChooser;
    private File exportFile;
    private FileOutputStream exportStream;
    private JavaScriptReplyProxy exportReply;
    private String exportId, exportName, exportMime;
    private long expectedBytes, receivedBytes;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return insets;
            });
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) controller.setSystemBarsAppearance(
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loading.setMax(100);
        loading.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(37, 99, 235)));
        FrameLayout.LayoutParams loadingLayout = new FrameLayout.LayoutParams(-1, Math.round(3 * getResources().getDisplayMetrics().density));
        loadingLayout.gravity = Gravity.TOP;
        root.addView(loading, loadingLayout);
        problem = new LinearLayout(this);
        problem.setOrientation(LinearLayout.VERTICAL);
        problem.setGravity(Gravity.CENTER);
        problem.setPadding(40, 40, 40, 40);
        problem.setBackgroundColor(Color.WHITE);
        problemText = new TextView(this);
        problemText.setTextSize(18);
        problemText.setTextColor(Color.rgb(15, 23, 42));
        problem.addView(problemText);
        Button retry = new Button(this);
        retry.setText("重新连接");
        retry.setOnClickListener(v -> { if (rendererGone) recreate(); else web.loadUrl(SITE); });
        problem.addView(retry);
        root.addView(problem, new FrameLayout.LayoutParams(-1, -1));
        problem.setVisibility(View.GONE);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " MetroDesignerAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // The bridge exists only on the two official HTTPS origins; subframes are rejected again below.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "MetroAndroid",
                new HashSet<>(Arrays.asList("https://www.metro-designer.com", "https://metro-designer.com")),
                (view, message, sourceOrigin, isMainFrame, reply) -> {
                    if (!isMainFrame || !ClientPolicy.isSite(sourceOrigin.toString()) || !ClientPolicy.isSite(view.getUrl())) return;
                    String data = message.getData();
                    if (data == null || data.length() > 100000) return;
                    files.execute(() -> handleExportMessage(data, reply));
                });
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String url = request.getUrl().toString();
                if (ClientPolicy.isSite(url)) return false;
                openExternal(url);
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                problem.setVisibility(View.GONE);
                files.execute(() -> clearExport());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showProblem("连接暂时中断，请检查网络后重试。");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showProblem("连接验证失败，请稍后重试。");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                rendererGone = true;
                view.destroy();
                showProblem("页面需要重新打开。");
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) {
                loading.setProgress(progress);
                loading.setVisibility(progress < 100 && problem.getVisibility() != View.VISIBLE ? View.VISIBLE : View.GONE);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooser != null) fileChooser.onReceiveValue(null);
                fileChooser = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                intent.setType(types.length == 1 && !types[0].isEmpty() ? types[0] : "*/*");
                if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                try { startActivityForResult(intent, PICK_DOCUMENT); }
                catch (ActivityNotFoundException e) { fileChooser.onReceiveValue(null); fileChooser = null; }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
                if (!userGesture) return false;
                WebView child = new WebView(MainActivity.this);
                child.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView unused, WebResourceRequest request) {
                        String url = request.getUrl().toString();
                        if (ClientPolicy.isSite(url)) web.loadUrl(url); else openExternal(url);
                        child.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(child);
                result.sendToTarget();
                return true;
            }
            @Override public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setTitle("离开当前作品？")
                    .setMessage("请先确认修改已经保存。")
                    .setPositiveButton("离开", (d, which) -> result.confirm())
                    .setNegativeButton("继续编辑", (d, which) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel()).show();
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (ClientPolicy.isExternal(url)) openExternal(url);
            else Toast.makeText(this, "请通过画布的导出按钮保存文件。", Toast.LENGTH_LONG).show();
        });
        web.loadUrl(SITE);
    }

    private void showProblem(String text) { problemText.setText(text); problem.setVisibility(View.VISIBLE); }
    private void openExternal(String url) {
        if (!ClientPolicy.isExternal(url)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
        catch (ActivityNotFoundException e) { Toast.makeText(this, "请安装浏览器后打开链接。", Toast.LENGTH_SHORT).show(); }
    }
    private void reply(JavaScriptReplyProxy proxy, String id, String status) {
        try {
            JSONObject value = new JSONObject().put("id", id).put("status", status);
            runOnUiThread(() -> {
                try {
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) proxy.postMessage(value.toString());
                } catch (Exception ignored) {}
            });
        } catch (Exception ignored) { /* The source page may already be closed. */ }
    }
    private void handleExportMessage(String data, JavaScriptReplyProxy proxy) {
        String id = "";
        try {
            JSONObject message = new JSONObject(data);
            id = message.getString("id");
            if (!id.matches("[A-Za-z0-9-]{1,80}")) return;
            String type = message.getString("type");
            if ("begin".equals(type)) {
                if (exportFile != null) throw new IllegalStateException("Export already pending");
                long size = message.getLong("size");
                ClientPolicy.validateProgress(size, 0, 1);
                exportMime = message.getString("mime");
                exportName = ClientPolicy.filename(message.getString("name"), exportMime);
                exportId = id;
                exportReply = proxy;
                expectedBytes = size;
                receivedBytes = 0;
                exportFile = File.createTempFile("metro-export-", ".tmp", getCacheDir());
                exportStream = new FileOutputStream(exportFile);
                reply(proxy, id, "ready");
            } else {
                if (!id.equals(exportId) || exportFile == null) throw new IllegalStateException("Unknown export");
                if ("chunk".equals(type)) {
                    byte[] bytes = Base64.decode(message.getString("data"), Base64.NO_WRAP);
                    ClientPolicy.validateProgress(expectedBytes, receivedBytes, bytes.length);
                    exportStream.write(bytes);
                    receivedBytes += bytes.length;
                    reply(proxy, id, "chunk");
                } else if ("finish".equals(type)) {
                    if (receivedBytes != expectedBytes) throw new IllegalStateException("Incomplete export");
                    exportStream.close();
                    exportStream = null;
                    runOnUiThread(() -> {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType(exportMime).putExtra(Intent.EXTRA_TITLE, exportName);
                        try { startActivityForResult(intent, SAVE_DOCUMENT); }
                        catch (ActivityNotFoundException e) { files.execute(() -> { reply(exportReply, exportId, "error"); clearExport(); }); }
                    });
                } else if ("cancel".equals(type)) clearExport();
            }
        } catch (Exception e) {
            reply(proxy, id, "error");
            if (id.equals(exportId)) clearExport();
        }
    }
    private void clearExport() {
        try { if (exportStream != null) exportStream.close(); } catch (Exception ignored) {}
        if (exportFile != null) exportFile.delete();
        exportFile = null; exportStream = null; exportReply = null; exportId = null;
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_DOCUMENT && fileChooser != null) {
            Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
            fileChooser.onReceiveValue(uri == null ? null : new Uri[]{uri});
            fileChooser = null;
        }
        if (request == SAVE_DOCUMENT) files.execute(() -> {
            if (exportFile == null) return;
            try {
                Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
                if (uri == null) { reply(exportReply, exportId, "cancelled"); return; }
                try (FileInputStream input = new FileInputStream(exportFile);
                     OutputStream output = getContentResolver().openOutputStream(uri, "w")) {
                    if (output == null) throw new IllegalStateException("No destination stream");
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                }
                reply(exportReply, exportId, "saved");
            } catch (Exception e) { reply(exportReply, exportId, "error"); }
            finally { clearExport(); }
        });
    }
    @Override public void onBackPressed() {
        handleBack();
    }
    private void handleBack() {
        if (rendererGone) { finish(); return; }
        if (web.canGoBack()) web.goBack();
        else new AlertDialog.Builder(this).setTitle("退出 TransitCanvas？")
            .setMessage("离开前请保存当前作品。")
            .setPositiveButton("退出", (d, which) -> finish()).setNegativeButton("继续设计", null).show();
    }
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onDestroy() {
        if (fileChooser != null) fileChooser.onReceiveValue(null);
        files.execute(() -> clearExport());
        files.shutdown();
        if (web != null && !rendererGone) web.destroy();
        super.onDestroy();
    }
}

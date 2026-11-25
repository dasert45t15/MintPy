package com.mintpy.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static class BackgroundWebView extends WebView {
        public BackgroundWebView(android.content.Context context) {
            super(context);
        }

        @Override
        protected void onWindowVisibilityChanged(int visibility) {
            if (visibility != View.GONE) {
                super.onWindowVisibilityChanged(visibility);
            }
        }
    }

    private static final class AsyncEntry {
        final String value;
        final long createdAtMs;

        AsyncEntry(String value) {
            this.value = value;
            this.createdAtMs = System.currentTimeMillis();
        }
    }

    private static MainActivity instance;
    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;
    private final ExecutorService networkPool = Executors.newFixedThreadPool(10);
    private final ConcurrentHashMap<String, AsyncEntry> asyncResults = new ConcurrentHashMap<>();
    private volatile int insetTopDp = 24;
    private volatile int insetBottomDp = 12;

    static {
        System.setProperty("http.keepAlive", "true");
        System.setProperty("http.maxConnections", "16");
    }

    public static MainActivity getInstance() {
        return instance;
    }

    private void putAsyncResult(String reqId, String value) {
        if (reqId == null || value == null) return;
        if (asyncResults.size() > 64) {
            long cutoff = System.currentTimeMillis() - 60000L;
            for (Map.Entry<String, AsyncEntry> e : asyncResults.entrySet()) {
                if (e.getValue().createdAtMs < cutoff) {
                    asyncResults.remove(e.getKey());
                }
            }
        }
        asyncResults.put(reqId, new AsyncEntry(value));
    }

    private void injectSafeInsets() {
        if (webView == null) return;
        final int top = insetTopDp;
        final int bottom = insetBottomDp;
        webView.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                    "document.documentElement.style.setProperty('--safe-top','" + top + "px');"
                    + "document.documentElement.style.setProperty('--safe-bottom','" + bottom + "px');",
                    null
                );
            }
        });
    }

    public void onMediaAction(final String action, final long seekMs) {
        if (webView != null) {
            webView.post(() -> {
                if (webView != null) {
                    webView.evaluateJavascript(
                        "window.__mintpyNativeMediaAction&&window.__mintpyNativeMediaAction("
                        + JSONObject.quote(action) + "," + seekMs + ")",
                        null
                    );
                }
            });
        }
    }

    public void onNativeAudioEvent(final String event, final long posMs, final long durMs, final boolean playing) {
        if (webView != null) {
            webView.post(() -> {
                if (webView != null) {
                    webView.evaluateJavascript(
                        "window.__mintpyNativeAudioEvent&&window.__mintpyNativeAudioEvent("
                        + JSONObject.quote(event) + "," + posMs + "," + durMs + "," + (playing ? "true" : "false") + ")",
                        null
                    );
                }
            });
        }
    }

    private String executeHttp(String method, String urlStr, String body, String headersJson) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
            conn.setRequestProperty("Accept-Encoding", "gzip");
            if ("POST".equalsIgnoreCase(method)) {
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("Accept", "application/json");
            }
            if (headersJson != null && !headersJson.isEmpty()) {
                try {
                    JSONObject headers = new JSONObject(headersJson);
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        conn.setRequestProperty(k, headers.getString(k));
                    }
                } catch (Exception ignored) {}
            }
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            if ("POST".equalsIgnoreCase(method) && body != null) {
                conn.setDoOutput(true);
                byte[] input = body.getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(input, 0, input.length);
                }
            }

            int code = conn.getResponseCode();
            InputStream rawIs = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            if (rawIs == null) return null;
            String encoding = conn.getContentEncoding();
            InputStream is = rawIs;
            if (encoding != null && encoding.toLowerCase().contains("gzip")) {
                try {
                    is = new GZIPInputStream(rawIs);
                } catch (Exception notGzip) {
                    is = rawIs;
                }
            }

            try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                char[] buf = new char[8192];
                int n;
                while ((n = reader.read(buf)) != -1) {
                    sb.append(buf, 0, n);
                }
                return sb.toString();
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private int executeProbe(String urlStr, String userAgent) {
        HttpURLConnection conn = null;
        try {
            String currentUrl = urlStr;
            for (int hop = 0; hop < 3; hop++) {
                URL url = new URL(currentUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("GET");
                String ua = (userAgent != null && !userAgent.trim().isEmpty())
                    ? userAgent
                    : "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
                conn.setRequestProperty("User-Agent", ua);
                conn.setRequestProperty("Range", "bytes=0-");
                conn.setRequestProperty("Accept-Encoding", "identity");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                int code = conn.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (location == null || location.trim().isEmpty()) return code;
                    currentUrl = new URL(url, location).toString();
                    continue;
                }
                return code;
            }
            return -1;
        } catch (Exception e) {
            return -1;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    public class AndroidBridge {
        @android.webkit.JavascriptInterface
        public void requestAsync(final String reqId, final String method, final String urlStr, final String body, final String headersJson) {
            networkPool.execute(() -> {
                boolean ok = false;
                String err = "";
                try {
                    String data = executeHttp(method, urlStr, body, headersJson);
                    if (data != null && reqId != null) {
                        putAsyncResult(reqId, data);
                        ok = true;
                    } else {
                        err = "Empty HTTP response";
                    }
                } catch (Exception e) {
                    err = (e.getMessage() != null && !e.getMessage().isEmpty()) ? e.getMessage() : "Network error";
                }
                final boolean finalOk = ok;
                final String finalErr = err;
                if (webView != null) {
                    webView.post(() -> {
                        if (webView != null) {
                            webView.evaluateJavascript(
                                "window.__mintpyNativeCb&&window.__mintpyNativeCb("
                                + JSONObject.quote(reqId) + ","
                                + (finalOk ? "true" : "false") + ","
                                + JSONObject.quote(finalErr) + ")",
                                null
                            );
                        } else if (reqId != null) {
                            asyncResults.remove(reqId);
                        }
                    });
                } else if (reqId != null) {
                    asyncResults.remove(reqId);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public String takeAsyncResult(String reqId) {
            if (reqId == null) return null;
            AsyncEntry entry = asyncResults.remove(reqId);
            return entry != null ? entry.value : null;
        }

        @android.webkit.JavascriptInterface
        public void probeStreamAsync(final String reqId, final String urlStr, final String userAgent) {
            networkPool.execute(() -> {
                int code = -1;
                try {
                    code = executeProbe(urlStr, userAgent);
                } catch (Exception ignored) {
                    code = -1;
                }
                if (reqId != null) {
                    putAsyncResult(reqId, String.valueOf(code));
                }
                if (webView != null) {
                    webView.post(() -> {
                        if (webView != null) {
                            webView.evaluateJavascript(
                                "window.__mintpyNativeCb&&window.__mintpyNativeCb("
                                + JSONObject.quote(reqId) + ",true,'')",
                                null
                            );
                        } else if (reqId != null) {
                            asyncResults.remove(reqId);
                        }
                    });
                } else if (reqId != null) {
                    asyncResults.remove(reqId);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public String registerProxyStream(String urlStr, String userAgent, String mimeType) {
            return LocalAudioProxy.getInstance().registerStream(urlStr, userAgent, mimeType);
        }

        @android.webkit.JavascriptInterface
        public void updateNativePlaybackPosition(double positionSec, double durationSec, boolean isPlaying) {
            try {
                PlaybackService.updatePositionDirect(
                    (long) (positionSec * 1000.0),
                    (long) (durationSec * 1000.0),
                    isPlaying
                );
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativePlayUrl(String url, String title, String artist, String album, String artworkUrl, double durationSec) {
            try {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_PLAY_URL);
                intent.putExtra("streamUrl", url);
                intent.putExtra("title", title);
                intent.putExtra("artist", artist);
                intent.putExtra("album", album);
                intent.putExtra("artworkUrl", artworkUrl);
                intent.putExtra("durationMs", (long) (durationSec * 1000.0));
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeResume() {
            try {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_PLAY);
                startService(intent);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativePause() {
            try {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_PAUSE);
                startService(intent);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSeekTo(double positionSec) {
            try {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_SEEK);
                intent.putExtra("positionMs", (long) (Math.max(0.0, positionSec) * 1000.0));
                startService(intent);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeStopPlayer() {
            try { PlaybackService.stopPlayerOnly(); } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSetEq(int lowDb, int midDb, int highDb) {
            try { PlaybackService.setEqLevels(lowDb, midDb, highDb); } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSetPlaybackSpeed(float speed) {
            try { PlaybackService.setPlaybackSpeed(speed); } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSetVolume(float volume) {
            try { PlaybackService.setVolumeLevel(volume); } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void setLightStatusBar(final boolean isLight) {
            runOnUiThread(() -> {
                try {
                    Window w = getWindow();
                    if (w == null) return;
                    if (Build.VERSION.SDK_INT >= 30) {
                        android.view.WindowInsetsController ctrl = w.getInsetsController();
                        if (ctrl != null) {
                            int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                            ctrl.setSystemBarsAppearance(isLight ? mask : 0, mask);
                        }
                    } else if (Build.VERSION.SDK_INT >= 26) {
                        int flags = w.getDecorView().getSystemUiVisibility();
                        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                        flags = isLight ? (flags | lightFlags) : (flags & ~lightFlags);
                        w.getDecorView().setSystemUiVisibility(flags);
                    } else if (Build.VERSION.SDK_INT >= 23) {
                        int flags = w.getDecorView().getSystemUiVisibility();
                        flags = isLight ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                        w.getDecorView().setSystemUiVisibility(flags);
                    }
                } catch (Throwable ignored) {}
            });
        }

        @android.webkit.JavascriptInterface
        public void updateNativeMediaSession(String title, String artist, String album, String artworkUrl, double durationSec, boolean isPlaying, double positionSec) {
            try {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_UPDATE);
                intent.putExtra("title", title);
                intent.putExtra("artist", artist);
                intent.putExtra("album", album);
                intent.putExtra("artworkUrl", artworkUrl);
                intent.putExtra("durationMs", (long) (durationSec * 1000));
                intent.putExtra("positionMs", (long) (positionSec * 1000));
                intent.putExtra("isPlaying", isPlaying);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void stopNativeMediaSession() {
            try {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_STOP);
                startService(intent);
            } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        LocalAudioProxy.getInstance().ensureStarted();
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1002);
            }
        }

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window window = getWindow();
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        window.clearFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            );
        }

        final FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#121413"));

        webView = new BackgroundWebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int topPx = 0;
            int bottomPx = 0;
            int imeBottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets sys = insets.getInsets(
                    android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout()
                );
                topPx = sys.top;
                bottomPx = sys.bottom;
                imeBottom = Math.max(0, insets.getInsets(android.view.WindowInsets.Type.ime()).bottom);
                v.setPadding(0, 0, 0, imeBottom);
            } else {
                topPx = insets.getSystemWindowInsetTop();
                bottomPx = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && insets.getDisplayCutout() != null) {
                    topPx = Math.max(topPx, insets.getDisplayCutout().getSafeInsetTop());
                }
            }
            float density = getResources().getDisplayMetrics().density;
            if (density <= 0f) density = 1f;
            insetTopDp = Math.max(0, Math.round(topPx / density));
            insetBottomDp = Math.max(0, Math.round(bottomPx / density));
            injectSafeInsets();
            if (Build.VERSION.SDK_INT >= 30) {
                return android.view.WindowInsets.CONSUMED;
            }
            return insets;
        });
        root.requestApplyInsets();

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) fileUploadCallback.onReceiveValue(null);
                fileUploadCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("audio/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(intent, "Select Audio Files"), FILE_CHOOSER_RESULT_CODE);
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                return super.onConsoleMessage(cm);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file://") || url.startsWith("data:") || url.startsWith("blob:")) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !request.isForMainFrame()) {
                    return false;
                }
                return shouldOverrideUrlLoading(view, request.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectSafeInsets();
            }
        });

        webView.loadUrl("file:///android_asset/src/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        PlaybackService.syncStateToActivity();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (fileUploadCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            fileUploadCallback.onReceiveValue(results);
            fileUploadCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        if (instance == this) instance = null;
        networkPool.shutdownNow();
        asyncResults.clear();
        super.onDestroy();
    }
}

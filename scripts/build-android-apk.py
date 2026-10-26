import os
import shutil
import subprocess
from PIL import Image

def main():
    base_dir = r"D:\mintpy"
    tools_dir = os.path.join(base_dir, "tools")
    jdk_bin = os.path.join(tools_dir, "jdk-17.0.20.1+1", "bin")
    sdk_dir = os.path.join(tools_dir, "android-sdk")
    build_tools = os.path.join(sdk_dir, "build-tools", "34.0.0")
    android_jar = os.path.join(sdk_dir, "platforms", "android-34", "android.jar")
    keystore = os.path.join(tools_dir, "mintpy-debug.keystore")

    aapt2 = os.path.join(build_tools, "aapt2.exe")
    d8_bat = os.path.join(build_tools, "d8.bat")
    zipalign = os.path.join(build_tools, "zipalign.exe")
    apksigner_bat = os.path.join(build_tools, "apksigner.bat")
    javac = os.path.join(jdk_bin, "javac.exe")
    jar_exe = os.path.join(jdk_bin, "jar.exe")

    build_dir = os.path.join(base_dir, "build_android")
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir)
    os.makedirs(build_dir, exist_ok=True)

    res_dir = os.path.join(build_dir, "res")
    values_dir = os.path.join(res_dir, "values")
    os.makedirs(values_dir, exist_ok=True)

    # 1. Write strings.xml and styles.xml
    with open(os.path.join(values_dir, "strings.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <string name="app_name">MintPy</string>\n</resources>\n')

    with open(os.path.join(values_dir, "styles.xml"), "w", encoding="utf-8") as f:
        f.write('''<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="AppTheme" parent="@android:style/Theme.Material.NoActionBar.Fullscreen">
    <item name="android:windowBackground">@android:color/black</item>
    <item name="android:colorBackground">#121413</item>
  </style>
</resources>
''')

    # 2. Launcher icons (all standard densities)
    logo_path = os.path.join(base_dir, "assets", "mintpy-logo.png")
    logo = Image.open(logo_path).convert("RGBA")
    icon_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in icon_sizes.items():
        folder_path = os.path.join(res_dir, folder)
        os.makedirs(folder_path, exist_ok=True)
        resized = logo.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(os.path.join(folder_path, "ic_launcher.png"))

    # 3. AndroidManifest.xml with complete SDK and screen support
    manifest_path = os.path.join(build_dir, "AndroidManifest.xml")
    with open(manifest_path, "w", encoding="utf-8") as f:
        f.write('''<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.mintpy.app"
    android:versionCode="50308"
    android:versionName="5.3.8">

    <uses-sdk
        android:minSdkVersion="24"
        android:targetSdkVersion="34" />

    <supports-screens
        android:smallScreens="true"
        android:normalScreens="true"
        android:largeScreens="true"
        android:xlargeScreens="true"
        android:anyDensity="true"
        android:resizeable="true" />

    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:allowBackup="true"
        android:hardwareAccelerated="true"
        android:largeHeap="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
''')

    # 4. Java source MainActivity.java
    src_dir = os.path.join(build_dir, "src", "com", "mintpy", "app")
    os.makedirs(src_dir, exist_ok=True)
    with open(os.path.join(src_dir, "MainActivity.java"), "w", encoding="utf-8") as f:
        f.write('''package com.mintpy.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;

    public class AndroidBridge {
        @android.webkit.JavascriptInterface
        public String postJson(String urlStr, String jsonBody) {
            return postJsonWithHeaders(urlStr, jsonBody, null);
        }

        @android.webkit.JavascriptInterface
        public String postJsonWithHeaders(String urlStr, String jsonBody, String headersJson) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
                conn.setRequestProperty("Accept", "application/json");
                if (headersJson != null && !headersJson.isEmpty()) {
                    try {
                        org.json.JSONObject headers = new org.json.JSONObject(headersJson);
                        java.util.Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            conn.setRequestProperty(k, headers.getString(k));
                        }
                    } catch (Exception ignored) {}
                }
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);

                byte[] input = jsonBody.getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(input, 0, input.length);
                }

                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                if (is == null) return null;

                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line).append((char) 10);
                }
                return sb.toString();
            } catch (Exception e) {
                return null;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @android.webkit.JavascriptInterface
        public String getUrl(String urlStr) {
            return getUrlWithHeaders(urlStr, null);
        }

        @android.webkit.JavascriptInterface
        public String getUrlWithHeaders(String urlStr, String headersJson) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
                if (headersJson != null && !headersJson.isEmpty()) {
                    try {
                        org.json.JSONObject headers = new org.json.JSONObject(headersJson);
                        java.util.Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            conn.setRequestProperty(k, headers.getString(k));
                        }
                    } catch (Exception ignored) {}
                }
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);

                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                if (is == null) return null;

                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line).append((char) 10);
                }
                return sb.toString();
            } catch (Exception e) {
                return null;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window window = getWindow();
        window.setFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                       WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#121413"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
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
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    if (!request.isForMainFrame()) return false;
                }
                String url = request.getUrl().toString();
                return shouldOverrideUrlLoading(view, url);
            }
        });

        webView.loadUrl("file:///android_asset/src/index.html");
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
            super.onBackPressed();
        }
    }
}
''')

    # 5. Copy web assets to build_android/assets (src + assets)
    assets_dest = os.path.join(build_dir, "assets")
    os.makedirs(assets_dest, exist_ok=True)
    shutil.copytree(os.path.join(base_dir, "src_mobile"), os.path.join(assets_dest, "src"))
    shutil.copytree(os.path.join(base_dir, "assets"), os.path.join(assets_dest, "assets"),
                    ignore=shutil.ignore_patterns("*-chroma.png", "pets"))

    compiled_res = os.path.join(build_dir, "compiled_res")
    os.makedirs(compiled_res, exist_ok=True)
    gen_dir = os.path.join(build_dir, "gen")
    bin_dir = os.path.join(build_dir, "bin")
    obj_dir = os.path.join(bin_dir, "obj")
    os.makedirs(gen_dir, exist_ok=True)
    os.makedirs(obj_dir, exist_ok=True)

    env = os.environ.copy()
    env["JAVA_HOME"] = os.path.join(tools_dir, "jdk-17.0.20.1+1")
    env["PATH"] = f"{jdk_bin};{build_tools};" + env.get("PATH", "")

    # Step A: aapt2 compile
    print("[1/6] aapt2 compile...")
    res_zip = os.path.join(compiled_res, "resources.zip")
    cmd_compile = [aapt2, "compile", "--dir", res_dir, "-o", res_zip]
    subprocess.check_call(cmd_compile, env=env)

    # Step B: aapt2 link WITHOUT -A (avoids Windows backslash bug in aapt2 asset packager)
    print("[2/6] aapt2 link...")
    unaligned_apk = os.path.join(bin_dir, "unaligned.apk")
    cmd_link = [
        aapt2, "link",
        "-I", android_jar,
        res_zip,
        "--manifest", manifest_path,
        "-o", unaligned_apk,
        "--java", gen_dir,
        "--min-sdk-version", "24",
        "--target-sdk-version", "34",
        "--auto-add-overlay"
    ]
    subprocess.check_call(cmd_link, env=env)

    # Step C: javac
    print("[3/6] javac...")
    r_java = os.path.join(gen_dir, "com", "mintpy", "app", "R.java")
    main_java = os.path.join(src_dir, "MainActivity.java")
    cmd_javac = [
        javac,
        "-encoding", "UTF-8",
        "-cp", android_jar,
        "-d", obj_dir,
        r_java, main_java
    ]
    subprocess.check_call(cmd_javac, env=env)

    # Step D: d8
    print("[4/6] d8...")
    class_files = []
    for root_w, _, files in os.walk(obj_dir):
        for f in files:
            if f.endswith(".class"):
                class_files.append(os.path.join(root_w, f))

    cmd_d8 = ["cmd.exe", "/c", d8_bat, "--lib", android_jar, "--output", bin_dir] + class_files
    subprocess.check_call(cmd_d8, env=env)

    # Step E: Add classes.dex AND web assets into unaligned.apk cleanly using jar.exe
    # jar.exe guarantees 100% POSIX forward slashes ('/') in all asset paths!
    print("[5/6] Packaging classes.dex and web assets with jar tool...")
    cmd_jar_dex = [jar_exe, "-uf", unaligned_apk, "-C", bin_dir, "classes.dex"]
    subprocess.check_call(cmd_jar_dex, env=env)

    cmd_jar_assets = [jar_exe, "-uf", unaligned_apk, "-C", build_dir, "assets"]
    subprocess.check_call(cmd_jar_assets, env=env)

    # Step F: zipalign
    print("[6/6] zipalign & apksigner...")
    releases_dir = os.path.join(base_dir, "releases")
    os.makedirs(releases_dir, exist_ok=True)
    aligned_apk = os.path.join(releases_dir, "MintPy-v5.3.8.apk")
    if os.path.exists(aligned_apk):
        os.remove(aligned_apk)

    cmd_align = [zipalign, "-v", "-p", "4", unaligned_apk, aligned_apk]
    subprocess.check_call(cmd_align, env=env)

    # Step G: apksigner with v1 + v2 + v3 schemes
    cmd_sign = [
        "cmd.exe", "/c", apksigner_bat, "sign",
        "--ks", keystore,
        "--ks-pass", "pass:android",
        "--key-pass", "pass:android",
        "--v1-signing-enabled", "true",
        "--v2-signing-enabled", "true",
        "--v3-signing-enabled", "true",
        "--v4-signing-enabled", "false",
        aligned_apk
    ]
    subprocess.check_call(cmd_sign, env=env)

    # Verify
    cmd_verify = ["cmd.exe", "/c", apksigner_bat, "verify", "--verbose", aligned_apk]
    subprocess.check_call(cmd_verify, env=env)

    apk_size_mb = os.path.getsize(aligned_apk) / (1024 * 1024)
    print(f"\nSUCCESS! MintPy Android APK built and signed:\n  -> {aligned_apk} ({apk_size_mb:.2f} MB)")

if __name__ == "__main__":
    main()

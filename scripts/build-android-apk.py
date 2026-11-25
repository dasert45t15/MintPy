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
  <style name="AppTheme" parent="@android:style/Theme.Material.NoActionBar">
    <item name="android:windowBackground">@android:color/black</item>
    <item name="android:colorBackground">#121413</item>
    <item name="android:statusBarColor">@android:color/transparent</item>
    <item name="android:navigationBarColor">@android:color/transparent</item>
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
    android:versionCode="50406"
    android:versionName="5.4.6">

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
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
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
            android:launchMode="singleTop"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <service
            android:name=".PlaybackService"
            android:foregroundServiceType="mediaPlayback"
            android:exported="false" />
    </application>
</manifest>
''')

    # 4. Java sources: LocalAudioProxy.java, PlaybackService.java & MainActivity.java
    src_dir = os.path.join(build_dir, "src", "com", "mintpy", "app")
    os.makedirs(src_dir, exist_ok=True)
    with open(os.path.join(src_dir, "LocalAudioProxy.java"), "w", encoding="utf-8") as f:
        f.write(r'''package com.mintpy.app;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public class LocalAudioProxy {
    private static volatile LocalAudioProxy instance;

    private static final class StreamEntry {
        final String url;
        final String userAgent;
        final String mimeType;

        StreamEntry(String url, String userAgent, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.mimeType = mimeType;
        }
    }

    private final ConcurrentHashMap<String, StreamEntry> entries = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<String> order = new ConcurrentLinkedQueue<>();
    private final AtomicLong seq = new AtomicLong(0);
    private final SecureRandom rng = new SecureRandom();
    private final ExecutorService clientPool = Executors.newCachedThreadPool();

    private ServerSocket serverSocket;
    private volatile int port = -1;

    private LocalAudioProxy() {}

    public static synchronized LocalAudioProxy getInstance() {
        if (instance == null) {
            instance = new LocalAudioProxy();
        }
        return instance;
    }

    public synchronized int ensureStarted() {
        if (serverSocket != null && !serverSocket.isClosed() && port > 0) {
            return port;
        }
        try {
            serverSocket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
            port = serverSocket.getLocalPort();
            final ServerSocket ss = serverSocket;
            Thread acceptThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (!ss.isClosed()) {
                        try {
                            final Socket client = ss.accept();
                            clientPool.execute(new Runnable() {
                                @Override
                                public void run() {
                                    handleClient(client);
                                }
                            });
                        } catch (IOException e) {
                            if (ss.isClosed()) break;
                        }
                    }
                }
            }, "mintpy-audio-proxy");
            acceptThread.setDaemon(true);
            acceptThread.start();
            return port;
        } catch (IOException e) {
            port = -1;
            return -1;
        }
    }

    public String registerStream(String url, String userAgent, String mimeType) {
        if (url == null || url.trim().isEmpty()) return null;
        int p = ensureStarted();
        if (p <= 0) return null;

        while (entries.size() >= 64) {
            String oldest = order.poll();
            if (oldest == null) break;
            entries.remove(oldest);
        }

        String id = Long.toHexString(seq.incrementAndGet()) + "_" + Long.toHexString(rng.nextLong() & 0x7FFFFFFFFFFFFFFFL);
        entries.put(id, new StreamEntry(url, userAgent, mimeType));
        order.add(id);
        return "http://127.0.0.1:" + p + "/stream?id=" + id;
    }

    private void handleClient(Socket client) {
        HttpURLConnection conn = null;
        try {
            client.setSoTimeout(20000);
            client.setTcpNoDelay(true);
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
            OutputStream out = client.getOutputStream();

            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.trim().isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase();
            String fullPath = parts[1];

            String rangeHeader = null;
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) break;
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim();
                    if ("Range".equalsIgnoreCase(name)) {
                        rangeHeader = line.substring(colon + 1).trim();
                    }
                }
            }

            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                writeSimpleStatus(out, 405, "Method Not Allowed");
                return;
            }

            String pathOnly = fullPath;
            String query = "";
            int qIdx = fullPath.indexOf('?');
            if (qIdx >= 0) {
                pathOnly = fullPath.substring(0, qIdx);
                query = fullPath.substring(qIdx + 1);
            }

            String id = null;
            if (!query.isEmpty()) {
                for (String kv : query.split("&")) {
                    int eq = kv.indexOf('=');
                    if (eq > 0) {
                        String k = URLDecoder.decode(kv.substring(0, eq), "UTF-8");
                        if ("id".equals(k)) {
                            id = URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                            break;
                        }
                    }
                }
            }

            StreamEntry entry = ("/stream".equals(pathOnly) && id != null) ? entries.get(id) : null;
            if (entry == null) {
                writeSimpleStatus(out, 404, "Not Found");
                return;
            }

            String currentUrl = entry.url;
            int code = -1;
            for (int hop = 0; hop < 5; hop++) {
                URL url = new URL(currentUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod(method);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(25000);
                String ua = (entry.userAgent != null && !entry.userAgent.trim().isEmpty())
                    ? entry.userAgent
                    : "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
                conn.setRequestProperty("User-Agent", ua);
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Accept-Encoding", "identity");
                if (rangeHeader != null && !rangeHeader.trim().isEmpty()) {
                    conn.setRequestProperty("Range", rangeHeader);
                }

                code = conn.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (location == null || location.trim().isEmpty()) break;
                    currentUrl = new URL(url, location).toString();
                    continue;
                }
                break;
            }

            if (conn == null || code <= 0) {
                writeSimpleStatus(out, 502, "Bad Gateway");
                return;
            }

            String reason = conn.getResponseMessage();
            if (reason == null || reason.trim().isEmpty()) {
                reason = (code == 206) ? "Partial Content" : "OK";
            }
            String contentType = conn.getContentType();
            if (contentType == null || contentType.trim().isEmpty()) {
                contentType = (entry.mimeType != null && !entry.mimeType.trim().isEmpty())
                    ? entry.mimeType
                    : "video/mp4";
            }
            String contentLength = conn.getHeaderField("Content-Length");
            String contentRange = conn.getHeaderField("Content-Range");

            StringBuilder headers = new StringBuilder();
            headers.append("HTTP/1.1 ").append(code).append(" ").append(reason).append("\r\n");
            headers.append("Content-Type: ").append(contentType).append("\r\n");
            headers.append("Accept-Ranges: bytes\r\n");
            if (contentLength != null && !contentLength.trim().isEmpty()) {
                headers.append("Content-Length: ").append(contentLength.trim()).append("\r\n");
            }
            if (contentRange != null && !contentRange.trim().isEmpty()) {
                headers.append("Content-Range: ").append(contentRange.trim()).append("\r\n");
            }
            headers.append("Access-Control-Allow-Origin: *\r\n");
            headers.append("Cache-Control: no-store\r\n");
            headers.append("Connection: close\r\n\r\n");

            out.write(headers.toString().getBytes(StandardCharsets.US_ASCII));
            out.flush();

            if (!"HEAD".equals(method) && code >= 200 && code < 400) {
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                    out.flush();
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    private void writeSimpleStatus(OutputStream out, int code, String reason) throws IOException {
        String resp = "HTTP/1.1 " + code + " " + reason + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }
}
''')

    with open(os.path.join(src_dir, "PlaybackService.java"), "w", encoding="utf-8") as f:
        f.write('''package com.mintpy.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.audiofx.Equalizer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class PlaybackService extends Service {
    public static final String CHANNEL_ID = "mintpy_playback";
    public static final int NOTIFICATION_ID = 1001;

    public static final String ACTION_UPDATE = "com.mintpy.app.ACTION_UPDATE";
    public static final String ACTION_PLAY_URL = "com.mintpy.app.ACTION_PLAY_URL";
    public static final String ACTION_PLAY = "com.mintpy.app.ACTION_PLAY";
    public static final String ACTION_PAUSE = "com.mintpy.app.ACTION_PAUSE";
    public static final String ACTION_PLAY_PAUSE = "com.mintpy.app.ACTION_PLAY_PAUSE";
    public static final String ACTION_NEXT = "com.mintpy.app.ACTION_NEXT";
    public static final String ACTION_PREV = "com.mintpy.app.ACTION_PREV";
    public static final String ACTION_SEEK = "com.mintpy.app.ACTION_SEEK";
    public static final String ACTION_STOP = "com.mintpy.app.ACTION_STOP";

    private static volatile PlaybackService activeInstance;
    private static volatile int eqLowDb = 0;
    private static volatile int eqMidDb = 0;
    private static volatile int eqHighDb = 0;
    private static volatile float playbackSpeed = 1.0f;

    private MediaSession mediaSession;
    private MediaPlayer mediaPlayer;
    private Equalizer equalizer;
    private boolean isPrepared = false;
    private boolean playWhenPrepared = false;
    private String currentStreamUrl = "";

    private AudioManager audioManager;
    private Object audioFocusRequestObj;
    private PowerManager.WakeLock wakeLock;

    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private BroadcastReceiver noisyReceiver;
    private boolean noisyRegistered = false;

    private String currentTitle = "MintPy";
    private String currentArtist = "";
    private String currentAlbum = "";
    private String currentArtworkUrl = "";
    private Bitmap currentBitmap = null;
    private long durationMs = 0L;
    private long positionMs = 0L;
    private boolean isPlaying = false;

    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            if (mediaPlayer != null && isPrepared && isPlaying) {
                try {
                    positionMs = Math.max(0L, mediaPlayer.getCurrentPosition());
                    int d = mediaPlayer.getDuration();
                    if (d > 0) durationMs = d;
                } catch (Exception ignored) {}
                notifyJsAudioEvent("timeupdate", positionMs, durationMs, true);
                progressHandler.postDelayed(this, 500L);
            }
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener = new AudioManager.OnAudioFocusChangeListener() {
        @Override
        public void onAudioFocusChange(int focusChange) {
            if (mediaPlayer == null) return;
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                if (isPlaying || playWhenPrepared) {
                    pauseNativeInternal(true);
                }
            } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                try {
                    if (isPrepared) {
                        mediaPlayer.setVolume(0.25f, 0.25f);
                    }
                } catch (Exception ignored) {}
            } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
                try {
                    if (isPrepared) {
                        mediaPlayer.setVolume(1.0f, 1.0f);
                    }
                } catch (Exception ignored) {}
            }
        }
    };

    public static boolean isServicePlaying() {
        PlaybackService svc = activeInstance;
        return svc != null && svc.isPlaying;
    }

    public static void syncStateToActivity() {
        PlaybackService svc = activeInstance;
        if (svc != null && svc.mediaPlayer != null) {
            if (svc.isPrepared) {
                try {
                    svc.positionMs = Math.max(0L, svc.mediaPlayer.getCurrentPosition());
                    int d = svc.mediaPlayer.getDuration();
                    if (d > 0) svc.durationMs = d;
                    svc.isPlaying = svc.mediaPlayer.isPlaying();
                } catch (Exception ignored) {}
            }
            svc.notifyJsAudioEvent("sync", svc.positionMs, svc.durationMs, svc.isPlaying);
            if (svc.isPlaying && svc.isPrepared) {
                svc.startProgressTicker();
            }
        }
    }

    public static void stopPlayerOnly() {
        PlaybackService svc = activeInstance;
        if (svc != null) {
            svc.releasePlayer();
            svc.currentStreamUrl = "";
            svc.abandonAudioFocus();
        }
    }

    public static void setEqLevels(int low, int mid, int high) {
        eqLowDb = Math.max(-12, Math.min(12, low));
        eqMidDb = Math.max(-12, Math.min(12, mid));
        eqHighDb = Math.max(-12, Math.min(12, high));
        final PlaybackService svc = activeInstance;
        if (svc != null) {
            svc.progressHandler.post(new Runnable() {
                @Override
                public void run() {
                    svc.applyEqualizerBands();
                }
            });
        }
    }

    public static void setPlaybackSpeed(float speed) {
        playbackSpeed = Math.max(0.5f, Math.min(2.0f, speed));
        final PlaybackService svc = activeInstance;
        if (svc != null) {
            svc.progressHandler.post(new Runnable() {
                @Override
                public void run() {
                    svc.applyPlaybackSpeed();
                    svc.updatePlaybackState();
                }
            });
        }
    }

    public static void updatePositionDirect(long posMs, long durMs, boolean playing) {
        PlaybackService svc = activeInstance;
        if (svc != null && svc.mediaPlayer == null) {
            svc.positionMs = Math.max(0L, posMs);
            if (durMs > 0L) svc.durationMs = durMs;
            svc.isPlaying = playing;
            svc.updatePlaybackState();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        activeInstance = this;
        createNotificationChannel();
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        currentBitmap = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);

        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent != null && AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                    if (mediaPlayer != null && (isPlaying || playWhenPrepared)) {
                        pauseNativeInternal(true);
                    } else if (isPlaying) {
                        isPlaying = false;
                        updateWakeLock(false);
                        updatePlaybackState();
                        updateNotification();
                        notifyJsAction("pause", 0L);
                    }
                }
            }
        };
        try {
            IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(noisyReceiver, filter);
            }
            noisyRegistered = true;
        } catch (Exception ignored) {}

        mediaSession = new MediaSession(this, "MintPyMediaSession");
        mediaSession.setFlags(
            MediaSession.FLAG_HANDLES_MEDIA_BUTTONS |
            MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                resumeNativeInternal(true);
            }

            @Override
            public void onPause() {
                pauseNativeInternal(true);
            }

            @Override
            public void onSkipToNext() {
                notifyJsAction("next", 0L);
            }

            @Override
            public void onSkipToPrevious() {
                notifyJsAction("prev", 0L);
            }

            @Override
            public void onSeekTo(long pos) {
                seekNativeInternal(pos, true);
            }

            @Override
            public void onStop() {
                releasePlayer();
                currentStreamUrl = "";
                abandonAudioFocus();
                isPlaying = false;
                updateWakeLock(false);
                updatePlaybackState();
                notifyJsAction("stop", 0L);
                stopForegroundCompat(true);
                stopSelf();
            }
        });
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (action == null) return START_NOT_STICKY;

        switch (action) {
            case ACTION_PLAY_URL: {
                String url = intent.getStringExtra("streamUrl");
                String title = intent.getStringExtra("title");
                String artist = intent.getStringExtra("artist");
                String album = intent.getStringExtra("album");
                String artworkUrl = intent.getStringExtra("artworkUrl");
                long durMs = intent.getLongExtra("durationMs", 0L);
                if (url != null && !url.isEmpty()) {
                    startPlayUrl(url, title, artist, album, artworkUrl, durMs);
                }
                break;
            }

            case ACTION_UPDATE: {
                String title = intent.getStringExtra("title");
                String artist = intent.getStringExtra("artist");
                String album = intent.getStringExtra("album");
                String artworkUrl = intent.getStringExtra("artworkUrl");
                durationMs = intent.getLongExtra("durationMs", 0L);
                positionMs = intent.getLongExtra("positionMs", 0L);
                isPlaying = intent.getBooleanExtra("isPlaying", false);

                if (title != null && !title.isEmpty()) currentTitle = title;
                currentArtist = artist != null ? artist : "";
                currentAlbum = album != null ? album : "";

                updateWakeLock(isPlaying);
                updateMetadata();
                updatePlaybackState();
                startForegroundCompat(buildNotification());
                updateArtworkIfChanged(artworkUrl);
                break;
            }

            case ACTION_PLAY:
                resumeNativeInternal(true);
                break;

            case ACTION_PAUSE:
                pauseNativeInternal(true);
                break;

            case ACTION_PLAY_PAUSE:
                if (isPlaying) {
                    pauseNativeInternal(true);
                } else {
                    resumeNativeInternal(true);
                }
                break;

            case ACTION_SEEK:
                seekNativeInternal(intent.getLongExtra("positionMs", 0L), true);
                break;

            case ACTION_NEXT:
                notifyJsAction("next", 0L);
                break;

            case ACTION_PREV:
                notifyJsAction("prev", 0L);
                break;

            case ACTION_STOP:
                releasePlayer();
                currentStreamUrl = "";
                abandonAudioFocus();
                isPlaying = false;
                updateWakeLock(false);
                updatePlaybackState();
                stopForegroundCompat(true);
                stopSelf();
                break;
        }
        return START_NOT_STICKY;
    }

    private void startPlayUrl(String url, String title, String artist, String album, String artworkUrl, long durMs) {
        if (title != null && !title.isEmpty()) currentTitle = title;
        currentArtist = artist != null ? artist : "";
        currentAlbum = album != null ? album : "";
        durationMs = Math.max(0L, durMs);
        positionMs = 0L;
        currentStreamUrl = url;

        releasePlayer();
        playWhenPrepared = true;
        isPrepared = false;
        isPlaying = true;

        updateWakeLock(true);
        updateMetadata();
        updatePlaybackState();
        startForegroundCompat(buildNotification());
        updateArtworkIfChanged(artworkUrl);

        try {
            final MediaPlayer mp = new MediaPlayer();
            mediaPlayer = mp;
            mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
            mp.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);
            mp.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer player) {
                    if (player != mediaPlayer) return;
                    isPrepared = true;
                    try {
                        int mpDur = player.getDuration();
                        if (mpDur > 0) durationMs = mpDur;
                    } catch (Exception ignored) {}
                    try { setupEqualizer(player.getAudioSessionId()); } catch (Throwable ignored) {}
                    if (playWhenPrepared) {
                        requestAudioFocus();
                        try {
                            player.start();
                            isPlaying = true;
                            applyPlaybackSpeed();
                            updateWakeLock(true);
                            updateMetadata();
                            updatePlaybackState();
                            updateNotification();
                            startProgressTicker();
                            notifyJsAudioEvent("prepared", 0L, durationMs, true);
                            notifyJsAudioEvent("play", 0L, durationMs, true);
                        } catch (Exception e) {
                            isPlaying = false;
                            updateWakeLock(false);
                            updatePlaybackState();
                            updateNotification();
                            notifyJsAudioEvent("error", -1L, -1L, false);
                        }
                    } else {
                        isPlaying = false;
                        updateWakeLock(false);
                        updateMetadata();
                        updatePlaybackState();
                        updateNotification();
                        notifyJsAudioEvent("prepared", 0L, durationMs, false);
                    }
                }
            });
            mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer player) {
                    if (player != mediaPlayer) return;
                    isPlaying = false;
                    playWhenPrepared = false;
                    updateWakeLock(false);
                    stopProgressTicker();
                    positionMs = durationMs;
                    updatePlaybackState();
                    updateNotification();
                    notifyJsAudioEvent("ended", durationMs, durationMs, false);
                }
            });
            mp.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer player, int what, int extra) {
                    if (player != mediaPlayer) return true;
                    isPrepared = false;
                    playWhenPrepared = false;
                    isPlaying = false;
                    updateWakeLock(false);
                    stopProgressTicker();
                    updatePlaybackState();
                    updateNotification();
                    notifyJsAudioEvent("error", what, extra, false);
                    return true;
                }
            });
            mp.setDataSource(url);
            mp.prepareAsync();
        } catch (Exception e) {
            isPrepared = false;
            playWhenPrepared = false;
            isPlaying = false;
            updateWakeLock(false);
            notifyJsAudioEvent("error", -1L, -1L, false);
        }
    }

    private void resumeNativeInternal(boolean notifyJs) {
        if (mediaPlayer != null && isPrepared) {
            requestAudioFocus();
            try {
                if (!mediaPlayer.isPlaying()) {
                    mediaPlayer.start();
                }
                positionMs = Math.max(0L, mediaPlayer.getCurrentPosition());
            } catch (Exception ignored) {}
            isPlaying = true;
            applyPlaybackSpeed();
            updateWakeLock(true);
            updatePlaybackState();
            updateNotification();
            startProgressTicker();
            if (notifyJs) {
                notifyJsAudioEvent("play", positionMs, durationMs, true);
            }
        } else if (currentStreamUrl != null && !currentStreamUrl.isEmpty()) {
            if (mediaPlayer != null) {
                playWhenPrepared = true;
                isPlaying = true;
                updateWakeLock(true);
                updatePlaybackState();
                updateNotification();
            } else {
                startPlayUrl(currentStreamUrl, currentTitle, currentArtist, currentAlbum, currentArtworkUrl, durationMs);
            }
        } else {
            isPlaying = true;
            applyPlaybackSpeed();
            updateWakeLock(true);
            updatePlaybackState();
            updateNotification();
            if (notifyJs) {
                notifyJsAction("play", 0L);
            }
        }
    }

    private void pauseNativeInternal(boolean notifyJs) {
        playWhenPrepared = false;
        if (mediaPlayer != null) {
            if (isPrepared) {
                try {
                    if (mediaPlayer.isPlaying()) {
                        mediaPlayer.pause();
                    }
                    positionMs = Math.max(0L, mediaPlayer.getCurrentPosition());
                } catch (Exception ignored) {}
            }
            isPlaying = false;
            updateWakeLock(false);
            stopProgressTicker();
            updatePlaybackState();
            updateNotification();
            if (notifyJs) {
                notifyJsAudioEvent("pause", positionMs, durationMs, false);
            }
        } else {
            isPlaying = false;
            updateWakeLock(false);
            stopProgressTicker();
            updatePlaybackState();
            updateNotification();
            if (notifyJs) {
                notifyJsAction("pause", 0L);
            }
        }
    }

    private void seekNativeInternal(long posMs, boolean notifyJs) {
        positionMs = Math.max(0L, posMs);
        if (mediaPlayer != null && isPrepared) {
            try {
                if (durationMs > 0 && positionMs > durationMs) {
                    positionMs = durationMs;
                }
                mediaPlayer.seekTo((int) positionMs);
            } catch (Exception ignored) {}
            updatePlaybackState();
            if (notifyJs) {
                notifyJsAudioEvent("timeupdate", positionMs, durationMs, isPlaying);
            }
        } else if (mediaPlayer == null && notifyJs) {
            notifyJsAction("seekto", positionMs);
        }
    }

    private void releasePlayer() {
        stopProgressTicker();
        isPrepared = false;
        playWhenPrepared = false;
        final Equalizer eq = equalizer;
        equalizer = null;
        final MediaPlayer mp = mediaPlayer;
        mediaPlayer = null;
        if (mp != null || eq != null) {
            try {
                if (mp != null) {
                    mp.setOnPreparedListener(null);
                    mp.setOnCompletionListener(null);
                    mp.setOnErrorListener(null);
                }
            } catch (Exception ignored) {}
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    if (eq != null) {
                        try { eq.release(); } catch (Throwable ignored) {}
                    }
                    if (mp != null) {
                        try {
                            if (mp.isPlaying()) mp.stop();
                        } catch (Exception ignored) {}
                        try { mp.reset(); } catch (Exception ignored) {}
                        try { mp.release(); } catch (Exception ignored) {}
                    }
                }
            }, "MintPy-ReleasePlayer");
            t.setDaemon(true);
            t.start();
        }
    }

    private void setupEqualizer(int audioSessionId) {
        try {
            if (equalizer != null) {
                try { equalizer.release(); } catch (Throwable ignored) {}
                equalizer = null;
            }
            if (audioSessionId == 0 || audioSessionId == -1) return;
            equalizer = new Equalizer(0, audioSessionId);
            applyEqualizerBands();
        } catch (Throwable ignored) {
            equalizer = null;
        }
    }

    private void applyEqualizerBands() {
        try {
            if (equalizer == null) return;
            boolean active = (eqLowDb != 0 || eqMidDb != 0 || eqHighDb != 0);
            equalizer.setEnabled(active);
            if (!active) return;
            short bands = equalizer.getNumberOfBands();
            short[] range = equalizer.getBandLevelRange();
            short minLvl = range[0];
            short maxLvl = range[1];
            for (short i = 0; i < bands; i++) {
                int freqMHz = equalizer.getCenterFreq(i);
                int targetDb = (freqMHz < 300000) ? eqLowDb : (freqMHz <= 2500000 ? eqMidDb : eqHighDb);
                short levelMb = (short) Math.max(minLvl, Math.min(maxLvl, targetDb * 100));
                equalizer.setBandLevel(i, levelMb);
            }
        } catch (Throwable ignored) {}
    }

    private void applyPlaybackSpeed() {
        try {
            if (mediaPlayer != null && isPrepared && isPlaying) {
                float clamped = Math.max(0.5f, Math.min(2.0f, playbackSpeed));
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    mediaPlayer.setPlaybackParams(mediaPlayer.getPlaybackParams().setSpeed(clamped));
                }
            }
        } catch (Throwable ignored) {}
    }

    private void startProgressTicker() {
        progressHandler.removeCallbacks(progressRunnable);
        progressHandler.postDelayed(progressRunnable, 500L);
    }

    private void stopProgressTicker() {
        progressHandler.removeCallbacks(progressRunnable);
    }

    private void requestAudioFocus() {
        try {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequestObj == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                    audioFocusRequestObj = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
                }
                audioManager.requestAudioFocus((AudioFocusRequest) audioFocusRequestObj);
            } else {
                audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
        } catch (Exception ignored) {}
    }

    private void abandonAudioFocus() {
        try {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequestObj != null) {
                audioManager.abandonAudioFocusRequest((AudioFocusRequest) audioFocusRequestObj);
            } else {
                audioManager.abandonAudioFocus(focusListener);
            }
        } catch (Exception ignored) {}
    }

    private void updateArtworkIfChanged(String artworkUrl) {
        if (artworkUrl != null && !artworkUrl.equals(currentArtworkUrl)) {
            currentArtworkUrl = artworkUrl;
            if (!artworkUrl.isEmpty()) {
                fetchArtworkAsync(artworkUrl);
            } else {
                currentBitmap = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
                updateMetadata();
                updateNotification();
            }
        }
    }

    private void updateWakeLock(boolean playing) {
        try {
            if (playing) {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                    if (pm != null) {
                        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MintPy::PlaybackWakeLock");
                        wakeLock.setReferenceCounted(false);
                    }
                }
                if (wakeLock != null && !wakeLock.isHeld()) {
                    wakeLock.acquire(4L * 60L * 60L * 1000L);
                }
            } else {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
            }
        } catch (Exception ignored) {}
    }

    private void notifyJsAction(String action, long seekMs) {
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.onMediaAction(action, seekMs);
        }
    }

    private void notifyJsAudioEvent(String event, long posMs, long durMs, boolean playing) {
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.onNativeAudioEvent(event, posMs, durMs, playing);
        }
    }

    private void fetchArtworkAsync(final String urlStr) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    URL url = new URL(urlStr);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(10000);
                    conn.setDoInput(true);
                    conn.connect();
                    if (conn.getResponseCode() == 200) {
                        InputStream is = conn.getInputStream();
                        final Bitmap bmp = BitmapFactory.decodeStream(is);
                        is.close();
                        if (bmp != null && urlStr.equals(currentArtworkUrl)) {
                            currentBitmap = bmp;
                            updateMetadata();
                            updateNotification();
                        }
                    }
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }).start();
    }

    private void updateMetadata() {
        if (mediaSession == null) return;
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, currentAlbum)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (currentBitmap != null) {
            builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, currentBitmap);
            builder.putBitmap(MediaMetadata.METADATA_KEY_ART, currentBitmap);
        }
        mediaSession.setMetadata(builder.build());
    }

    private void updatePlaybackState() {
        if (mediaSession == null) return;
        int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        float speed = isPlaying ? Math.max(0.5f, Math.min(2.0f, playbackSpeed)) : 0.0f;
        long actions =
            PlaybackState.ACTION_PLAY |
            PlaybackState.ACTION_PAUSE |
            PlaybackState.ACTION_PLAY_PAUSE |
            PlaybackState.ACTION_SKIP_TO_NEXT |
            PlaybackState.ACTION_SKIP_TO_PREVIOUS |
            PlaybackState.ACTION_SEEK_TO |
            PlaybackState.ACTION_STOP;

        PlaybackState playbackState = new PlaybackState.Builder()
            .setActions(actions)
            .setState(state, positionMs, speed, SystemClock.elapsedRealtime())
            .build();
        mediaSession.setPlaybackState(playbackState);
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent, piFlags);

        PendingIntent prevIntent = PendingIntent.getService(
            this, 1, new Intent(this, PlaybackService.class).setAction(ACTION_PREV), piFlags
        );
        PendingIntent playPauseIntent = PendingIntent.getService(
            this, 2, new Intent(this, PlaybackService.class).setAction(isPlaying ? ACTION_PAUSE : ACTION_PLAY), piFlags
        );
        PendingIntent nextIntent = PendingIntent.getService(
            this, 3, new Intent(this, PlaybackService.class).setAction(ACTION_NEXT), piFlags
        );

        int playPauseIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String playPauseLabel = isPlaying ? "Пауза" : "Играть";

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setSubText(currentAlbum)
            .setContentIntent(contentIntent)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Предыдущий", prevIntent).build())
            .addAction(new Notification.Action.Builder(playPauseIcon, playPauseLabel, playPauseIntent).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Следующий", nextIntent).build())
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));

        if (currentBitmap != null) {
            builder.setLargeIcon(currentBitmap);
        }

        return builder.build();
    }

    private void updateNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, buildNotification());
            }
        } catch (Exception ignored) {}
    }

    private void startForegroundCompat(Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            updateNotification();
        }
    }

    private void stopForegroundCompat(boolean removeNotification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(removeNotification ? STOP_FOREGROUND_REMOVE : STOP_FOREGROUND_DETACH);
            } else {
                stopForeground(removeNotification);
            }
        } catch (Exception ignored) {}
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Воспроизведение аудио",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Управление плеером MintPy и отображение на экране блокировки");
            channel.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!isPlaying) {
            releasePlayer();
            abandonAudioFocus();
            updateWakeLock(false);
            stopForegroundCompat(true);
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        if (noisyRegistered && noisyReceiver != null) {
            try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
            noisyRegistered = false;
        }
        releasePlayer();
        abandonAudioFocus();
        updateWakeLock(false);
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
''')

    with open(os.path.join(src_dir, "MainActivity.java"), "w", encoding="utf-8") as f:
        f.write('''package com.mintpy.app;

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

    private static MainActivity instance;
    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;
    private final ExecutorService networkPool = Executors.newFixedThreadPool(10);
    private final ConcurrentHashMap<String, String> asyncResults = new ConcurrentHashMap<>();
    private volatile int insetTopDp = 24;
    private volatile int insetBottomDp = 12;

    private void injectSafeInsets() {
        if (webView == null) return;
        final int top = insetTopDp;
        final int bottom = insetBottomDp;
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript(
                        "document.documentElement.style.setProperty('--safe-top','" + top + "px');"
                        + "document.documentElement.style.setProperty('--safe-bottom','" + bottom + "px');",
                        null
                    );
                }
            }
        });
    }

    public static MainActivity getInstance() {
        return instance;
    }

    public void onMediaAction(final String action, final long seekMs) {
        if (webView != null) {
            webView.post(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) {
                        webView.evaluateJavascript("window.__mintpyNativeMediaAction&&window.__mintpyNativeMediaAction(" + JSONObject.quote(action) + "," + seekMs + ")", null);
                    }
                }
            });
        }
    }

    public void onNativeAudioEvent(final String event, final long posMs, final long durMs, final boolean playing) {
        if (webView != null) {
            webView.post(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) {
                        webView.evaluateJavascript(
                            "window.__mintpyNativeAudioEvent&&window.__mintpyNativeAudioEvent("
                            + JSONObject.quote(event) + "," + posMs + "," + durMs + "," + (playing ? "true" : "false") + ")",
                            null
                        );
                    }
                }
            });
        }
    }

    static {
        System.setProperty("http.keepAlive", "true");
        System.setProperty("http.maxConnections", "16");
    }

    private String executeHttp(String method, String urlStr, String body, String headersJson) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
            conn.setRequestProperty("Accept-Encoding", "gzip");
            if ("POST".equalsIgnoreCase(method)) {
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("Accept", "application/json");
            }
            if (headersJson != null && !headersJson.isEmpty()) {
                try {
                    JSONObject headers = new JSONObject(headersJson);
                    java.util.Iterator<String> keys = headers.keys();
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
                        asyncResults.put(reqId, data);
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
            return reqId == null ? null : asyncResults.remove(reqId);
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
                    asyncResults.put(reqId, String.valueOf(code));
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
        public String postJson(String urlStr, String jsonBody) {
            return postJsonWithHeaders(urlStr, jsonBody, null);
        }

        @android.webkit.JavascriptInterface
        public String postJsonWithHeaders(String urlStr, String jsonBody, String headersJson) {
            try {
                return executeHttp("POST", urlStr, jsonBody, headersJson);
            } catch (Exception e) {
                return null;
            }
        }

        @android.webkit.JavascriptInterface
        public String getUrl(String urlStr) {
            return getUrlWithHeaders(urlStr, null);
        }

        @android.webkit.JavascriptInterface
        public String getUrlWithHeaders(String urlStr, String headersJson) {
            try {
                return executeHttp("GET", urlStr, null, headersJson);
            } catch (Exception e) {
                return null;
            }
        }

        @android.webkit.JavascriptInterface
        public int probeStreamUrl(String urlStr, String userAgent) {
            return executeProbe(urlStr, userAgent);
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
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_PLAY_URL);
                intent.putExtra("streamUrl", url);
                intent.putExtra("title", title);
                intent.putExtra("artist", artist);
                intent.putExtra("album", album);
                intent.putExtra("artworkUrl", artworkUrl);
                intent.putExtra("durationMs", (long) (durationSec * 1000.0));
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeResume() {
            try {
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_PLAY);
                startService(intent);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativePause() {
            try {
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_PAUSE);
                startService(intent);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSeekTo(double positionSec) {
            try {
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_SEEK);
                intent.putExtra("positionMs", (long) (Math.max(0.0, positionSec) * 1000.0));
                startService(intent);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeStopPlayer() {
            try {
                PlaybackService.stopPlayerOnly();
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSetEq(int lowDb, int midDb, int highDb) {
            try {
                PlaybackService.setEqLevels(lowDb, midDb, highDb);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void nativeSetPlaybackSpeed(float speed) {
            try {
                PlaybackService.setPlaybackSpeed(speed);
            } catch (Exception ignored) {}
        }

        @android.webkit.JavascriptInterface
        public void setLightStatusBar(final boolean isLight) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
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
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void updateNativeMediaSession(String title, String artist, String album, String artworkUrl, double durationSec, boolean isPlaying, double positionSec) {
            try {
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_UPDATE);
                intent.putExtra("title", title);
                intent.putExtra("artist", artist);
                intent.putExtra("album", album);
                intent.putExtra("artworkUrl", artworkUrl);
                intent.putExtra("durationMs", (long) (durationSec * 1000));
                intent.putExtra("positionMs", (long) (positionSec * 1000));
                intent.putExtra("isPlaying", isPlaying);
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception ignored) {
            }
        }

        @android.webkit.JavascriptInterface
        public void stopNativeMediaSession() {
            try {
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlaybackService.class);
                intent.setAction(PlaybackService.ACTION_STOP);
                startService(intent);
            } catch (Exception ignored) {
            }
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

        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public android.view.WindowInsets onApplyWindowInsets(View v, android.view.WindowInsets insets) {
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
            }
        });
        root.requestApplyInsets();

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
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
        if (instance == this) {
            instance = null;
        }
        networkPool.shutdownNow();
        asyncResults.clear();
        super.onDestroy();
    }
}
''')

    # 5. Copy web assets to build_android/assets (src + assets)
    assets_dest = os.path.join(build_dir, "assets")
    os.makedirs(assets_dest, exist_ok=True)
    shutil.copytree(os.path.join(base_dir, "src_mobile"), os.path.join(assets_dest, "src"))
    mobile_assets_dir = os.path.join(assets_dest, "assets")
    os.makedirs(os.path.join(mobile_assets_dir, "themes"), exist_ok=True)
    shutil.copy2(os.path.join(base_dir, "assets", "mintpy-logo.png"), os.path.join(mobile_assets_dir, "mintpy-logo.png"))
    shutil.copytree(os.path.join(base_dir, "assets", "themes", "mobile"), os.path.join(mobile_assets_dir, "themes", "mobile"),
                    ignore=shutil.ignore_patterns("test-*"))

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
    service_java = os.path.join(src_dir, "PlaybackService.java")
    proxy_java = os.path.join(src_dir, "LocalAudioProxy.java")
    cmd_javac = [
        javac,
        "-encoding", "UTF-8",
        "-cp", android_jar,
        "-d", obj_dir,
        r_java, main_java, service_java, proxy_java
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
    aligned_apk = os.path.join(releases_dir, "MintPy-v5.4.6.apk")
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

    # Clean up old APK artifacts only after the new APK is verified
    target_apk_lower = os.path.basename(aligned_apk).lower()
    for name in os.listdir(releases_dir):
        lower = name.lower()
        if (lower.endswith(".apk") or lower.endswith(".apk.idsig")) and lower != target_apk_lower:
            old_path = os.path.join(releases_dir, name)
            try:
                if os.path.isfile(old_path):
                    os.remove(old_path)
                    print(f"Removed old APK artifact: {name}")
            except Exception as cleanup_err:
                print(f"Warning: could not remove {name}: {cleanup_err}")

    if os.path.exists(build_dir):
        shutil.rmtree(build_dir, ignore_errors=True)

    apk_size_mb = os.path.getsize(aligned_apk) / (1024 * 1024)
    print(f"\nSUCCESS! MintPy Android APK built and signed:\n  -> {aligned_apk} ({apk_size_mb:.2f} MB)")

if __name__ == "__main__":
    main()

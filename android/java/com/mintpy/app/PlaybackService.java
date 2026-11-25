package com.mintpy.app;

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
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

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
    private static volatile float userVolume = 1.0f;

    private final Map<String, Bitmap> artworkCache = Collections.synchronizedMap(
        new LinkedHashMap<String, Bitmap>(12, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Bitmap> eldest) {
                return size() > 8;
            }
        }
    );

    private MediaSession mediaSession;
    private MediaPlayer mediaPlayer;
    private Equalizer equalizer;
    private boolean isPrepared = false;
    private boolean playWhenPrepared = false;
    private boolean isDucked = false;
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

    private final AudioManager.OnAudioFocusChangeListener focusListener = focusChange -> {
        if (mediaPlayer == null) return;
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            isDucked = false;
            if (isPlaying || playWhenPrepared) {
                pauseNativeInternal(true);
            }
        } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            isDucked = true;
            applyEffectiveVolume();
        } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
            isDucked = false;
            applyEffectiveVolume();
        }
    };

    private void applyEffectiveVolume() {
        try {
            if (mediaPlayer != null && isPrepared) {
                float eff = Math.max(0.0f, Math.min(1.0f, userVolume * (isDucked ? 0.25f : 1.0f)));
                mediaPlayer.setVolume(eff, eff);
            }
        } catch (Exception ignored) {}
    }

    public static void setVolumeLevel(float vol) {
        userVolume = Math.max(0.0f, Math.min(1.0f, vol));
        final PlaybackService svc = activeInstance;
        if (svc != null) {
            svc.progressHandler.post(svc::applyEffectiveVolume);
        }
    }

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
            svc.progressHandler.post(svc::applyEqualizerBands);
        }
    }

    public static void setPlaybackSpeed(float speed) {
        playbackSpeed = Math.max(0.5f, Math.min(2.0f, speed));
        final PlaybackService svc = activeInstance;
        if (svc != null) {
            svc.progressHandler.post(() -> {
                svc.applyPlaybackSpeed();
                svc.updatePlaybackState();
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
            public void onPlay() { resumeNativeInternal(true); }

            @Override
            public void onPause() { pauseNativeInternal(true); }

            @Override
            public void onSkipToNext() { notifyJsAction("next", 0L); }

            @Override
            public void onSkipToPrevious() { notifyJsAction("prev", 0L); }

            @Override
            public void onSeekTo(long pos) { seekNativeInternal(pos, true); }

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
                if (isPlaying) pauseNativeInternal(true);
                else resumeNativeInternal(true);
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
        isDucked = false;

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
            mp.setOnPreparedListener(player -> {
                if (player != mediaPlayer) return;
                isPrepared = true;
                try {
                    int mpDur = player.getDuration();
                    if (mpDur > 0) durationMs = mpDur;
                } catch (Exception ignored) {}
                try { setupEqualizer(player.getAudioSessionId()); } catch (Throwable ignored) {}
                applyEffectiveVolume();
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
            });
            mp.setOnCompletionListener(player -> {
                if (player != mediaPlayer) return;
                isPlaying = false;
                playWhenPrepared = false;
                updateWakeLock(false);
                stopProgressTicker();
                positionMs = durationMs;
                updatePlaybackState();
                updateNotification();
                notifyJsAudioEvent("ended", durationMs, durationMs, false);
            });
            mp.setOnErrorListener((player, what, extra) -> {
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
            applyEffectiveVolume();
            try {
                if (!mediaPlayer.isPlaying()) mediaPlayer.start();
                positionMs = Math.max(0L, mediaPlayer.getCurrentPosition());
            } catch (Exception ignored) {}
            isPlaying = true;
            applyPlaybackSpeed();
            updateWakeLock(true);
            updatePlaybackState();
            updateNotification();
            startProgressTicker();
            if (notifyJs) notifyJsAudioEvent("play", positionMs, durationMs, true);
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
            if (notifyJs) notifyJsAction("play", 0L);
        }
    }

    private void pauseNativeInternal(boolean notifyJs) {
        playWhenPrepared = false;
        if (mediaPlayer != null) {
            if (isPrepared) {
                try {
                    if (mediaPlayer.isPlaying()) mediaPlayer.pause();
                    positionMs = Math.max(0L, mediaPlayer.getCurrentPosition());
                } catch (Exception ignored) {}
            }
            isPlaying = false;
            updateWakeLock(false);
            stopProgressTicker();
            updatePlaybackState();
            updateNotification();
            if (notifyJs) notifyJsAudioEvent("pause", positionMs, durationMs, false);
        } else {
            isPlaying = false;
            updateWakeLock(false);
            stopProgressTicker();
            updatePlaybackState();
            updateNotification();
            if (notifyJs) notifyJsAction("pause", 0L);
        }
    }

    private void seekNativeInternal(long posMs, boolean notifyJs) {
        positionMs = Math.max(0L, posMs);
        if (mediaPlayer != null && isPrepared) {
            try {
                if (durationMs > 0 && positionMs > durationMs) positionMs = durationMs;
                mediaPlayer.seekTo((int) positionMs);
            } catch (Exception ignored) {}
            updatePlaybackState();
            if (notifyJs) notifyJsAudioEvent("timeupdate", positionMs, durationMs, isPlaying);
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
            Thread t = new Thread(() -> {
                if (eq != null) {
                    try { eq.release(); } catch (Throwable ignored) {}
                }
                if (mp != null) {
                    try { if (mp.isPlaying()) mp.stop(); } catch (Exception ignored) {}
                    try { mp.reset(); } catch (Exception ignored) {}
                    try { mp.release(); } catch (Exception ignored) {}
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
                Bitmap cached = artworkCache.get(artworkUrl);
                if (cached != null) {
                    currentBitmap = cached;
                    updateMetadata();
                    updateNotification();
                } else {
                    fetchArtworkAsync(artworkUrl);
                }
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
        if (activity != null) activity.onMediaAction(action, seekMs);
    }

    private void notifyJsAudioEvent(String event, long posMs, long durMs, boolean playing) {
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) activity.onNativeAudioEvent(event, posMs, durMs, playing);
    }

    private void fetchArtworkAsync(final String urlStr) {
        Thread artThread = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setDoInput(true);
                conn.connect();
                if (conn.getResponseCode() == 200) {
                    try (InputStream is = conn.getInputStream()) {
                        final Bitmap bmp = BitmapFactory.decodeStream(is);
                        if (bmp != null) {
                            artworkCache.put(urlStr, bmp);
                            if (urlStr.equals(currentArtworkUrl)) {
                                currentBitmap = bmp;
                                updateMetadata();
                                updateNotification();
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "MintPy-Artwork");
        artThread.setDaemon(true);
        artThread.start();
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

        if (currentBitmap != null) builder.setLargeIcon(currentBitmap);
        return builder.build();
    }

    private void updateNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
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
            if (nm != null) nm.createNotificationChannel(channel);
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
        if (activeInstance == this) activeInstance = null;
        if (noisyRegistered && noisyReceiver != null) {
            try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
            noisyRegistered = false;
        }
        releasePlayer();
        abandonAudioFocus();
        updateWakeLock(false);
        artworkCache.clear();
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

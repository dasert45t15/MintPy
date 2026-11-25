package com.mintpy.app;

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
            Thread acceptThread = new Thread(() -> {
                while (!ss.isClosed()) {
                    try {
                        final Socket client = ss.accept();
                        clientPool.execute(() -> handleClient(client));
                    } catch (IOException e) {
                        if (ss.isClosed()) break;
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
                conn.setConnectTimeout(12000);
                conn.setReadTimeout(20000);
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

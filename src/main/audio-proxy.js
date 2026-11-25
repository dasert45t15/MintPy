const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { findBestYouTubeTrack } = require('./smart-resolver');

function createAudioProxy({ allowedLocalFiles, ytDlp }) {
  // Create local HTTP proxy server to stream audio.
  // Protected by a per-session token and an Origin check, bound to 127.0.0.1 only.
  const PROXY_TOKEN = crypto.randomBytes(24).toString('hex');
  
  const ytUrlCache = new Map();
  const ytInFlight = new Map();
  // Fallback chain: YouTube bot-detection and format restrictions make single-format
  // extraction unreliable, so we retry with progressively different formats and clients.
  const YT_RESOLVE_ATTEMPTS = [
    { args: ['-f', 'bestaudio[ext=m4a]/bestaudio'] },
    { args: ['-f', 'bestaudio/best'] },
    { args: ['--extractor-args', 'youtube:player_client=tv,android', '-f', 'bestaudio/best'] },
  ];

  function invalidateYtCache(videoId) {
    const key = String(videoId || '');
    ytUrlCache.delete(key);
    if (key.startsWith('yt:')) ytUrlCache.delete(key.slice(3));
  }

  async function resolveYtStream(videoId, forceFresh = false) {
    const key = String(videoId);
    if (!forceFresh) {
      const cached = ytUrlCache.get(key);
      const now = Date.now();
      if (cached && now - cached.time < 1500000) {
        if (cached.stream) return cached.stream;
        if (now - cached.time < 5000) return null; // 5s transient backoff only
      }
    }

    if (ytInFlight.has(key)) return ytInFlight.get(key);

    const task = (async () => {
      const now = Date.now();
      let realVideoId = key.startsWith('yt:') ? key.slice(3) : key;
      if (realVideoId.startsWith('ytsearch:')) {
        let rawQuery = realVideoId.slice(9);
        try { rawQuery = decodeURIComponent(rawQuery); } catch {}
        try {
          console.log(`Smart resolving YouTube search: "${rawQuery}"`);
          const best = await findBestYouTubeTrack(ytDlp, '', rawQuery, 0);
          if (best && best.id) {
            realVideoId = best.id.startsWith('yt:') ? best.id.slice(3) : best.id;
            console.log(`Smart resolved "${rawQuery}" -> ${realVideoId}`);
          }
        } catch (err) {
          console.warn('Smart search resolution failed, falling back:', err.message);
        }
      }

      let target;
      if (realVideoId.startsWith('ytsearch:')) {
        let q = realVideoId.slice(9);
        try { q = decodeURIComponent(q); } catch {}
        target = `ytsearch1:${q}`;
      } else {
        target = `https://www.youtube.com/watch?v=${realVideoId}`;
      }

      const storeStream = (stream) => {
        const entry = { stream, time: Date.now() };
        ytUrlCache.set(key, entry);
        if (realVideoId !== key) ytUrlCache.set(realVideoId, entry);
        return stream;
      };

      // Primary on Desktop: yt-dlp handles signature decryption & avoids unauthenticated IOS/ANDROID 403s
      let lastErr = null;
      for (const attempt of YT_RESOLVE_ATTEMPTS) {
        try {
          const out = await ytDlp(['--no-warnings', '--no-playlist', '-j', ...attempt.args, target], 20000);
          const jsonLine = out.trim().split('\n').find(l => l.trim().startsWith('{'));
          if (jsonLine) {
            const parsed = JSON.parse(jsonLine);
            if (parsed?.url) {
              return storeStream({
                url: parsed.url,
                userAgent: parsed.http_headers?.['User-Agent'] || '',
              });
            }
          }
        } catch (e) {
          lastErr = e;
          console.warn(`yt-dlp resolve failed (${attempt.args.join(' ')}):`, e.message);
        }
      }

      // Last-resort direct Innertube fallback only if yt-dlp binary failed completely
      if (!realVideoId.startsWith('ytsearch:')) {
        const clients = [
          {
            ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
            headers: {
              'Content-Type': 'application/json',
              'X-Youtube-Client-Name': '5',
              'X-Youtube-Client-Version': '20.10.4'
            },
            body: {
              context: { client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US' } },
              videoId: realVideoId
            }
          },
          {
            ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
            headers: {
              'Content-Type': 'application/json',
              'X-Youtube-Client-Name': '3',
              'X-Youtube-Client-Version': '20.10.38'
            },
            body: {
              context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, osName: 'Android', osVersion: '14', hl: 'en', gl: 'US' } },
              videoId: realVideoId
            }
          }
        ];
        for (const c of clients) {
          try {
            const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
              method: 'POST', headers: { ...c.headers, 'User-Agent': c.ua }, body: JSON.stringify(c.body), signal: AbortSignal.timeout(6000)
            });
            if (!resp.ok) continue;
            const j = await resp.json();
            const fmts = (j?.streamingData?.adaptiveFormats || []).filter(f => (f.mimeType || '').startsWith('audio/') && f.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            const best = fmts.find(f => (f.mimeType || '').includes('audio/mp4')) || fmts[0];
            if (best?.url) return storeStream({ url: best.url, userAgent: c.ua });
          } catch {}
        }
      }

      ytUrlCache.set(key, { stream: null, time: now });
      if (lastErr) throw lastErr;
      return null;
    })();

    ytInFlight.set(key, task);
    try {
      return await task;
    } finally {
      ytInFlight.delete(key);
    }
  }
  
  function originAllowed(req) {
    const o = req.headers.origin;
    // Renderer pages loaded from file:// send no Origin or "null" for cross-origin media requests.
    if (!o || o === 'null') return true;
    try {
      const u = new URL(o);
      return u.port === String(proxyPort) && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    } catch { return false; }
  }
  
  const HOP_BY_HOP_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
  ]);
  
  const proxyServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
  
    if (!originAllowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (url.searchParams.get('t') !== PROXY_TOKEN) { res.writeHead(403); res.end('Forbidden'); return; }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
    // Route: /local?path=<filepath> - serve local files
    if (url.pathname === '/local') {
      const filePath = url.searchParams.get('path');
      if (!filePath) { res.writeHead(400); res.end('Missing path'); return; }
      const resolvedFile = path.resolve(filePath);
      const isAllowed = allowedLocalFiles.has(resolvedFile);
      if (!isAllowed) { res.writeHead(403); res.end('Path is outside the selected library'); return; }
      console.log('Serving local file:', resolvedFile);
      try {
        const stat = fs.statSync(resolvedFile);
        const total = stat.size;
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };
        const contentType = mime[ext] || 'audio/mpeg';
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
          if (isNaN(start) || isNaN(end) || start >= total || start > end) { res.writeHead(416); res.end(); return; }
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
          });
          fs.createReadStream(resolvedFile, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
          });
          fs.createReadStream(resolvedFile).pipe(res);
        }
      } catch (e) { console.error('Local proxy error:', e.message); res.writeHead(404); res.end('File not found'); }
      return;
    }
  
    // Route: /youtube?v=<video-id> - stream from YouTube via direct URL proxy (supports seeking)
    if (url.pathname === '/youtube') {
      const videoId = url.searchParams.get('v');
      const isSearch = videoId && videoId.startsWith('ytsearch:');
      if (!videoId || (!isSearch && !/^[A-Za-z0-9_-]{6,20}$/.test(videoId))) { res.writeHead(400); res.end('Missing or invalid video id'); return; }
      console.log('YouTube stream for video:', videoId);

      const pipeUpstream = (stream, attempt) => {
        const isHttps = stream.url.startsWith('https');
        const proxyMod = isHttps ? https : http;
        const dst = new URL(stream.url);
        const headers = {
          'User-Agent': stream.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
        };
        if (req.headers.range) headers.Range = req.headers.range;
        const proxyReq = proxyMod.request({
          hostname: dst.hostname,
          port: dst.port,
          path: dst.pathname + dst.search,
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers,
        }, async proxyRes => {
          const st = proxyRes.statusCode || 200;
          if ((st === 403 || st === 410 || st >= 500) && attempt === 0 && !res.destroyed) {
            proxyRes.resume();
            invalidateYtCache(videoId);
            try {
              const fresh = await resolveYtStream(videoId, true);
              if (fresh && !res.destroyed) return pipeUpstream(fresh, 1);
            } catch (err) {
              console.error('YouTube retry resolve failed:', err.message);
            }
            if (!res.headersSent && !res.destroyed) { res.writeHead(st >= 400 ? st : 502); res.end('Stream upstream error'); }
            return;
          }
          const outHeaders = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
          }
          if (!outHeaders['accept-ranges']) outHeaders['accept-ranges'] = 'bytes';
          outHeaders['Access-Control-Allow-Origin'] = '*';
          outHeaders['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
          outHeaders['Access-Control-Allow-Headers'] = 'Range, Content-Type';
          outHeaders['Access-Control-Expose-Headers'] = 'Accept-Ranges, Content-Length, Content-Range';
          res.writeHead(st, outHeaders);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', e => {
          console.error('YouTube proxy error:', e.message);
          invalidateYtCache(videoId);
          if (!res.headersSent) { res.writeHead(502); res.end('Stream error'); } else res.destroy();
        });
        proxyReq.end();
        req.on('close', () => proxyReq.destroy());
      };

      try {
        const stream = await resolveYtStream(videoId);
        if (!stream) { res.writeHead(502); res.end('No URL resolved'); return; }
        pipeUpstream(stream, 0);
      } catch (e) {
        console.error('YouTube stream error:', e.message);
        if (!res.headersSent) { res.writeHead(502); res.end('Stream failed'); }
      }
      return;
    }
  
    res.writeHead(404);
    res.end('Not found');
  });
  
  let proxyPort = 3737;
  const PROXY_PORTS = [3737, 3738, 3739, 3740];
  
  function startProxy() {
    const tryListen = (i) => {
      if (i >= PROXY_PORTS.length) {
        console.error('No free port available for audio proxy');
        return;
      }
      proxyPort = PROXY_PORTS[i];
      proxyServer.listen(proxyPort, '127.0.0.1', () => {
        console.log('Audio proxy server running on http://localhost:' + proxyPort);
      });
    };
    proxyServer.on('error', e => {
      if (e.code === 'EADDRINUSE') {
        console.warn('Port ' + proxyPort + ' in use, trying next...');
        tryListen(PROXY_PORTS.indexOf(proxyPort) + 1);
      } else {
        console.error('Proxy server error:', e.message);
      }
    });
    tryListen(0);
  }

  return { start: startProxy, getStreamInfo: () => ({ base: 'http://127.0.0.1:' + proxyPort, token: PROXY_TOKEN }) };
}

module.exports = { createAudioProxy };

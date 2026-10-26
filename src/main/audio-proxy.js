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
  // Fallback chain: YouTube bot-detection and format restrictions make single-format
  // extraction unreliable, so we retry with progressively different formats and clients.
  const YT_RESOLVE_ATTEMPTS = [
    { args: ['-f', 'bestaudio[ext=m4a]/bestaudio'] },
    { args: ['-f', 'bestaudio'] },
    { args: ['--extractor-args', 'youtube:player_client=android', '-f', 'bestaudio/best'] },
    { args: ['--extractor-args', 'youtube:player_client=ios', '-f', 'bestaudio/best'] },
    { args: ['--extractor-args', 'youtube:player_client=tv', '-f', 'bestaudio/best'] },
  ];

  async function resolveYtUrl(videoId) {
    const key = String(videoId);
    const cached = ytUrlCache.get(key);
    const now = Date.now();
    if (cached && now - cached.time < 1800000) {
      if (cached.url) return cached.url;
      if (now - cached.time < 5000) return null; // 5s transient backoff only
    }

    let realVideoId = key;
    if (key.startsWith('ytsearch:')) {
      let rawQuery = key.slice(9);
      try { rawQuery = decodeURIComponent(rawQuery); } catch {}
      try {
        console.log(`Smart resolving YouTube search: "${rawQuery}"`);
        const best = await findBestYouTubeTrack(ytDlp, '', rawQuery, 0);
        if (best && best.id) {
          realVideoId = best.id;
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

    let lastErr = null;
    for (const attempt of YT_RESOLVE_ATTEMPTS) {
      try {
        const out = await ytDlp(['-g', ...attempt.args, target], 20000);
        const url = out.split('\n')[0];
        if (url) {
          ytUrlCache.set(key, { url, time: now });
          if (realVideoId !== key) {
            ytUrlCache.set(realVideoId, { url, time: now });
          }
          return url;
        }
      } catch (e) {
        lastErr = e;
        console.warn(`yt-dlp resolve failed (${attempt.args.join(' ')}):`, e.message);
      }
    }
    ytUrlCache.set(key, { url: null, time: now });
    if (lastErr) throw lastErr;
    return null;
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
      try {
        const directUrl = await resolveYtUrl(videoId);
        if (!directUrl) { res.writeHead(502); res.end('No URL resolved'); return; }
        const isHttps = directUrl.startsWith('https');
        const proxyMod = isHttps ? https : http;
        const dst = new URL(directUrl);
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
        };
        if (req.headers.range) headers.Range = req.headers.range;
        const proxyReq = proxyMod.request({
          hostname: dst.hostname,
          port: dst.port,
          path: dst.pathname + dst.search,
          headers,
        }, proxyRes => {
          const outHeaders = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
          }
          outHeaders['Access-Control-Allow-Origin'] = '*';
          outHeaders['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
          outHeaders['Access-Control-Allow-Headers'] = 'Range, Content-Type';
          outHeaders['Access-Control-Expose-Headers'] = 'Accept-Ranges, Content-Length, Content-Range';
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', e => {
          console.error('YouTube proxy error:', e.message);
          ytUrlCache.delete(videoId);
          if (!res.headersSent) { res.writeHead(502); res.end('Stream error'); } else res.destroy();
        });
        proxyReq.end();
        req.on('close', () => proxyReq.destroy());
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

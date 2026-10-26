const { BrowserWindow } = require('electron');

async function importFromUrl(url, ytDlp) {
  url = String(url || '').trim();
  if (!url) throw new Error('URL cannot be empty');

  // Normalize URL
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // 1. Spotify
  if (url.includes('spotify.com')) {
    return await importSpotify(url);
  }

  // 2. YouTube / YouTube Music
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return await importYouTube(url, ytDlp);
  }

  // 3. Yandex Music
  if (url.includes('music.yandex.')) {
    return await importYandexMusic(url);
  }

  // 4. Generic / Other supported URLs via yt-dlp
  return await importYouTube(url, ytDlp);
}

async function importSpotify(url) {
  const embedUrl = url.replace('open.spotify.com/', 'open.spotify.com/embed/');
  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error('Spotify playlist could not be fetched (HTTP ' + res.status + ')');
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not parse Spotify playlist structure');

  const data = JSON.parse(match[1]);
  const entity = data.props?.pageProps?.state?.data?.entity;
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new Error('No tracks found in Spotify playlist');
  }

  const title = (entity.name || 'Spotify Playlist').trim();
  const tracks = entity.trackList.map(t => {
    const artist = t.subtitle || 'Unknown';
    const trackTitle = t.title || 'Unknown';
    return {
      id: 'yt:ytsearch:' + encodeURIComponent(`${artist} - ${trackTitle}`),
      title: trackTitle,
      artist: artist,
      album: '',
      artwork: '',
      duration: Math.round((Number(t.duration) || 0) / 1000),
      source: 'youtube'
    };
  }).filter(t => t.title && t.title !== 'Unknown' && t.artist !== 'Unknown');

  return { name: `Spotify: ${title}`, tracks };
}

async function importYouTube(url, ytDlp) {
  if (typeof ytDlp !== 'function') throw new Error('yt-dlp is not available');
  const jsonStr = await ytDlp(['--flat-playlist', '--dump-single-json', url], 45000);
  const data = JSON.parse(jsonStr);
  const title = (data.title || 'YouTube Playlist').trim();
  const entries = Array.isArray(data.entries) ? data.entries : [data];

  const tracks = entries.filter(e => e && e.id).map(e => ({
    id: 'yt:' + e.id,
    title: (e.title || 'Unknown').trim(),
    artist: (e.uploader || e.channel || 'YouTube').trim(),
    album: '',
    artwork: e.thumbnails?.[0]?.url || '',
    duration: Number(e.duration) || 0,
    source: 'youtube'
  })).filter(t => t.title && t.title !== '[Private video]' && t.title !== '[Deleted video]');

  return { name: `YouTube: ${title}`, tracks };
}

async function importYandexMusic(url) {
  return new Promise((resolve, reject) => {
    let win = null;
    let resolved = false;

    // Timer for large playlists (up to 720+ tracks)
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} }
        reject(new Error('Yandex Music loading timed out. Make sure the playlist or album is public.'));
      }
    }, 90000);

    try {
      win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 1200,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

      win.webContents.on('did-finish-load', async () => {
        // Wait 2.5s for initial hydration
        await new Promise(r => setTimeout(r, 2500));
        if (resolved || !win || win.isDestroyed()) return;

        try {
          const result = await win.webContents.executeJavaScript(`
            (async () => {
              let title = '';
              let totalExpected = 0;
              const allTracksMap = new Map();
              const orderedList = [];

              function addTrack(tTitle, tArtist, durationSec, artwork, album) {
                if (!tTitle) return;
                tTitle = String(tTitle).trim();
                tArtist = String(tArtist || '').trim();
                if (!tTitle || tTitle.length < 1 || !tArtist || tArtist.toLowerCase() === 'unknown') return;

                const key = (tArtist + ' - ' + tTitle).toLowerCase();
                const existing = allTracksMap.get(key);
                if (!existing) {
                  const item = {
                    title: tTitle,
                    artist: tArtist,
                    duration: Number(durationSec) || 0,
                    artwork: artwork || '',
                    album: album || ''
                  };
                  allTracksMap.set(key, item);
                  orderedList.push(item);
                } else {
                  if (!existing.duration && durationSec) existing.duration = Number(durationSec);
                  if (!existing.artwork && artwork) existing.artwork = artwork;
                  if (!existing.album && album) existing.album = album;
                }
              }

              function collectPatches(patchesArray) {
                if (!Array.isArray(patchesArray)) return;
                for (const p of patchesArray) {
                  if (p.path && (p.path.endsWith('/title') || p.path === '/playlist/title' || p.path === '/album/title')) {
                    if (typeof p.value === 'string' && p.value.trim() && !title) {
                      title = p.value.trim();
                    }
                  }
                  if (p.path && (p.path.endsWith('/meta') || p.path === '/playlist/meta' || p.path === '/album/meta')) {
                    if (p.value && typeof p.value.tracksCount === 'number') {
                      totalExpected = Math.max(totalExpected, p.value.tracksCount);
                    }
                    if (p.value && p.value.title && !title) {
                      title = String(p.value.title).trim();
                    }
                  }
                  if (p.path && (p.path.includes('/trackCount') || p.path.includes('/tracksCount'))) {
                    const n = parseInt(p.value, 10);
                    if (!isNaN(n)) totalExpected = Math.max(totalExpected, n);
                  }
                  if (p.path && (p.path.includes('/playlist/items/') || p.path.includes('/album/items/') || p.path.includes('/playlist/initialItems/') || p.path.includes('/album/volumes/'))) {
                    const d = p.value?.data || p.value;
                    if (d && d.title) {
                      const artists = Array.isArray(d.artists) ? d.artists.map(a => a?.name || a).filter(Boolean) : (d.artist ? [d.artist] : []);
                      const dur = Math.round((Number(d.durationMs) || 0) / 1000);
                      const cov = d.coverUri ? ('https://' + String(d.coverUri).replace('%%', '400x400')) : '';
                      addTrack(d.title, artists.join(', '), dur, cov, d.albums?.[0]?.title);
                    }
                  }
                }
              }

              function collectDom() {
                // Query modern Meta_root, Track_root, TrackItem, and classic d-track
                const roots = document.querySelectorAll('[class*="Meta_root"], [class*="Track_root"], [class*="TrackItem"], .d-track');
                roots.forEach(root => {
                  const titleEl = root.querySelector('[class*="Meta_title"], .d-track__title, [class*="Track_title"], [class*="TrackTitle"]');
                  const artistEl = root.querySelector('[class*="Meta_artists"], [class*="SeparatedArtists"], .d-track__artists, [class*="Track_artists"]');
                  const tTitle = titleEl?.innerText?.trim();
                  const tArtist = artistEl?.innerText?.trim();
                  if (tTitle && tArtist) {
                    addTrack(tTitle, tArtist, 0);
                  }
                });
              }

              function scrollAllContainers(px = 1000) {
                // Scroll window and document
                window.scrollBy(0, px);
                if (document.scrollingElement) document.scrollingElement.scrollTop += px;
                if (document.documentElement) document.documentElement.scrollTop += px;
                if (document.body) document.body.scrollTop += px;

                // Scroll the actual VirtualScroll_scroller or any scrollable container
                const scrollables = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 40);
                scrollables.forEach(el => {
                  el.scrollTop += px;
                  el.dispatchEvent(new Event('scroll', { bubbles: true }));
                });
              }

              // 1. Initial collection from script tags
              const scripts = Array.from(document.querySelectorAll('script'));
              for (const s of scripts) {
                const text = s.textContent || '';
                if (!text.includes('STATE_PATCHES')) continue;
                const pushMatches = [...text.matchAll(/push\\((\\[[\\s\\S]*?\\])\\)/g)];
                for (const pm of pushMatches) {
                  try { collectPatches(JSON.parse(pm[1])); } catch {}
                }
              }

              // 2. Initial collection from visible DOM
              collectDom();

              // 3. Collection from runtime __STATE_PATCHES__
              if (Array.isArray(window.__STATE_PATCHES__)) {
                for (const ps of window.__STATE_PATCHES__) {
                  if (Array.isArray(ps)) collectPatches(ps);
                }
              }

              // 4. Progressive scrolling loop: scrolls VirtualScroll_scroller to reveal every track
              let lastCount = orderedList.length;
              let stagnantRounds = 0;
              const maxScrolls = 120; // allows up to 1500+ tracks!

              for (let r = 0; r < maxScrolls; r++) {
                if (totalExpected > 0 && orderedList.length >= totalExpected) break;

                // Scroll down
                scrollAllContainers(1000);
                await new Promise(res => setTimeout(res, 220));

                collectDom();
                if (Array.isArray(window.__STATE_PATCHES__)) {
                  for (const ps of window.__STATE_PATCHES__) {
                    if (Array.isArray(ps)) collectPatches(ps);
                  }
                }

                if (orderedList.length > lastCount) {
                  lastCount = orderedList.length;
                  stagnantRounds = 0;
                } else {
                  stagnantRounds++;
                  if (stagnantRounds >= 6) {
                    // Try jumping to the very end
                    scrollAllContainers(5000);
                    await new Promise(res => setTimeout(res, 350));
                    collectDom();
                    if (orderedList.length <= lastCount) break;
                    lastCount = orderedList.length;
                    stagnantRounds = 0;
                  }
                }
              }

              // Scroll back to top
              if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
              window.scrollTo(0, 0);

              if (!title) {
                title = document.querySelector('h1')?.innerText?.trim() || document.title;
              }
              title = title.replace(/^Плейлист\\s*/i, '').replace(/^Альбом\\s*/i, '').trim();

              return { title, tracks: orderedList };
            })()
          `);

          resolved = true;
          clearTimeout(timer);
          if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} }

          if (!result || !result.tracks || result.tracks.length === 0) {
            reject(new Error('No tracks found on this Yandex Music page. Make sure the playlist or album is public.'));
            return;
          }

          const tracks = result.tracks.map(t => ({
            id: 'yt:ytsearch:' + encodeURIComponent(`${t.artist} - ${t.title}`),
            title: t.title,
            artist: t.artist,
            album: t.album || '',
            artwork: t.artwork || '',
            duration: Number(t.duration) || 0,
            source: 'youtube'
          }));

          resolve({ name: `Яндекс: ${result.title}`, tracks });
        } catch (err) {
          resolved = true;
          clearTimeout(timer);
          if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} }
          reject(err);
        }
      });

      win.loadURL(url).catch(err => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} }
          reject(err);
        }
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} }
        reject(err);
      }
    }
  });
}

module.exports = { importFromUrl };

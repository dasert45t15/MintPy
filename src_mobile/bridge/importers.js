// ============================================================================
// MintPy Mobile Playlist Importers (Spotify, YouTube / YT Music, Yandex Music)
// ============================================================================
(function () {
  'use strict';

  const U = window.MintPyUtils || {};

  function createPlaylistImporter(net) {
    async function importSpotify(route) {
      const html = await net.getUrl(route.embedUrl, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      });
      if (!html) throw new Error('Не удалось загрузить данные Spotify');

      let entity = null;
      const idx = html.indexOf('__NEXT_DATA__');
      if (idx !== -1) {
        const start = html.indexOf('>', idx) + 1;
        const end = html.indexOf('</script>', start);
        if (end > start) {
          try {
            const json = JSON.parse(html.slice(start, end));
            entity = json.props?.pageProps?.state?.data?.entity;
          } catch {}
        }
      }

      if (!entity || !Array.isArray(entity.trackList)) {
        throw new Error('Не удалось найти треки в плейлисте Spotify. Убедитесь, что плейлист публичный.');
      }

      const title = (entity.name || 'Spotify Playlist').trim();
      const tracks = entity.trackList.map((t) => {
        const artist = t.subtitle || 'Unknown Artist';
        const trackTitle = t.title || 'Unknown Title';
        return {
          id: 'yt:ytsearch:' + encodeURIComponent(`${artist} - ${trackTitle}`),
          title: trackTitle,
          artist,
          album: '',
          artwork: '',
          duration: Math.round((Number(t.duration) || 0) / 1000),
          source: 'youtube'
        };
      }).filter((t) => t.title && t.title !== 'Unknown Title');

      return { name: `Spotify: ${title}`, tracks };
    }

    async function importYouTube(route) {
      if (!route.listId) {
        if (route.videoId) {
          return {
            name: 'YouTube Track',
            tracks: [{
              id: 'yt:' + route.videoId,
              title: 'YouTube Track',
              artist: 'YouTube',
              artwork: `https://i.ytimg.com/vi/${route.videoId}/hqdefault.jpg`,
              duration: 0,
              source: 'youtube'
            }]
          };
        }
        throw new Error('В ссылке YouTube не найден идентификатор плейлиста (?list=...)');
      }

      const json = await net.postJson('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240601.00.00',
            hl: 'ru',
            gl: 'RU'
          }
        },
        browseId: 'VL' + route.listId
      });

      const title = json?.metadata?.playlistMetadataRenderer?.title
        || json?.header?.pageHeaderRenderer?.pageTitle
        || 'YouTube Playlist';

      const tracks = [];
      const visitedIds = new Set();

      function scan(obj) {
        if (!obj || typeof obj !== 'object') return;

        if (obj.lockupViewModel && obj.lockupViewModel.contentId) {
          const l = obj.lockupViewModel;
          const vId = l.contentId;
          if (!visitedIds.has(vId)) {
            visitedIds.add(vId);
            const meta = l.metadata?.lockupMetadataViewModel;
            const tTitle = meta?.title?.content || 'YouTube Track';
            const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
            const artist = rows[0]?.metadataParts?.[0]?.text?.content || 'YouTube';
            const thumbs = l.contentImage?.thumbnailViewModel?.image?.sources || [];
            const artwork = thumbs.length ? thumbs[thumbs.length - 1].url : '';
            tracks.push({
              id: 'yt:' + vId,
              title: tTitle.trim(),
              artist: artist.trim(),
              artwork,
              duration: 0,
              source: 'youtube'
            });
          }
        }

        if (obj.playlistVideoRenderer && obj.playlistVideoRenderer.videoId) {
          const v = obj.playlistVideoRenderer;
          const vId = v.videoId;
          if (!visitedIds.has(vId)) {
            visitedIds.add(vId);
            const tTitle = v.title?.runs?.[0]?.text || v.title?.simpleText || 'YouTube Track';
            const artist = v.shortBylineText?.runs?.[0]?.text || 'YouTube';
            const thumbs = v.thumbnail?.thumbnails || [];
            const artwork = thumbs.length ? thumbs[thumbs.length - 1].url : '';
            const duration = U.parseDurationText ? U.parseDurationText(v.lengthText?.simpleText || '') : 0;
            tracks.push({
              id: 'yt:' + vId,
              title: tTitle.trim(),
              artist: artist.trim(),
              artwork,
              duration,
              source: 'youtube'
            });
          }
        }

        if (Array.isArray(obj)) {
          for (const item of obj) scan(item);
        } else {
          for (const k of Object.keys(obj)) scan(obj[k]);
        }
      }

      scan(json);
      if (!tracks.length) {
        throw new Error('Не удалось извлечь треки из плейлиста YouTube. Убедитесь, что плейлист публичный.');
      }
      return { name: `YouTube: ${title}`, tracks };
    }

    async function importYandexMusic(route) {
      if (route.yandexKind) {
        try {
          const jsonStr = await net.getUrl(
            `https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(route.yandexUser)}&kinds=${encodeURIComponent(route.yandexKind)}`,
            { 'X-Requested-With': 'XMLHttpRequest' }
          );
          const data = JSON.parse(jsonStr);
          const pl = data?.playlist || {};
          const rawTracks = pl.tracks || [];
          if (rawTracks.length) {
            const tracks = rawTracks.map((t) => {
              const artists = (t.artists || []).map((a) => a.name).join(', ') || 'Unknown Artist';
              const art = t.coverUri ? ('https://' + t.coverUri.replace('%%', '400x400')) : '';
              return {
                id: `yt:ytsearch:${encodeURIComponent(artists + ' - ' + t.title)}`,
                title: t.title,
                artist: artists,
                album: t.albums?.[0]?.title || '',
                artwork: art,
                duration: Math.round((t.durationMs || 0) / 1000),
                source: 'youtube'
              };
            });
            return { name: `Яндекс: ${pl.title || 'Плейлист'}`, tracks };
          }
        } catch {}
      }

      if (route.yandexAlbumId) {
        try {
          const jsonStr = await net.getUrl(
            `https://music.yandex.ru/handlers/album.jsx?album=${encodeURIComponent(route.yandexAlbumId)}`,
            { 'X-Requested-With': 'XMLHttpRequest' }
          );
          const data = JSON.parse(jsonStr);
          const title = data?.title || 'Альбом';
          const rawTracks = (data?.volumes || []).flat();
          if (rawTracks.length) {
            const tracks = rawTracks.map((t) => {
              const artists = (t.artists || []).map((a) => a.name).join(', ') || data.artists?.[0]?.name || 'Unknown Artist';
              const art = t.coverUri
                ? ('https://' + t.coverUri.replace('%%', '400x400'))
                : (data.coverUri ? ('https://' + data.coverUri.replace('%%', '400x400')) : '');
              return {
                id: `yt:ytsearch:${encodeURIComponent(artists + ' - ' + t.title)}`,
                title: t.title,
                artist: artists,
                album: title,
                artwork: art,
                duration: Math.round((t.durationMs || 0) / 1000),
                source: 'youtube'
              };
            });
            return { name: `Яндекс: ${title}`, tracks };
          }
        } catch {}
      }

      try {
        const html = await net.getUrl(route.url);
        if (html) {
          const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
          for (const m of ldMatches) {
            try {
              const ld = JSON.parse(m[1]);
              const rawTracks = ld.track || ld.tracks || [];
              if (Array.isArray(rawTracks) && rawTracks.length) {
                const tracks = rawTracks.map((t) => {
                  const artName = t.byArtist?.name || t.author?.name || 'Unknown Artist';
                  return {
                    id: `yt:ytsearch:${encodeURIComponent(artName + ' - ' + t.name)}`,
                    title: t.name,
                    artist: artName,
                    duration: 0,
                    source: 'youtube'
                  };
                });
                return { name: `Яндекс: ${ld.name || 'Плейлист'}`, tracks };
              }
            } catch {}
          }
        }
      } catch {}

      throw new Error('Не удалось импортировать плейлист Яндекс Музыки. Убедитесь, что плейлист открытый.');
    }

    async function importFromUrl(rawUrl) {
      const route = U.detectPlaylistProvider ? U.detectPlaylistProvider(rawUrl) : null;
      if (!route) throw new Error('Введите ссылку на плейлист или альбом');

      let result = null;
      if (route.provider === 'spotify') result = await importSpotify(route);
      else if (route.provider === 'yandex') result = await importYandexMusic(route);
      else result = await importYouTube(route);

      if (!result || !Array.isArray(result.tracks) || !result.tracks.length) {
        throw new Error('В плейлисте не найдено треков');
      }
      return result;
    }

    return { importFromUrl };
  }

  window.MintPyMobileImporters = { createPlaylistImporter };
})();

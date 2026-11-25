const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../shared/utils.js');

test('esc() escapes HTML special characters safely', () => {
  assert.equal(U.esc('<script>"hi" & \'bye\'</script>'), '&lt;script&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/script&gt;');
  assert.equal(U.esc(null), '');
  assert.equal(U.esc(42), '42');
});

test('fmtTime() and parseDurationText() handle minutes and hours accurately', () => {
  assert.equal(U.fmtTime(0), '0:00');
  assert.equal(U.fmtTime(65.9), '1:05');
  assert.equal(U.fmtTime(3661), '1:01:01');
  assert.equal(U.fmtTime(-5), '0:00');
  assert.equal(U.fmtTime(NaN), '0:00');

  assert.equal(U.parseDurationText('3:45'), 225);
  assert.equal(U.parseDurationText('1:02:05'), 3725);
  assert.equal(U.parseDurationText('LIVE'), 0);
});

test('sanitizeLyricsQuery() strips video/remaster noise while preserving song titles', () => {
  assert.equal(
    U.sanitizeLyricsQuery('Nujabes - Feather (Official Audio) [Remastered 4K] | Chillhop'),
    'Nujabes - Feather'
  );
  assert.equal(
    U.sanitizeLyricsQuery('Midnight City feat. M83 (Visualizer)'),
    'Midnight City'
  );
});

test('parseLrc() parses multi-timestamp and millisecond LRC lines in sorted order', () => {
  const raw = [
    '[00:12.50] Second line',
    '[00:04.00][00:20.25] Chorus hook',
    '[00:08:10] Colon millis',
    '[00:16.00]   '
  ].join('\n');

  const parsed = U.parseLrc(raw);
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed[0], { time: 4, text: 'Chorus hook' });
  assert.deepEqual(parsed[1], { time: 8.1, text: 'Colon millis' });
  assert.deepEqual(parsed[2], { time: 12.5, text: 'Second line' });
  assert.deepEqual(parsed[3], { time: 16, text: '♪' });
  assert.deepEqual(parsed[4], { time: 20.25, text: 'Chorus hook' });
});

test('detectPlaylistProvider() routes Spotify, Yandex Music, and YouTube URLs accurately', () => {
  const sp = U.detectPlaylistProvider('open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(sp.provider, 'spotify');
  assert.equal(sp.embedUrl, 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');

  const ymPl = U.detectPlaylistProvider('https://music.yandex.ru/users/yamusic-chill/playlists/1005');
  assert.equal(ymPl.provider, 'yandex');
  assert.equal(ymPl.yandexUser, 'yamusic-chill');
  assert.equal(ymPl.yandexKind, '1005');

  const ymAlb = U.detectPlaylistProvider('https://music.yandex.ru/album/987654');
  assert.equal(ymAlb.provider, 'yandex');
  assert.equal(ymAlb.yandexAlbumId, '987654');

  const ytList = U.detectPlaylistProvider('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345_abc');
  assert.equal(ytList.provider, 'youtube');
  assert.equal(ytList.listId, 'PL12345_abc');
  assert.equal(ytList.videoId, 'dQw4w9WgXcQ');

  const ytShort = U.detectPlaylistProvider('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(ytShort.provider, 'youtube');
  assert.equal(ytShort.videoId, 'dQw4w9WgXcQ');
});

test('parseInnertubeSearch() extracts deduplicated tracks cleanly', () => {
  const mock = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{
              itemSectionRenderer: {
                contents: [
                  {
                    videoRenderer: {
                      videoId: 'abc12345678',
                      title: { runs: [{ text: 'Lofi Study Beat' }] },
                      ownerText: { runs: [{ text: 'Chill Channel' }] },
                      thumbnail: { thumbnails: [{ url: 'https://img/low.jpg' }, { url: 'https://img/hq.jpg' }] },
                      lengthText: { simpleText: '2:30' }
                    }
                  },
                  {
                    videoRenderer: {
                      videoId: 'abc12345678',
                      title: { simpleText: 'Duplicate' }
                    }
                  }
                ]
              }
            }]
          }
        }
      }
    }
  };

  const tracks = U.parseInnertubeSearch(mock);
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0], {
    id: 'yt:abc12345678',
    title: 'Lofi Study Beat',
    artist: 'Chill Channel',
    artwork: 'https://img/hq.jpg',
    duration: 150,
    source: 'youtube'
  });
});

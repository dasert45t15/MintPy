function cleanSearchText(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\(\[][^\)\]]*(?:remaster|bonus|deluxe|expanded|version|edition|live|ost|soundtrack|official|digital|из фильма|песня из)[^\)\]]*[\)\]]/gi, '')
    .replace(/feat\..*$/i, '')
    .replace(/[«»"'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreCandidate(candidate, artist, title, targetDuration) {
  let score = 0;
  const cTitle = (candidate.title || '').toLowerCase();
  const cChannel = (candidate.uploader || candidate.channel || '').toLowerCase();
  const aNorm = String(artist || '').toLowerCase();
  const tNorm = String(title || '').toLowerCase();

  // Negative penalty for bad keywords unless target title explicitly requested them
  const badWords = [
    'cover', 'reaction', 'parody', 'karaoke', 'instrumental',
    '10 hours', '1 hour', 'hour loop', 'bass boosted', 'slowed',
    'reverb', 'nightcore', 'speed up', 'tutorial', 'how to play', 'review'
  ];
  for (const bw of badWords) {
    if (cTitle.includes(bw) && !tNorm.includes(bw)) {
      score -= 80;
    }
  }

  // Bonus for Official Audio / Topic / VEVO
  if (cChannel.includes('topic') || cChannel.includes('vevo') || cChannel.includes('official') ||
      cTitle.includes('official audio') || cTitle.includes('official music video') || cTitle.includes('official track')) {
    score += 45;
  }

  // Bonus for Channel matching Artist
  if (aNorm && (cChannel.includes(aNorm) || aNorm.includes(cChannel))) {
    score += 35;
  }

  // Bonus for Title containing both Artist and Title
  if (tNorm && cTitle.includes(tNorm)) score += 35;
  if (aNorm && cTitle.includes(aNorm)) score += 20;

  // Duration proximity check (essential for matching studio track vs live/mix)
  const cDur = Number(candidate.duration) || 0;
  const tDur = Number(targetDuration) || 0;
  if (tDur > 0 && cDur > 0) {
    const diff = Math.abs(cDur - tDur);
    if (diff <= 3) score += 60;
    else if (diff <= 8) score += 35;
    else if (diff <= 20) score += 15;
    else if (diff > 60) score -= 50;
    if (diff > 180) score -= 120; // 3+ min difference is almost certainly a mix or compilation
  }

  return score;
}

async function findBestYouTubeTrack(ytDlp, artist, title, duration = 0) {
  const cleanA = cleanSearchText(artist);
  const cleanT = cleanSearchText(title);
  const q = `${cleanA} ${cleanT}`.trim();
  if (!q) return null;

  try {
    const out = await ytDlp(['--flat-playlist', '--dump-json', `ytsearch5:${q}`], 15000);
    if (!out) return null;

    const lines = out.split('\n').filter(Boolean);
    const candidates = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && item.id) candidates.push(item);
      } catch {}
    }

    if (candidates.length === 0) return null;

    let best = null;
    let maxScore = -999;
    for (const c of candidates) {
      const sc = scoreCandidate(c, cleanA, cleanT, duration);
      if (sc > maxScore) {
        maxScore = sc;
        best = c;
      }
    }

    // Fallback to first candidate if all scored negative
    if (!best) best = candidates[0];

    return {
      id: best.id,
      title: best.title,
      artist: best.uploader || best.channel || artist,
      duration: Number(best.duration) || duration,
      artwork: best.thumbnails?.[0]?.url || ''
    };
  } catch (err) {
    console.warn(`Smart YouTube search failed for "${q}":`, err.message);
    return null;
  }
}

module.exports = {
  cleanSearchText,
  scoreCandidate,
  findBestYouTubeTrack
};

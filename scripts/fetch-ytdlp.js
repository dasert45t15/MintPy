const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const VERSION = '2026.08.19';
const SHA256 = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a';
const dest = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
const url = 'https://github.com/yt-dlp/yt-dlp/releases/download/' + VERSION + '/yt-dlp.exe';

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(downloadUrl, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(downloadUrl, { headers: { 'User-Agent': 'mintpy-build' } }, async response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new Error('Too many yt-dlp redirects'));
        return download(new URL(response.headers.location, downloadUrl).toString(), file, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('yt-dlp download failed: HTTP ' + response.statusCode));
      }
      try {
        await pipeline(response, fs.createWriteStream(file));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    request.setTimeout(60000, () => request.destroy(new Error('yt-dlp download timed out')));
    request.on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(dest) && fileHash(dest) === SHA256) {
    console.log('yt-dlp ' + VERSION + ' already verified');
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = dest + '.download';
  try {
    await download(url, temp);
    if (fileHash(temp) !== SHA256) throw new Error('yt-dlp SHA-256 does not match pinned release');
    fs.renameSync(temp, dest);
    console.log('yt-dlp ' + VERSION + ' downloaded and verified');
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { VERSION, SHA256, fileHash, main };

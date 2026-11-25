#include "tag_scanner.h"
#include "utf_util.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <set>
#include <thread>
#include <unordered_set>

namespace mintpy {

namespace {

inline uint32_t read_be32(const unsigned char* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

inline uint32_t read_le32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

inline uint32_t read_syncsafe(const unsigned char* p) {
  return ((p[0] & 0x7Fu) << 21) | ((p[1] & 0x7Fu) << 14) | ((p[2] & 0x7Fu) << 7) | (p[3] & 0x7Fu);
}

std::string decode_id3_text(const unsigned char* data, size_t len) {
  if (len == 0) return {};
  unsigned char enc = data[0];
  const unsigned char* payload = data + 1;
  size_t plen = len - 1;
  if (plen == 0) return {};

  if (enc == 0) {
    return trim_copy(latin1_to_utf8(reinterpret_cast<const char*>(payload), plen));
  } else if (enc == 1) {
    if (plen < 2) return {};
    bool be = (payload[0] == 0xFE && payload[1] == 0xFF);
    bool le = (payload[0] == 0xFF && payload[1] == 0xFE);
    if (be || le) {
      return trim_copy(utf16_bytes_to_utf8(reinterpret_cast<const char*>(payload + 2), plen - 2, be));
    }
    return trim_copy(utf16_bytes_to_utf8(reinterpret_cast<const char*>(payload), plen, false));
  } else if (enc == 2) {
    return trim_copy(utf16_bytes_to_utf8(reinterpret_cast<const char*>(payload), plen, true));
  } else if (enc == 3) {
    size_t zero = 0;
    while (zero < plen && payload[zero] != 0) ++zero;
    return trim_copy(std::string(reinterpret_cast<const char*>(payload), zero));
  }
  return {};
}

std::string save_cover_bytes(const unsigned char* data, size_t len, const std::string& mime,
                             const std::string& source_utf8, const std::filesystem::path& covers_dir) {
  if (!data || len == 0 || len > 16 * 1024 * 1024) return {};
  std::string ext = ".jpg";
  std::string lmime = to_lower_ascii(mime);
  if (lmime.find("png") != std::string::npos || (len >= 4 && data[0] == 0x89 && data[1] == 'P')) ext = ".png";
  else if (lmime.find("gif") != std::string::npos) ext = ".gif";
  else if (lmime.find("webp") != std::string::npos) ext = ".webp";
  else if (lmime.find("bmp") != std::string::npos) ext = ".bmp";

  std::string name = sha1_hex(source_utf8) + ext;
  std::error_code ec;
  std::filesystem::create_directories(covers_dir, ec);
  std::filesystem::path dest = covers_dir / utf8_to_wide(name);
  if (!std::filesystem::exists(dest, ec)) {
    std::ofstream ofs(dest, std::ios::binary | std::ios::trunc);
    if (ofs.good()) {
      ofs.write(reinterpret_cast<const char*>(data), static_cast<std::streamsize>(len));
    }
  }
  return "cover://covers/" + name;
}

struct ParsedTags {
  std::string title;
  std::string artist;
  std::string album;
  std::string artwork;
  double duration = 0;
};

double estimate_mp3_duration(std::ifstream& ifs, uint64_t audio_offset, uint64_t file_size) {
  if (file_size <= audio_offset + 4) return 0;
  ifs.seekg(static_cast<std::streamoff>(audio_offset), std::ios::beg);
  unsigned char buf[4096];
  ifs.read(reinterpret_cast<char*>(buf), sizeof(buf));
  std::streamsize n = ifs.gcount();
  static const int br_v1_l3[16] = {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0};
  static const int sr_v1[4] = {44100, 48000, 32000, 0};
  for (std::streamsize i = 0; i + 4 <= n; ++i) {
    if (buf[i] == 0xFF && (buf[i + 1] & 0xE0) == 0xE0) {
      int ver = (buf[i + 1] >> 3) & 3;
      int layer = (buf[i + 1] >> 1) & 3;
      int br_idx = (buf[i + 2] >> 4) & 0xF;
      int sr_idx = (buf[i + 2] >> 2) & 3;
      if (ver == 3 && layer == 1 && br_idx > 0 && br_idx < 15 && sr_idx < 3) {
        int bitrate_kbps = br_v1_l3[br_idx];
        int sr = sr_v1[sr_idx];
        // Check for Xing/Info VBR header at +36 bytes
        if (i + 48 < n) {
          size_t xoff = static_cast<size_t>(i) + 36;
          if (std::memcmp(buf + xoff, "Xing", 4) == 0 || std::memcmp(buf + xoff, "Info", 4) == 0) {
            uint32_t xflags = read_be32(buf + xoff + 4);
            if (xflags & 1) {
              uint32_t frames = read_be32(buf + xoff + 8);
              if (frames > 0 && sr > 0) return (static_cast<double>(frames) * 1152.0) / static_cast<double>(sr);
            }
          }
        }
        if (bitrate_kbps > 0) {
          return static_cast<double>((file_size - audio_offset) * 8ULL) / (static_cast<double>(bitrate_kbps) * 1000.0);
        }
      }
    }
  }
  return 0;
}

void parse_mp3(std::ifstream& ifs, uint64_t file_size, const std::string& source_utf8,
               const std::filesystem::path& covers_dir, ParsedTags& out) {
  unsigned char hdr[10]{};
  ifs.seekg(0, std::ios::beg);
  ifs.read(reinterpret_cast<char*>(hdr), 10);
  uint64_t audio_offset = 0;

  if (ifs.gcount() == 10 && std::memcmp(hdr, "ID3", 3) == 0) {
    uint8_t ver = hdr[3];
    uint32_t tag_size = read_syncsafe(hdr + 6);
    audio_offset = 10 + tag_size;
    if (tag_size > 0 && tag_size <= 24 * 1024 * 1024) {
      std::vector<unsigned char> tag(tag_size);
      ifs.read(reinterpret_cast<char*>(tag.data()), tag_size);
      size_t got = static_cast<size_t>(ifs.gcount());
      size_t pos = 0;
      if ((hdr[5] & 0x40) && got >= 4 && ver >= 3) {
        uint32_t ext = (ver == 4) ? read_syncsafe(tag.data()) : read_be32(tag.data());
        pos += (ver == 4) ? ext : (4 + ext);
      }
      while (pos + (ver == 2 ? 6 : 10) <= got) {
        if (tag[pos] == 0) break;
        std::string fid;
        uint32_t fsize = 0;
        size_t fhdr = 10;
        if (ver == 2) {
          fid.assign(reinterpret_cast<const char*>(tag.data() + pos), 3);
          fsize = (static_cast<uint32_t>(tag[pos + 3]) << 16) | (static_cast<uint32_t>(tag[pos + 4]) << 8) | tag[pos + 5];
          fhdr = 6;
        } else {
          fid.assign(reinterpret_cast<const char*>(tag.data() + pos), 4);
          fsize = (ver == 4) ? read_syncsafe(tag.data() + pos + 4) : read_be32(tag.data() + pos + 4);
        }
        pos += fhdr;
        if (fsize == 0 || pos + fsize > got) break;
        const unsigned char* fd = tag.data() + pos;
        if (fid == "TIT2" || fid == "TT2") {
          std::string v = decode_id3_text(fd, fsize);
          if (!v.empty()) out.title = v;
        } else if (fid == "TPE1" || fid == "TP1") {
          std::string v = decode_id3_text(fd, fsize);
          if (!v.empty()) out.artist = v;
        } else if (fid == "TALB" || fid == "TAL") {
          std::string v = decode_id3_text(fd, fsize);
          if (!v.empty()) out.album = v;
        } else if ((fid == "APIC" || fid == "PIC") && out.artwork.empty() && fsize > 8) {
          unsigned char enc = fd[0];
          size_t off = 1;
          std::string mime = "image/jpeg";
          if (fid == "APIC") {
            size_t m_end = off;
            while (m_end < fsize && fd[m_end] != 0) ++m_end;
            mime.assign(reinterpret_cast<const char*>(fd + off), m_end - off);
            off = m_end + 1;
            if (off < fsize) off += 1;  // picture type
          } else {
            mime.assign(reinterpret_cast<const char*>(fd + off), 3);
            off += 4;
          }
          // Skip description null-terminator
          if (enc == 1 || enc == 2) {
            while (off + 1 < fsize && !(fd[off] == 0 && fd[off + 1] == 0)) off += 2;
            off += 2;
          } else {
            while (off < fsize && fd[off] != 0) ++off;
            off += 1;
          }
          if (off < fsize) {
            out.artwork = save_cover_bytes(fd + off, fsize - off, mime, source_utf8, covers_dir);
          }
        }
        pos += fsize;
      }
    }
  }

  // ID3v1 fallback at tail (128 bytes)
  if ((out.title.empty() || out.artist.empty()) && file_size >= 128) {
    unsigned char tail[128]{};
    ifs.clear();
    ifs.seekg(static_cast<std::streamoff>(file_size - 128), std::ios::beg);
    ifs.read(reinterpret_cast<char*>(tail), 128);
    if (ifs.gcount() == 128 && std::memcmp(tail, "TAG", 3) == 0) {
      if (out.title.empty()) out.title = trim_copy(latin1_to_utf8(reinterpret_cast<const char*>(tail + 3), 30));
      if (out.artist.empty()) out.artist = trim_copy(latin1_to_utf8(reinterpret_cast<const char*>(tail + 33), 30));
      if (out.album.empty()) out.album = trim_copy(latin1_to_utf8(reinterpret_cast<const char*>(tail + 63), 30));
    }
  }

  ifs.clear();
  out.duration = estimate_mp3_duration(ifs, audio_offset, file_size);
}

void parse_flac(std::ifstream& ifs, const std::string& source_utf8,
                const std::filesystem::path& covers_dir, ParsedTags& out) {
  unsigned char magic[4]{};
  ifs.seekg(0, std::ios::beg);
  ifs.read(reinterpret_cast<char*>(magic), 4);
  if (ifs.gcount() != 4 || std::memcmp(magic, "fLaC", 4) != 0) return;

  bool last = false;
  while (!last && ifs.good()) {
    unsigned char bh[4]{};
    ifs.read(reinterpret_cast<char*>(bh), 4);
    if (ifs.gcount() != 4) break;
    last = (bh[0] & 0x80) != 0;
    uint8_t type = bh[0] & 0x7F;
    uint32_t len = (static_cast<uint32_t>(bh[1]) << 16) | (static_cast<uint32_t>(bh[2]) << 8) | bh[3];
    if (len > 20 * 1024 * 1024) break;

    if (type == 0 && len >= 18) {  // STREAMINFO
      std::vector<unsigned char> buf(len);
      ifs.read(reinterpret_cast<char*>(buf.data()), len);
      uint32_t sr = (static_cast<uint32_t>(buf[10]) << 12) | (static_cast<uint32_t>(buf[11]) << 4) | ((buf[12] >> 4) & 0xF);
      uint64_t total_samples = (static_cast<uint64_t>(buf[13] & 0xF) << 32) |
                               (static_cast<uint64_t>(buf[14]) << 24) | (static_cast<uint64_t>(buf[15]) << 16) |
                               (static_cast<uint64_t>(buf[16]) << 8) | buf[17];
      if (sr > 0 && total_samples > 0) out.duration = static_cast<double>(total_samples) / static_cast<double>(sr);
    } else if (type == 4 && len >= 8) {  // VORBIS_COMMENT
      std::vector<unsigned char> buf(len);
      ifs.read(reinterpret_cast<char*>(buf.data()), len);
      size_t pos = 0;
      uint32_t vlen = read_le32(buf.data() + pos);
      pos += 4 + vlen;
      if (pos + 4 <= len) {
        uint32_t count = read_le32(buf.data() + pos);
        pos += 4;
        for (uint32_t i = 0; i < count && pos + 4 <= len; ++i) {
          uint32_t clen = read_le32(buf.data() + pos);
          pos += 4;
          if (pos + clen > len) break;
          std::string kv(reinterpret_cast<const char*>(buf.data() + pos), clen);
          pos += clen;
          auto eq = kv.find('=');
          if (eq == std::string::npos) continue;
          std::string k = to_lower_ascii(kv.substr(0, eq));
          std::string v = trim_copy(kv.substr(eq + 1));
          if (k == "title" && out.title.empty()) out.title = v;
          else if (k == "artist" && out.artist.empty()) out.artist = v;
          else if (k == "album" && out.album.empty()) out.album = v;
        }
      }
    } else if (type == 6 && out.artwork.empty() && len >= 32) {  // PICTURE
      std::vector<unsigned char> buf(len);
      ifs.read(reinterpret_cast<char*>(buf.data()), len);
      size_t pos = 4;
      if (pos + 4 <= len) {
        uint32_t mlen = read_be32(buf.data() + pos);
        pos += 4;
        std::string mime = (pos + mlen <= len) ? std::string(reinterpret_cast<const char*>(buf.data() + pos), mlen) : "image/jpeg";
        pos += mlen;
        if (pos + 4 <= len) {
          uint32_t dlen = read_be32(buf.data() + pos);
          pos += 4 + dlen + 16;  // desc + width + height + depth + colors
          if (pos + 4 <= len) {
            uint32_t plen = read_be32(buf.data() + pos);
            pos += 4;
            if (pos + plen <= len) {
              out.artwork = save_cover_bytes(buf.data() + pos, plen, mime, source_utf8, covers_dir);
            }
          }
        }
      }
    } else {
      ifs.seekg(static_cast<std::streamoff>(len), std::ios::cur);
    }
  }
}

void parse_wav(std::ifstream& ifs, ParsedTags& out) {
  unsigned char hdr[44]{};
  ifs.seekg(0, std::ios::beg);
  ifs.read(reinterpret_cast<char*>(hdr), 12);
  if (ifs.gcount() != 12 || std::memcmp(hdr, "RIFF", 4) != 0 || std::memcmp(hdr + 8, "WAVE", 4) != 0) return;

  uint32_t byte_rate = 0;
  uint32_t data_size = 0;
  while (ifs.good()) {
    unsigned char ch[8]{};
    ifs.read(reinterpret_cast<char*>(ch), 8);
    if (ifs.gcount() != 8) break;
    uint32_t csize = read_le32(ch + 4);
    if (std::memcmp(ch, "fmt ", 4) == 0 && csize >= 16) {
      std::vector<unsigned char> fmt(csize);
      ifs.read(reinterpret_cast<char*>(fmt.data()), csize);
      byte_rate = read_le32(fmt.data() + 8);
    } else if (std::memcmp(ch, "data", 4) == 0) {
      data_size = csize;
      ifs.seekg(static_cast<std::streamoff>(csize + (csize & 1)), std::ios::cur);
    } else {
      ifs.seekg(static_cast<std::streamoff>(csize + (csize & 1)), std::ios::cur);
    }
    if (byte_rate > 0 && data_size > 0) break;
  }
  if (byte_rate > 0 && data_size > 0) {
    out.duration = static_cast<double>(data_size) / static_cast<double>(byte_rate);
  }
}

void parse_mp4_atoms(std::ifstream& ifs, uint64_t end_pos, const std::string& source_utf8,
                     const std::filesystem::path& covers_dir, ParsedTags& out) {
  while (ifs.good() && static_cast<uint64_t>(ifs.tellg()) + 8 <= end_pos) {
    uint64_t atom_start = static_cast<uint64_t>(ifs.tellg());
    unsigned char ah[8]{};
    ifs.read(reinterpret_cast<char*>(ah), 8);
    if (ifs.gcount() != 8) break;
    uint64_t size = read_be32(ah);
    std::string type(reinterpret_cast<const char*>(ah + 4), 4);
    if (size == 1) {
      unsigned char ext[8]{};
      ifs.read(reinterpret_cast<char*>(ext), 8);
      size = (static_cast<uint64_t>(read_be32(ext)) << 32) | read_be32(ext + 4);
    } else if (size == 0) {
      size = end_pos - atom_start;
    }
    if (size < 8 || atom_start + size > end_pos) break;
    uint64_t atom_end = atom_start + size;

    if (type == "moov" || type == "udta" || type == "ilst") {
      parse_mp4_atoms(ifs, atom_end, source_utf8, covers_dir, out);
    } else if (type == "meta" && size > 12) {
      ifs.seekg(4, std::ios::cur);  // version/flags
      parse_mp4_atoms(ifs, atom_end, source_utf8, covers_dir, out);
    } else if (type == "mvhd" && size >= 32) {
      unsigned char mvhd[32]{};
      ifs.read(reinterpret_cast<char*>(mvhd), 32);
      if (mvhd[0] == 0) {
        uint32_t scale = read_be32(mvhd + 12);
        uint32_t dur = read_be32(mvhd + 16);
        if (scale > 0 && dur > 0) out.duration = static_cast<double>(dur) / static_cast<double>(scale);
      }
    } else if (type == "\xA9" "nam" || type == "\xA9" "ART" || type == "\xA9" "alb" || type == "covr") {
      uint64_t inner_len = atom_end - static_cast<uint64_t>(ifs.tellg());
      if (inner_len >= 16 && inner_len <= 16 * 1024 * 1024) {
        std::vector<unsigned char> buf(inner_len);
        ifs.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(inner_len));
        // Inside item is 'data' atom: [4 len][4 "data"][4 type/flags][4 locale][payload]
        if (buf.size() > 16 && std::memcmp(buf.data() + 4, "data", 4) == 0) {
          const unsigned char* val = buf.data() + 16;
          size_t vlen = buf.size() - 16;
          if (type == "\xA9" "nam") out.title = trim_copy(std::string(reinterpret_cast<const char*>(val), vlen));
          else if (type == "\xA9" "ART") out.artist = trim_copy(std::string(reinterpret_cast<const char*>(val), vlen));
          else if (type == "\xA9" "alb") out.album = trim_copy(std::string(reinterpret_cast<const char*>(val), vlen));
          else if (type == "covr" && out.artwork.empty()) {
            std::string mime = (buf[11] == 14) ? "image/png" : "image/jpeg";
            out.artwork = save_cover_bytes(val, vlen, mime, source_utf8, covers_dir);
          }
        }
      }
    }
    ifs.seekg(static_cast<std::streamoff>(atom_end), std::ios::beg);
  }
}

}  // namespace

bool TagScanner::is_audio_file(const std::filesystem::path& p) {
  std::string ext = to_lower_ascii(wide_to_utf8(p.extension().wstring()));
  return ext == ".mp3" || ext == ".flac" || ext == ".ogg" || ext == ".m4a" ||
         ext == ".wav" || ext == ".aac" || ext == ".mp4";
}

bool TagScanner::should_skip_dir(const std::wstring& name) {
  if (name.empty() || name.size() > 50) return true;
  if (name[0] == L'.' || name[0] == L'$') return true;
  if (name.rfind(L"Microsoft.", 0) == 0 || name.rfind(L"Windows.", 0) == 0) return true;
  if (name.find(L"!Microsoft.") != std::wstring::npos || name.find(L"!Windows.") != std::wstring::npos) return true;
  static const std::unordered_set<std::wstring> skip = {
      L"System Volume Information", L"$RECYCLE.BIN", L"Recovery", L"Boot", L"Windows",
      L"Program Files", L"Program Files (x86)", L"ProgramData", L"AppData",
      L"Local Settings", L"Application Data", L"node_modules", L".git", L".vs",
      L"bin", L"obj", L"dist", L"build", L"out"
  };
  return skip.count(name) > 0;
}

nlohmann::json TagScanner::parse_audio_file(const std::filesystem::path& file_path,
                                            const std::filesystem::path& covers_dir) {
  std::error_code ec;
  uint64_t fsize = std::filesystem::file_size(file_path, ec);
  if (ec) fsize = 0;

  std::string full_utf8 = wide_to_utf8(file_path.wstring());
  std::string ext = to_lower_ascii(wide_to_utf8(file_path.extension().wstring()));
  ParsedTags tags;

  std::ifstream ifs(file_path, std::ios::binary);
  if (ifs.good() && fsize > 0) {
    if (ext == ".mp3") parse_mp3(ifs, fsize, full_utf8, covers_dir, tags);
    else if (ext == ".flac") parse_flac(ifs, full_utf8, covers_dir, tags);
    else if (ext == ".wav") parse_wav(ifs, tags);
    else if (ext == ".m4a" || ext == ".mp4" || ext == ".aac") parse_mp4_atoms(ifs, fsize, full_utf8, covers_dir, tags);
  }

  std::string stem = wide_to_utf8(file_path.stem().wstring());
  if (tags.title.empty() || tags.artist.empty()) {
    auto sep = stem.find(" - ");
    if (sep != std::string::npos) {
      if (tags.artist.empty()) tags.artist = trim_copy(stem.substr(0, sep));
      if (tags.title.empty()) tags.title = trim_copy(stem.substr(sep + 3));
    }
  }
  if (tags.title.empty()) tags.title = stem;
  if (tags.artist.empty()) tags.artist = "Unknown";
  if (tags.album.empty()) tags.album = "Unknown";

  return {
      {"id", "local:" + full_utf8},
      {"filepath", full_utf8},
      {"title", tags.title},
      {"artist", tags.artist},
      {"album", tags.album},
      {"artwork", tags.artwork},
      {"duration", tags.duration},
      {"source", "local"}
  };
}

nlohmann::json TagScanner::scan_folder(
    const std::filesystem::path& root,
    const std::filesystem::path& covers_dir,
    std::unordered_set<std::wstring>& allowed_local_files,
    std::mutex& allowed_mutex,
    const std::function<void(const std::string& msg)>& progress_cb) {
  std::vector<std::filesystem::path> audio_files;
  struct DirEntry { std::filesystem::path dir; int depth; };
  std::vector<DirEntry> stack{{root, 0}};
  std::error_code ec;

  while (!stack.empty()) {
    auto [dir, depth] = std::move(stack.back());
    stack.pop_back();
    if (depth > 10) continue;

    for (auto it = std::filesystem::directory_iterator(dir, std::filesystem::directory_options::skip_permission_denied, ec);
         !ec && it != std::filesystem::directory_iterator(); it.increment(ec)) {
      const auto& entry = *it;
      if (entry.is_symlink(ec)) continue;
      if (entry.is_directory(ec)) {
        if (!should_skip_dir(entry.path().filename().wstring())) {
          stack.push_back({entry.path(), depth + 1});
        }
      } else if (entry.is_regular_file(ec) && is_audio_file(entry.path())) {
        audio_files.push_back(std::filesystem::weakly_canonical(entry.path(), ec));
      }
    }
  }

  nlohmann::json results = nlohmann::json::array();
  if (audio_files.empty()) {
    if (progress_cb) progress_cb("done");
    return results;
  }

  std::vector<nlohmann::json> parsed(audio_files.size());
  std::atomic<size_t> next_idx{0};
  std::atomic<size_t> done_count{0};
  unsigned num_threads = (std::min)(8u, (std::max)(2u, std::thread::hardware_concurrency()));
  if (audio_files.size() < 8) num_threads = 1;

  std::vector<std::thread> workers;
  for (unsigned t = 0; t < num_threads; ++t) {
    workers.emplace_back([&]() {
      while (true) {
        size_t i = next_idx.fetch_add(1);
        if (i >= audio_files.size()) break;
        parsed[i] = parse_audio_file(audio_files[i], covers_dir);
        size_t cnt = done_count.fetch_add(1) + 1;
        if (progress_cb && cnt % 15 == 0) {
          progress_cb("Found: " + std::to_string(cnt) + " tracks...");
        }
      }
    });
  }
  for (auto& w : workers) w.join();

  {
    std::lock_guard lk(allowed_mutex);
    for (size_t i = 0; i < audio_files.size(); ++i) {
      allowed_local_files.insert(audio_files[i].wstring());
      results.push_back(std::move(parsed[i]));
    }
  }

  if (progress_cb) progress_cb("done");
  return results;
}

nlohmann::json TagScanner::scan_paths(
    const std::vector<std::filesystem::path>& paths,
    const std::filesystem::path& covers_dir,
    std::unordered_set<std::wstring>& allowed_local_files,
    std::unordered_set<std::wstring>& allowed_roots,
    std::mutex& allowed_mutex) {
  nlohmann::json total = nlohmann::json::array();
  std::vector<std::filesystem::path> single_files;
  std::error_code ec;

  for (const auto& p : paths) {
    auto abs = std::filesystem::weakly_canonical(p, ec);
    if (ec) continue;
    if (std::filesystem::is_directory(abs, ec)) {
      {
        std::lock_guard lk(allowed_mutex);
        allowed_roots.insert(abs.wstring());
      }
      auto sub = scan_folder(abs, covers_dir, allowed_local_files, allowed_mutex, nullptr);
      for (auto& item : sub) total.push_back(std::move(item));
    } else if (std::filesystem::is_regular_file(abs, ec) && is_audio_file(abs)) {
      {
        std::lock_guard lk(allowed_mutex);
        allowed_roots.insert(abs.parent_path().wstring());
      }
      single_files.push_back(abs);
    }
  }

  for (const auto& f : single_files) {
    auto item = parse_audio_file(f, covers_dir);
    {
      std::lock_guard lk(allowed_mutex);
      allowed_local_files.insert(f.wstring());
    }
    total.push_back(std::move(item));
  }
  return total;
}

}  // namespace mintpy

#include "http_client.h"
#include "utf_util.h"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <regex>
#include <shared_mutex>
#include <unordered_map>

namespace mintpy {

namespace {

HINTERNET get_shared_session() {
  static HINTERNET session = []() {
    HINTERNET h = WinHttpOpen(
        L"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (h) {
      DWORD decomp = WINHTTP_DECOMPRESSION_FLAG_ALL;
      WinHttpSetOption(h, WINHTTP_OPTION_DECOMPRESSION, &decomp, sizeof(decomp));
      DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
      WinHttpSetOption(h, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    }
    return h;
  }();
  return session;
}

struct ParsedUrl {
  bool https = true;
  std::wstring host;
  INTERNET_PORT port = 443;
  std::wstring path_and_query;
  bool valid = false;
};

ParsedUrl parse_url(const std::string& url) {
  ParsedUrl res;
  std::wstring wurl = utf8_to_wide(url);
  URL_COMPONENTS uc{};
  uc.dwStructSize = sizeof(uc);
  uc.dwSchemeLength = static_cast<DWORD>(-1);
  uc.dwHostNameLength = static_cast<DWORD>(-1);
  uc.dwUrlPathLength = static_cast<DWORD>(-1);
  uc.dwExtraInfoLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(wurl.c_str(), static_cast<DWORD>(wurl.size()), 0, &uc)) {
    return res;
  }
  res.https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
  res.host.assign(uc.lpszHostName, uc.dwHostNameLength);
  res.port = uc.nPort;
  if (uc.dwUrlPathLength > 0) res.path_and_query.assign(uc.lpszUrlPath, uc.dwUrlPathLength);
  else res.path_and_query = L"/";
  if (uc.dwExtraInfoLength > 0) res.path_and_query.append(uc.lpszExtraInfo, uc.dwExtraInfoLength);
  res.valid = !res.host.empty();
  return res;
}

std::map<std::string, std::string> read_response_headers(HINTERNET hReq) {
  std::map<std::string, std::string> out;
  DWORD size = 0;
  WinHttpQueryHeaders(hReq, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size, WINHTTP_NO_HEADER_INDEX);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return out;
  std::wstring raw(size / sizeof(wchar_t), L'\0');
  if (!WinHttpQueryHeaders(hReq, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, raw.data(), &size, WINHTTP_NO_HEADER_INDEX)) {
    return out;
  }
  std::string utf8 = wide_to_utf8(raw);
  std::istringstream iss(utf8);
  std::string line;
  std::getline(iss, line);  // skip HTTP status line
  while (std::getline(iss, line)) {
    auto colon = line.find(':');
    if (colon == std::string::npos) continue;
    std::string k = to_lower_ascii(trim_copy(line.substr(0, colon)));
    std::string v = trim_copy(line.substr(colon + 1));
    if (!k.empty()) out[k] = v;
  }
  return out;
}

struct CachedStream {
  ResolvedStream stream;
  std::chrono::steady_clock::time_point ts;
};
std::shared_mutex g_stream_cache_mutex;
std::unordered_map<std::string, CachedStream> g_stream_cache;

std::mutex g_inflight_mutex;
std::condition_variable g_inflight_cv;
std::unordered_map<std::string, int> g_inflight_counts;

int parse_duration_str(const std::string& s) {
  if (s.empty()) return 0;
  std::vector<int> parts;
  std::istringstream iss(s);
  std::string tok;
  while (std::getline(iss, tok, ':')) {
    try {
      parts.push_back(std::stoi(tok));
    } catch (...) {
      return 0;
    }
  }
  if (parts.size() == 2) return parts[0] * 60 + parts[1];
  if (parts.size() == 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

std::string clean_search_text(const std::string& str) {
  if (str.empty()) return {};
  static const std::regex bracket_re(R"([\(\[][^\)\]]*(?:remaster|bonus|deluxe|expanded|version|edition|live|ost|soundtrack|official|digital)[^\)\]]*[\)\]])", std::regex::icase);
  static const std::regex feat_re(R"(feat\..*$)", std::regex::icase);
  std::string out = std::regex_replace(str, bracket_re, "");
  out = std::regex_replace(out, feat_re, "");
  for (char& ch : out) {
    if (ch == '"' || ch == '\'' || ch == '<' || ch == '>') ch = ' ';
  }
  static const std::regex ws_re(R"(\s+)");
  out = std::regex_replace(out, ws_re, " ");
  return trim_copy(out);
}

double score_candidate(const nlohmann::json& c, const std::string& artist, const std::string& title, double target_duration) {
  double score = 0;
  std::string cTitle = to_lower_ascii(c.value("title", ""));
  std::string cChannel = to_lower_ascii(c.value("artist", ""));
  std::string aNorm = to_lower_ascii(artist);
  std::string tNorm = to_lower_ascii(title);

  static const char* bad_words[] = {
      "cover", "reaction", "parody", "karaoke", "instrumental",
      "10 hours", "1 hour", "hour loop", "bass boosted", "slowed",
      "reverb", "nightcore", "speed up", "tutorial", "how to play", "review"
  };
  for (const char* bw : bad_words) {
    if (cTitle.find(bw) != std::string::npos && tNorm.find(bw) == std::string::npos) {
      score -= 80;
    }
  }
  if (cChannel.find("topic") != std::string::npos || cChannel.find("vevo") != std::string::npos ||
      cChannel.find("official") != std::string::npos || cTitle.find("official audio") != std::string::npos ||
      cTitle.find("official music video") != std::string::npos || cTitle.find("official track") != std::string::npos) {
    score += 45;
  }
  if (!aNorm.empty() && (cChannel.find(aNorm) != std::string::npos || aNorm.find(cChannel) != std::string::npos)) {
    score += 35;
  }
  if (!tNorm.empty() && cTitle.find(tNorm) != std::string::npos) score += 35;
  if (!aNorm.empty() && cTitle.find(aNorm) != std::string::npos) score += 20;

  double cDur = c.value("duration", 0.0);
  if (target_duration > 0 && cDur > 0) {
    double diff = std::abs(cDur - target_duration);
    if (diff <= 3) score += 60;
    else if (diff <= 8) score += 35;
    else if (diff <= 20) score += 15;
    else if (diff > 60) score -= 50;
    if (diff > 180) score -= 120;
  }
  return score;
}

std::string pick_best_audio_format(const nlohmann::json& player_json) {
  if (!player_json.contains("streamingData")) return {};
  const auto& sd = player_json["streamingData"];
  if (!sd.contains("adaptiveFormats") || !sd["adaptiveFormats"].is_array()) return {};

  std::string best_mp4, best_any;
  int best_mp4_br = -1, best_any_br = -1;
  for (const auto& f : sd["adaptiveFormats"]) {
    std::string mime = f.value("mimeType", "");
    std::string url = f.value("url", "");
    if (url.empty() || mime.rfind("audio/", 0) != 0) continue;
    int br = f.value("bitrate", 0);
    if (mime.find("audio/mp4") != std::string::npos) {
      if (br > best_mp4_br) { best_mp4_br = br; best_mp4 = url; }
    } else {
      if (br > best_any_br) { best_any_br = br; best_any = url; }
    }
  }
  return !best_mp4.empty() ? best_mp4 : best_any;
}

}  // namespace

HttpResponse HttpClient::request(
    const std::string& method,
    const std::string& url,
    const std::string& body,
    const std::map<std::string, std::string>& headers,
    int timeout_ms) {
  HttpResponse res;
  HINTERNET hSession = get_shared_session();
  if (!hSession) return res;

  auto parsed = parse_url(url);
  if (!parsed.valid) return res;

  HINTERNET hConnect = WinHttpConnect(hSession, parsed.host.c_str(), parsed.port, 0);
  if (!hConnect) return res;

  DWORD flags = parsed.https ? WINHTTP_FLAG_SECURE : 0;
  std::wstring wmethod = utf8_to_wide(method);
  HINTERNET hRequest = WinHttpOpenRequest(hConnect, wmethod.c_str(), parsed.path_and_query.c_str(), nullptr,
                                          WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (!hRequest) {
    WinHttpCloseHandle(hConnect);
    return res;
  }

  WinHttpSetTimeouts(hRequest, timeout_ms, timeout_ms, timeout_ms, timeout_ms);

  std::wstring hdrs;
  for (const auto& [k, v] : headers) {
    hdrs += utf8_to_wide(k) + L": " + utf8_to_wide(v) + L"\r\n";
  }
  if (!hdrs.empty()) {
    WinHttpAddRequestHeaders(hRequest, hdrs.c_str(), static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
  }

  BOOL sent = WinHttpSendRequest(
      hRequest,
      WINHTTP_NO_ADDITIONAL_HEADERS, 0,
      body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
      static_cast<DWORD>(body.size()),
      static_cast<DWORD>(body.size()),
      0);

  if (sent && WinHttpReceiveResponse(hRequest, nullptr)) {
    DWORD status = 0, statusSize = sizeof(status);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
    res.status = static_cast<int>(status);
    res.headers = read_response_headers(hRequest);

    DWORD avail = 0;
    while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
      size_t cur = res.body.size();
      res.body.resize(cur + avail);
      DWORD readBytes = 0;
      if (!WinHttpReadData(hRequest, res.body.data() + cur, avail, &readBytes) || readBytes == 0) {
        res.body.resize(cur);
        break;
      }
      res.body.resize(cur + readBytes);
    }
  }

  WinHttpCloseHandle(hRequest);
  WinHttpCloseHandle(hConnect);
  return res;
}

bool HttpClient::stream_url(
    const std::string& url,
    const std::string& range_header,
    const std::function<bool(int status, const std::map<std::string, std::string>& headers)>& on_headers,
    const std::function<bool(const char* data, size_t len)>& on_chunk,
    const std::string& user_agent,
    const std::string& method) {
  HINTERNET hSession = get_shared_session();
  if (!hSession) return false;
  auto parsed = parse_url(url);
  if (!parsed.valid) return false;

  HINTERNET hConnect = WinHttpConnect(hSession, parsed.host.c_str(), parsed.port, 0);
  if (!hConnect) return false;

  std::string upper_method = method.empty() ? "GET" : method;
  std::wstring wmethod = utf8_to_wide(upper_method);
  DWORD flags = parsed.https ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET hRequest = WinHttpOpenRequest(hConnect, wmethod.c_str(), parsed.path_and_query.c_str(), nullptr,
                                          WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (!hRequest) {
    WinHttpCloseHandle(hConnect);
    return false;
  }

  WinHttpSetTimeouts(hRequest, 8000, 10000, 10000, 30000);
  // Request identity encoding for range audio proxy so Content-Length matches verbatim
  std::wstring hdrs = L"Accept: */*\r\nAccept-Encoding: identity\r\n";
  if (!user_agent.empty()) {
    hdrs += L"User-Agent: " + utf8_to_wide(user_agent) + L"\r\n";
  }
  if (!range_header.empty()) {
    hdrs += L"Range: " + utf8_to_wide(range_header) + L"\r\n";
  }
  WinHttpAddRequestHeaders(hRequest, hdrs.c_str(), static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);

  bool success = false;
  if (WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
      WinHttpReceiveResponse(hRequest, nullptr)) {
    DWORD status = 0, statusSize = sizeof(status);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
    auto headers = read_response_headers(hRequest);
    if (on_headers(static_cast<int>(status), headers)) {
      success = true;
      if (upper_method != "HEAD") {
        std::vector<char> buf(65536);
        DWORD avail = 0;
        while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
          DWORD toRead = (std::min<DWORD>)(avail, static_cast<DWORD>(buf.size()));
          DWORD readBytes = 0;
          if (!WinHttpReadData(hRequest, buf.data(), toRead, &readBytes) || readBytes == 0) break;
          if (!on_chunk(buf.data(), readBytes)) {
            success = false;
            break;
          }
        }
      }
    }
  }

  WinHttpCloseHandle(hRequest);
  WinHttpCloseHandle(hConnect);
  return success;
}

nlohmann::json HttpClient::youtube_search(const std::string& query, int max_results) {
  nlohmann::json tracks = nlohmann::json::array();
  if (query.empty()) return tracks;

  nlohmann::json payload = {
      {"context", {{"client", {{"clientName", "WEB"}, {"clientVersion", "2.20240601.00.00"}, {"hl", "ru"}, {"gl", "RU"}}}}},
      {"query", query}
  };
  auto resp = request(
      "POST",
      "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
      payload.dump(),
      {{"Content-Type", "application/json"}, {"Accept", "application/json"}},
      10000);
  if (!resp.ok() || resp.body.empty()) return tracks;

  try {
    auto data = nlohmann::json::parse(resp.body);
    const auto& sections = data["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"];
    if (!sections.is_array()) return tracks;
    for (const auto& sec : sections) {
      if (!sec.contains("itemSectionRenderer")) continue;
      const auto& items = sec["itemSectionRenderer"]["contents"];
      if (!items.is_array()) continue;
      for (const auto& it : items) {
        if (!it.contains("videoRenderer")) continue;
        const auto& v = it["videoRenderer"];
        std::string vid = v.value("videoId", "");
        if (vid.empty()) continue;

        // Skip livestreams
        bool is_live = false;
        if (v.contains("badges") && v["badges"].is_array()) {
          for (const auto& b : v["badges"]) {
            if (b.value("metadataBadgeRenderer", nlohmann::json::object()).value("style", "").find("LIVE") != std::string::npos) {
              is_live = true;
            }
          }
        }
        std::string durText = v.value("lengthText", nlohmann::json::object()).value("simpleText", "");
        if (is_live || durText.empty()) continue;

        std::string title;
        if (v.contains("title") && v["title"].contains("runs") && !v["title"]["runs"].empty()) {
          title = v["title"]["runs"][0].value("text", "");
        } else {
          title = v.value("title", nlohmann::json::object()).value("simpleText", "");
        }
        std::string artist = "YouTube";
        if (v.contains("ownerText") && v["ownerText"].contains("runs") && !v["ownerText"]["runs"].empty()) {
          artist = v["ownerText"]["runs"][0].value("text", "YouTube");
        }
        std::string artwork;
        if (v.contains("thumbnail") && v["thumbnail"].contains("thumbnails") && v["thumbnail"]["thumbnails"].is_array() && !v["thumbnail"]["thumbnails"].empty()) {
          artwork = v["thumbnail"]["thumbnails"].back().value("url", "");
        }

        tracks.push_back({
            {"id", "yt:" + vid},
            {"title", title},
            {"artist", artist},
            {"artwork", artwork},
            {"duration", parse_duration_str(durText)},
            {"source", "youtube"}
        });
        if (static_cast<int>(tracks.size()) >= max_results) return tracks;
      }
    }
  } catch (...) {}
  return tracks;
}

std::string HttpClient::run_ytdlp(const std::wstring& ytdlp_path, const std::vector<std::wstring>& args, int timeout_ms) {
  if (ytdlp_path.empty()) return {};
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE hRead = nullptr, hWrite = nullptr;
  if (!CreatePipe(&hRead, &hWrite, &sa, 0)) return {};
  SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);

  std::wstring cmd = L"\"" + ytdlp_path + L"\"";
  for (const auto& a : args) {
    cmd += L" \"" + a + L"\"";
  }

  HANDLE hNul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hNul == INVALID_HANDLE_VALUE) hNul = nullptr;

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = hWrite;
  si.hStdError = hNul ? hNul : hWrite;

  PROCESS_INFORMATION pi{};
  std::string output;
  if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    CloseHandle(hWrite);
    hWrite = nullptr;
    if (hNul) { CloseHandle(hNul); hNul = nullptr; }

    auto start = std::chrono::steady_clock::now();
    char buf[4096];
    DWORD bytesRead = 0;
    while (true) {
      DWORD avail = 0;
      if (PeekNamedPipe(hRead, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
        if (ReadFile(hRead, buf, sizeof(buf), &bytesRead, nullptr) && bytesRead > 0) {
          output.append(buf, bytesRead);
        }
      } else {
        DWORD wait = WaitForSingleObject(pi.hProcess, 50);
        if (wait == WAIT_OBJECT_0) {
          while (ReadFile(hRead, buf, sizeof(buf), &bytesRead, nullptr) && bytesRead > 0) {
            output.append(buf, bytesRead);
          }
          break;
        }
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
        if (elapsed > timeout_ms) {
          TerminateProcess(pi.hProcess, 1);
          output.clear();
          break;
        }
      }
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
  if (hNul) CloseHandle(hNul);
  if (hWrite) CloseHandle(hWrite);
  if (hRead) CloseHandle(hRead);
  return trim_copy(output);
}

void HttpClient::invalidate_youtube_stream(const std::string& video_id_or_search) {
  std::string key = video_id_or_search;
  if (key.rfind("yt:", 0) == 0) key = key.substr(3);
  std::unique_lock lk(g_stream_cache_mutex);
  g_stream_cache.erase(video_id_or_search);
  g_stream_cache.erase(key);
}

ResolvedStream HttpClient::resolve_youtube_stream(const std::string& video_id_or_search, const std::wstring& ytdlp_path) {
  std::string key = video_id_or_search;
  if (key.rfind("yt:", 0) == 0) key = key.substr(3);

  auto read_cached = [&](const std::string& k) -> ResolvedStream {
    std::shared_lock lk(g_stream_cache_mutex);
    auto it = g_stream_cache.find(k);
    if (it != g_stream_cache.end()) {
      auto age = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - it->second.ts).count();
      if (age < 1500 && it->second.stream.ok()) return it->second.stream;
    }
    return {};
  };

  if (auto hit = read_cached(key); hit.ok()) return hit;

  std::string real_id = key;
  if (key.rfind("ytsearch:", 0) == 0) {
    std::string raw_q = url_decode(key.substr(9));
    auto best = resolve_search_track("", raw_q, 0);
    if (best.is_object() && best.contains("id")) {
      real_id = best.value("id", "");
      if (real_id.rfind("yt:", 0) == 0) real_id = real_id.substr(3);
    }
  }
  if (real_id.rfind("ytsearch:", 0) == 0) return {};
  if (auto hit = read_cached(real_id); hit.ok()) return hit;

  // Single-flight deduplication so rapid concurrent range requests share one yt-dlp resolution
  struct InflightGuard {
    std::string k;
    bool owner = false;
    ~InflightGuard() {
      if (!owner) return;
      std::lock_guard lk(g_inflight_mutex);
      g_inflight_counts.erase(k);
      g_inflight_cv.notify_all();
    }
  } guard{real_id, false};

  {
    std::unique_lock lk(g_inflight_mutex);
    g_inflight_cv.wait(lk, [&] { return g_inflight_counts.find(real_id) == g_inflight_counts.end(); });
    if (auto hit = read_cached(real_id); hit.ok()) return hit;
    g_inflight_counts[real_id] = 1;
    guard.owner = true;
  }

  auto cache_store = [&](const ResolvedStream& s) -> ResolvedStream {
    if (!s.ok()) return {};
    std::unique_lock lk(g_stream_cache_mutex);
    auto now = std::chrono::steady_clock::now();
    g_stream_cache[key] = {s, now};
    g_stream_cache[real_id] = {s, now};
    return s;
  };

  // 1. Primary on Desktop: yt-dlp handles player signature & avoids unauthenticated IOS/ANDROID 403s
  if (!ytdlp_path.empty()) {
    std::wstring target = L"https://www.youtube.com/watch?v=" + utf8_to_wide(real_id);
    static const std::vector<std::vector<std::wstring>> ytdlp_attempts = {
        {L"--no-warnings", L"--no-playlist", L"-j", L"-f", L"bestaudio[ext=m4a]/bestaudio"},
        {L"--no-warnings", L"--no-playlist", L"-j", L"-f", L"bestaudio/best"},
        {L"--no-warnings", L"--no-playlist", L"--extractor-args", L"youtube:player_client=tv,android", L"-j", L"-f", L"bestaudio/best"},
    };
    for (const auto& base_args : ytdlp_attempts) {
      auto args = base_args;
      args.push_back(target);
      std::string out = run_ytdlp(ytdlp_path, args, 20000);
      if (out.empty()) continue;
      try {
        auto j = nlohmann::json::parse(out);
        ResolvedStream rs;
        rs.url = j.value("url", "");
        if (j.contains("http_headers") && j["http_headers"].is_object()) {
          rs.user_agent = j["http_headers"].value("User-Agent", "");
        }
        if (rs.ok()) return cache_store(rs);
      } catch (...) {}
    }
  }

  // 2. Fallback only when yt-dlp binary is absent or unavailable: Innertube IOS then ANDROID
  try {
    nlohmann::json payload = {
        {"context", {{"client", {
            {"clientName", "IOS"},
            {"clientVersion", "20.10.4"},
            {"deviceMake", "Apple"},
            {"deviceModel", "iPhone16,2"},
            {"osName", "iPhone"},
            {"osVersion", "18.3.2.22D82"},
            {"hl", "en"},
            {"gl", "US"}
        }}}},
        {"videoId", real_id}
    };
    std::string ios_ua = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)";
    auto r = request("POST", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false", payload.dump(),
                     {
                         {"Content-Type", "application/json"},
                         {"Accept", "application/json"},
                         {"User-Agent", ios_ua},
                         {"X-Youtube-Client-Name", "5"},
                         {"X-Youtube-Client-Version", "20.10.4"}
                     }, 7000);
    if (r.ok()) {
      auto j = nlohmann::json::parse(r.body);
      std::string url = pick_best_audio_format(j);
      if (!url.empty()) return cache_store({url, ios_ua});
    }
  } catch (...) {}

  try {
    nlohmann::json payload = {
        {"context", {{"client", {
            {"clientName", "ANDROID"},
            {"clientVersion", "20.10.38"},
            {"androidSdkVersion", 34},
            {"osName", "Android"},
            {"osVersion", "14"},
            {"hl", "en"},
            {"gl", "US"}
        }}}},
        {"videoId", real_id}
    };
    std::string and_ua = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
    auto r = request("POST", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false", payload.dump(),
                     {
                         {"Content-Type", "application/json"},
                         {"Accept", "application/json"},
                         {"User-Agent", and_ua},
                         {"X-Youtube-Client-Name", "3"},
                         {"X-Youtube-Client-Version", "20.10.38"}
                     }, 7000);
    if (r.ok()) {
      auto j = nlohmann::json::parse(r.body);
      std::string url = pick_best_audio_format(j);
      if (!url.empty()) return cache_store({url, and_ua});
    }
  } catch (...) {}

  return {};
}

nlohmann::json HttpClient::resolve_search_track(const std::string& artist, const std::string& title, double duration) {
  std::string cleanA = clean_search_text(artist);
  std::string cleanT = clean_search_text(title);
  std::string q = trim_copy(cleanA + " " + cleanT);
  if (q.empty()) return nullptr;

  auto candidates = youtube_search(q, 8);
  if (!candidates.is_array() || candidates.empty()) return nullptr;

  const nlohmann::json* best = &candidates[0];
  double maxScore = -1e9;
  for (const auto& c : candidates) {
    double s = score_candidate(c, cleanA, cleanT, duration);
    if (s > maxScore) {
      maxScore = s;
      best = &c;
    }
  }
  return *best;
}

nlohmann::json HttpClient::import_playlist_from_url(const std::string& raw_url, const std::wstring& ytdlp_path) {
  std::string url = trim_copy(raw_url);
  if (url.empty()) throw std::runtime_error("URL cannot be empty");
  if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0) url = "https://" + url;

  // 1. Spotify Embed __NEXT_DATA__
  if (url.find("spotify.com") != std::string::npos) {
    std::string embed = url;
    auto pos = embed.find("open.spotify.com/");
    if (pos != std::string::npos && embed.find("/embed/") == std::string::npos) {
      embed.replace(pos, std::string("open.spotify.com/").size(), "open.spotify.com/embed/");
    }
    auto r = request("GET", embed, "", {}, 12000);
    if (!r.ok()) throw std::runtime_error("Spotify fetch failed (" + std::to_string(r.status) + ")");
    auto start_tag = r.body.find("id=\"__NEXT_DATA__\"");
    if (start_tag == std::string::npos) throw std::runtime_error("Could not parse Spotify playlist");
    auto json_start = r.body.find('>', start_tag);
    auto json_end = r.body.find("</script>", json_start);
    if (json_start == std::string::npos || json_end == std::string::npos) throw std::runtime_error("Malformed Spotify response");
    auto parsed = nlohmann::json::parse(r.body.substr(json_start + 1, json_end - json_start - 1));
    const auto& entity = parsed["props"]["pageProps"]["state"]["data"]["entity"];
    std::string plName = trim_copy(entity.value("name", "Spotify Playlist"));
    nlohmann::json tracks = nlohmann::json::array();
    if (entity.contains("trackList") && entity["trackList"].is_array()) {
      for (const auto& t : entity["trackList"]) {
        std::string tArtist = t.value("subtitle", "Unknown");
        std::string tTitle = t.value("title", "Unknown");
        if (tTitle.empty() || tTitle == "Unknown") continue;
        tracks.push_back({
            {"id", "yt:ytsearch:" + url_encode(tArtist + " - " + tTitle)},
            {"title", tTitle},
            {"artist", tArtist},
            {"album", ""},
            {"artwork", ""},
            {"duration", static_cast<int>(std::round(t.value("duration", 0.0) / 1000.0))},
            {"source", "youtube"}
        });
      }
    }
    return {{"name", "Spotify: " + plName}, {"tracks", tracks}};
  }

  // 2. Yandex Music fast handlers
  if (url.find("music.yandex.") != std::string::npos || url.find("yandex.ru") != std::string::npos) {
    static const std::regex pl_re(R"(/users/([^/?#]+)/playlists/(\d+))");
    static const std::regex alb_re(R"(/album/(\d+))");
    std::smatch m;
    nlohmann::json tracks = nlohmann::json::array();
    std::string plName = "Яндекс Музыка";

    auto make_yandex_track = [&](const std::string& tTitle, const std::string& tArtist, int dur, const std::string& art, const std::string& alb) {
      return nlohmann::json{
          {"id", "yt:ytsearch:" + url_encode(tArtist + " - " + tTitle)},
          {"title", tTitle},
          {"artist", tArtist},
          {"album", alb},
          {"artwork", art},
          {"duration", dur},
          {"source", "youtube"}
      };
    };

    if (std::regex_search(url, m, pl_re)) {
      std::string handler = "https://music.yandex.ru/handlers/playlist.jsx?owner=" + m[1].str() + "&kinds=" + m[2].str();
      auto r = request("GET", handler, "", {{"X-Retpath-Y", "https://music.yandex.ru"}, {"Accept", "application/json"}}, 12000);
      if (r.ok()) {
        try {
          auto data = nlohmann::json::parse(r.body);
          if (data.contains("playlist")) {
            const auto& pl = data["playlist"];
            plName = "Яндекс: " + pl.value("title", "Плейлист");
            for (const auto& t : pl["tracks"]) {
              std::string title = t.value("title", "");
              if (title.empty()) continue;
              std::string artists;
              if (t.contains("artists") && t["artists"].is_array()) {
                for (const auto& a : t["artists"]) {
                  std::string n = a.value("name", "");
                  if (!n.empty()) { if (!artists.empty()) artists += ", "; artists += n; }
                }
              }
              if (artists.empty()) artists = "Unknown";
              std::string cov = t.value("coverUri", "");
              std::string art;
              if (!cov.empty()) {
                auto p = cov.find("%%");
                if (p != std::string::npos) cov.replace(p, 2, "400x400");
                art = "https://" + cov;
              }
              tracks.push_back(make_yandex_track(title, artists, static_cast<int>(std::round(t.value("durationMs", 0.0) / 1000.0)), art, ""));
            }
          }
        } catch (...) {}
      }
    } else if (std::regex_search(url, m, alb_re)) {
      std::string handler = "https://music.yandex.ru/handlers/album.jsx?album=" + m[1].str();
      auto r = request("GET", handler, "", {{"X-Retpath-Y", "https://music.yandex.ru"}, {"Accept", "application/json"}}, 12000);
      if (r.ok()) {
        try {
          auto data = nlohmann::json::parse(r.body);
          std::string albTitle = data.value("title", "Альбом");
          plName = "Яндекс: " + albTitle;
          std::string albCov = data.value("coverUri", "");
          auto extract_tracks = [&](const nlohmann::json& arr) {
            for (const auto& t : arr) {
              std::string title = t.value("title", "");
              if (title.empty()) continue;
              std::string artists;
              if (t.contains("artists") && t["artists"].is_array()) {
                for (const auto& a : t["artists"]) {
                  std::string n = a.value("name", "");
                  if (!n.empty()) { if (!artists.empty()) artists += ", "; artists += n; }
                }
              }
              if (artists.empty()) artists = "Unknown";
              std::string cov = t.value("coverUri", albCov);
              std::string art;
              if (!cov.empty()) {
                auto p = cov.find("%%");
                if (p != std::string::npos) cov.replace(p, 2, "400x400");
                art = "https://" + cov;
              }
              tracks.push_back(make_yandex_track(title, artists, static_cast<int>(std::round(t.value("durationMs", 0.0) / 1000.0)), art, albTitle));
            }
          };
          if (data.contains("volumes") && data["volumes"].is_array()) {
            for (const auto& vol : data["volumes"]) {
              if (vol.is_array()) extract_tracks(vol);
            }
          }
        } catch (...) {}
      }
    }
    if (!tracks.empty()) return {{"name", plName}, {"tracks", tracks}};
    throw std::runtime_error("Не удалось загрузить открытый плейлист Яндекс Музыки");
  }

  // 3. YouTube Playlist via Innertube browse -> fallback yt-dlp
  static const std::regex yt_list_re(R"([?&]list=([A-Za-z0-9_-]+))");
  std::smatch lm;
  if (std::regex_search(url, lm, yt_list_re)) {
    nlohmann::json payload = {
        {"context", {{"client", {{"clientName", "WEB"}, {"clientVersion", "2.20240601.00.00"}, {"hl", "ru"}, {"gl", "RU"}}}}},
        {"browseId", "VL" + lm[1].str()}
    };
    auto r = request("POST", "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false", payload.dump(),
                     {{"Content-Type", "application/json"}, {"Accept", "application/json"}}, 12000);
    if (r.ok()) {
      try {
        auto d = nlohmann::json::parse(r.body);
        std::string plTitle = d["header"]["playlistHeaderRenderer"]["title"].value("simpleText", "YouTube Playlist");
        nlohmann::json tracks = nlohmann::json::array();
        const auto& tabs = d["contents"]["twoColumnBrowseResultsRenderer"]["tabs"];
        if (tabs.is_array() && !tabs.empty()) {
          const auto& items = tabs[0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"][0]["itemSectionRenderer"]["contents"][0]["playlistVideoListRenderer"]["contents"];
          if (items.is_array()) {
            for (const auto& it : items) {
              if (!it.contains("playlistVideoRenderer")) continue;
              const auto& pv = it["playlistVideoRenderer"];
              std::string vid = pv.value("videoId", "");
              if (vid.empty()) continue;
              std::string tTitle = pv["title"]["runs"][0].value("text", "Unknown");
              std::string tArt = pv["shortBylineText"]["runs"][0].value("text", "YouTube");
              std::string thumb = pv["thumbnail"]["thumbnails"].back().value("url", "");
              int dur = 0;
              try { dur = std::stoi(pv.value("lengthSeconds", "0")); } catch (...) {}
              tracks.push_back({{"id", "yt:" + vid}, {"title", tTitle}, {"artist", tArt}, {"album", ""}, {"artwork", thumb}, {"duration", dur}, {"source", "youtube"}});
            }
          }
        }
        if (!tracks.empty()) return {{"name", "YouTube: " + plTitle}, {"tracks", tracks}};
      } catch (...) {}
    }
  }

  if (!ytdlp_path.empty()) {
    std::string out = run_ytdlp(ytdlp_path, {L"--flat-playlist", L"--dump-single-json", utf8_to_wide(url)}, 40000);
    if (!out.empty()) {
      auto d = nlohmann::json::parse(out);
      std::string title = d.value("title", "YouTube Playlist");
      nlohmann::json tracks = nlohmann::json::array();
      if (d.contains("entries") && d["entries"].is_array()) {
        for (const auto& e : d["entries"]) {
          std::string id = e.value("id", "");
          std::string t = e.value("title", "");
          if (id.empty() || t == "[Private video]" || t == "[Deleted video]") continue;
          tracks.push_back({
              {"id", "yt:" + id},
              {"title", t},
              {"artist", e.value("uploader", e.value("channel", "YouTube"))},
              {"album", ""},
              {"artwork", (e.contains("thumbnails") && !e["thumbnails"].empty()) ? e["thumbnails"][0].value("url", "") : ""},
              {"duration", e.value("duration", 0)},
              {"source", "youtube"}
          });
        }
      }
      if (!tracks.empty()) return {{"name", "YouTube: " + title}, {"tracks", tracks}};
    }
  }

  throw std::runtime_error("No tracks found in playlist URL");
}

}  // namespace mintpy

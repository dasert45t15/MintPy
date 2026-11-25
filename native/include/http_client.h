#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>
#include "json.hpp"

namespace mintpy {

struct HttpResponse {
  int status = 0;
  std::string body;
  std::map<std::string, std::string> headers;
  bool ok() const { return status >= 200 && status < 400; }
};

struct ResolvedStream {
  std::string url;
  std::string user_agent;
  bool ok() const { return !url.empty(); }
};

class HttpClient {
 public:
  static HttpResponse request(
      const std::string& method,
      const std::string& url,
      const std::string& body = "",
      const std::map<std::string, std::string>& headers = {},
      int timeout_ms = 12000);

  // Streams an upstream URL (e.g. YouTube audio CDN) directly via WinHTTP callbacks
  static bool stream_url(
      const std::string& url,
      const std::string& range_header,
      const std::function<bool(int status, const std::map<std::string, std::string>& headers)>& on_headers,
      const std::function<bool(const char* data, size_t len)>& on_chunk,
      const std::string& user_agent = "",
      const std::string& method = "GET");

  // Fast YouTube Innertube Search
  static nlohmann::json youtube_search(const std::string& query, int max_results = 20);

  // Thread-safe single-flight cached YouTube stream resolver (yt-dlp -> Innertube fallback)
  static ResolvedStream resolve_youtube_stream(const std::string& video_id_or_search, const std::wstring& ytdlp_path = L"");
  static void invalidate_youtube_stream(const std::string& video_id_or_search);

  // Smart resolver for placeholder tracks (yt:ytsearch:...)
  static nlohmann::json resolve_search_track(const std::string& artist, const std::string& title, double duration = 0);

  // Import playlists from Spotify, YouTube / YouTube Music, or Yandex Music
  static nlohmann::json import_playlist_from_url(const std::string& url, const std::wstring& ytdlp_path = L"");

  // Run yt-dlp process silently if needed as fallback
  static std::string run_ytdlp(const std::wstring& ytdlp_path, const std::vector<std::wstring>& args, int timeout_ms = 20000);
};

}  // namespace mintpy

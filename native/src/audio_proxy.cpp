#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>

#include "audio_proxy.h"
#include "http_client.h"
#include "utf_util.h"

#include <bcrypt.h>
#include <fstream>
#include <regex>
#include <sstream>

namespace mintpy {

namespace {

std::string generate_hex_token(size_t bytes = 24) {
  std::vector<unsigned char> buf(bytes);
  BCryptGenRandom(nullptr, buf.data(), static_cast<ULONG>(buf.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  static const char hex[] = "0123456789abcdef";
  std::string out(bytes * 2, '0');
  for (size_t i = 0; i < bytes; ++i) {
    out[i * 2] = hex[(buf[i] >> 4) & 0xF];
    out[i * 2 + 1] = hex[buf[i] & 0xF];
  }
  return out;
}

bool send_all(SOCKET s, const char* data, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    int n = send(s, data + sent, static_cast<int>((std::min<size_t>)(len - sent, 65536)), 0);
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

std::string mime_for_ext(const std::filesystem::path& p) {
  std::string ext = to_lower_ascii(wide_to_utf8(p.extension().wstring()));
  if (ext == ".flac") return "audio/flac";
  if (ext == ".ogg") return "audio/ogg";
  if (ext == ".m4a" || ext == ".mp4") return "audio/mp4";
  if (ext == ".wav") return "audio/wav";
  if (ext == ".aac") return "audio/aac";
  return "audio/mpeg";
}

std::map<std::string, std::string> parse_query_params(const std::string& qs) {
  std::map<std::string, std::string> out;
  std::istringstream iss(qs);
  std::string pair;
  while (std::getline(iss, pair, '&')) {
    auto eq = pair.find('=');
    if (eq == std::string::npos) continue;
    out[url_decode(pair.substr(0, eq))] = url_decode(pair.substr(eq + 1));
  }
  return out;
}

std::string common_cors_headers() {
  return "Access-Control-Allow-Origin: *\r\n"
         "Access-Control-Allow-Private-Network: true\r\n"
         "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
         "Access-Control-Allow-Headers: Range, Content-Type\r\n"
         "Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\n";
}

void send_error(SOCKET s, int code, const std::string& msg) {
  std::ostringstream oss;
  oss << "HTTP/1.1 " << code << " Error\r\n"
      << common_cors_headers()
      << "Content-Length: " << msg.size() << "\r\nConnection: close\r\n\r\n"
      << msg;
  auto str = oss.str();
  send_all(s, str.data(), str.size());
}

}  // namespace

AudioProxy::AudioProxy(std::unordered_set<std::wstring>& allowed_files, std::mutex& allowed_mutex, std::wstring ytdlp_path)
    : allowed_files_(allowed_files), allowed_mutex_(allowed_mutex), ytdlp_path_(std::move(ytdlp_path)) {
  token_ = generate_hex_token(24);
}

AudioProxy::~AudioProxy() {
  stop();
}

bool AudioProxy::start() {
  if (running_.load()) return true;
  WSADATA wsa{};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;

  SOCKET sock = INVALID_SOCKET;
  static const int candidate_ports[] = {3737, 3738, 3739, 3740, 0};
  for (int candidate : candidate_ports) {
    sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) continue;
    BOOL reuse = TRUE;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<u_short>(candidate));
    if (bind(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0 && listen(sock, SOMAXCONN) == 0) {
      int len = sizeof(addr);
      if (getsockname(sock, reinterpret_cast<sockaddr*>(&addr), &len) == 0) {
        port_.store(ntohs(addr.sin_port));
      }
      break;
    }
    closesocket(sock);
    sock = INVALID_SOCKET;
  }
  if (sock == INVALID_SOCKET) return false;

  listen_sock_ = static_cast<uintptr_t>(sock);
  running_.store(true);
  accept_thread_ = std::thread(&AudioProxy::accept_loop, this);
  return true;
}

void AudioProxy::stop() {
  if (!running_.exchange(false)) return;
  if (listen_sock_ != ~uintptr_t(0)) {
    closesocket(static_cast<SOCKET>(listen_sock_));
    listen_sock_ = ~uintptr_t(0);
  }
  if (accept_thread_.joinable()) accept_thread_.join();
  WSACleanup();
}

void AudioProxy::accept_loop() {
  SOCKET lsock = static_cast<SOCKET>(listen_sock_);
  while (running_.load()) {
    SOCKET csock = accept(lsock, nullptr, nullptr);
    if (csock == INVALID_SOCKET) break;
    std::thread(&AudioProxy::handle_client, this, static_cast<uintptr_t>(csock)).detach();
  }
}

void AudioProxy::handle_client(uintptr_t client_sock) {
  SOCKET s = static_cast<SOCKET>(client_sock);
  DWORD rcv_to = 15000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&rcv_to), sizeof(rcv_to));

  std::string raw_req;
  char buf[4096];
  while (raw_req.find("\r\n\r\n") == std::string::npos && raw_req.size() < 32768) {
    int n = recv(s, buf, sizeof(buf), 0);
    if (n <= 0) break;
    raw_req.append(buf, static_cast<size_t>(n));
  }
  auto hdr_end = raw_req.find("\r\n\r\n");
  if (hdr_end == std::string::npos) { closesocket(s); return; }

  std::istringstream iss(raw_req.substr(0, hdr_end));
  std::string method, target, proto;
  iss >> method >> target >> proto;

  std::map<std::string, std::string> headers;
  std::string line;
  std::getline(iss, line);
  while (std::getline(iss, line)) {
    auto col = line.find(':');
    if (col == std::string::npos) continue;
    headers[to_lower_ascii(trim_copy(line.substr(0, col)))] = trim_copy(line.substr(col + 1));
  }

  if (method == "OPTIONS") {
    std::string resp = "HTTP/1.1 204 No Content\r\n" + common_cors_headers() + "Connection: close\r\n\r\n";
    send_all(s, resp.data(), resp.size());
    closesocket(s);
    return;
  }

  std::string pathname = target, qs;
  auto qpos = target.find('?');
  if (qpos != std::string::npos) {
    pathname = target.substr(0, qpos);
    qs = target.substr(qpos + 1);
  }
  auto params = parse_query_params(qs);
  if (params["t"] != token_) {
    send_error(s, 403, "Forbidden");
    closesocket(s);
    return;
  }

  if (pathname == "/local") {
    std::string file_utf8 = params["path"];
    if (file_utf8.empty()) { send_error(s, 400, "Missing path"); closesocket(s); return; }
    std::error_code ec;
    std::filesystem::path resolved = std::filesystem::weakly_canonical(utf8_to_wide(file_utf8), ec);
    bool allowed = false;
    {
      std::lock_guard lk(allowed_mutex_);
      allowed = !ec && allowed_files_.count(resolved.wstring()) > 0;
    }
    if (!allowed || !std::filesystem::exists(resolved, ec)) {
      send_error(s, 403, "Path not allowed");
      closesocket(s);
      return;
    }
    uint64_t total = std::filesystem::file_size(resolved, ec);
    std::ifstream ifs(resolved, std::ios::binary);
    if (!ifs.good()) { send_error(s, 404, "Not found"); closesocket(s); return; }

    std::string ctype = mime_for_ext(resolved);
    uint64_t start = 0, end = total > 0 ? total - 1 : 0;
    bool has_range = false;
    auto rit = headers.find("range");
    if (rit != headers.end() && rit->second.rfind("bytes=", 0) == 0 && total > 0) {
      std::string r = rit->second.substr(6);
      auto dash = r.find('-');
      if (dash != std::string::npos) {
        std::string s1 = trim_copy(r.substr(0, dash));
        std::string s2 = trim_copy(r.substr(dash + 1));
        try {
          if (!s1.empty()) start = std::stoull(s1);
          if (!s2.empty()) end = std::stoull(s2);
          has_range = true;
        } catch (...) {}
      }
    }
    if (start >= total && total > 0) {
      send_error(s, 416, "Range Not Satisfiable");
      closesocket(s);
      return;
    }
    if (end >= total && total > 0) end = total - 1;
    uint64_t content_len = (total > 0 && end >= start) ? (end - start + 1) : 0;

    std::ostringstream hdr;
    hdr << (has_range ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n")
        << common_cors_headers()
        << "Content-Type: " << ctype << "\r\n"
        << "Accept-Ranges: bytes\r\n"
        << "Content-Length: " << content_len << "\r\n";
    if (has_range) {
      hdr << "Content-Range: bytes " << start << "-" << end << "/" << total << "\r\n";
    }
    hdr << "Connection: close\r\n\r\n";
    auto hstr = hdr.str();
    if (!send_all(s, hstr.data(), hstr.size())) { closesocket(s); return; }

    if (method != "HEAD" && content_len > 0) {
      ifs.seekg(static_cast<std::streamoff>(start), std::ios::beg);
      std::vector<char> chunk(65536);
      uint64_t remaining = content_len;
      while (remaining > 0 && ifs.good()) {
        std::streamsize to_read = static_cast<std::streamsize>((std::min<uint64_t>)(remaining, chunk.size()));
        ifs.read(chunk.data(), to_read);
        std::streamsize got = ifs.gcount();
        if (got <= 0) break;
        if (!send_all(s, chunk.data(), static_cast<size_t>(got))) break;
        remaining -= static_cast<uint64_t>(got);
      }
    }
    closesocket(s);
    return;
  }

  if (pathname == "/youtube") {
    std::string vid = params["v"];
    static const std::regex id_re(R"(^[A-Za-z0-9_-]{6,20}$)");
    bool is_search = (vid.rfind("ytsearch:", 0) == 0);
    if (vid.empty() || (!is_search && !std::regex_match(vid, id_re))) {
      send_error(s, 400, "Invalid video id");
      closesocket(s);
      return;
    }

    std::string range_hdr;
    auto rit = headers.find("range");
    if (rit != headers.end()) range_hdr = rit->second;

    bool sent_headers = false;
    bool ok = false;
    int last_status = 0;

    for (int attempt = 0; attempt < 2; ++attempt) {
      if (attempt > 0) HttpClient::invalidate_youtube_stream(vid);
      ResolvedStream rs = HttpClient::resolve_youtube_stream(vid, ytdlp_path_);
      if (!rs.ok()) {
        if (attempt == 0) continue;
        send_error(s, 502, "No stream URL resolved");
        closesocket(s);
        return;
      }

      last_status = 0;
      ok = HttpClient::stream_url(
          rs.url,
          range_hdr,
          [&](int status, const std::map<std::string, std::string>& up_hdrs) -> bool {
            last_status = status;
            if (status < 200 || status >= 400) {
              return false;
            }
            std::ostringstream oss;
            oss << "HTTP/1.1 " << status << (status == 206 ? " Partial Content" : " OK") << "\r\n"
                << common_cors_headers();
            bool has_accept_ranges = false;
            for (const char* k : {"content-type", "content-length", "content-range", "accept-ranges"}) {
              auto it = up_hdrs.find(k);
              if (it != up_hdrs.end()) {
                oss << k << ": " << it->second << "\r\n";
                if (std::string(k) == "accept-ranges") has_accept_ranges = true;
              }
            }
            if (!has_accept_ranges) oss << "accept-ranges: bytes\r\n";
            oss << "Connection: close\r\n\r\n";
            auto h = oss.str();
            sent_headers = send_all(s, h.data(), h.size());
            return sent_headers;
          },
          [&](const char* data, size_t len) -> bool {
            if (!sent_headers) return false;
            return send_all(s, data, len);
          },
          rs.user_agent,
          method);

      if (sent_headers || ok) break;
      if (last_status != 403 && last_status != 410 && last_status < 500 && last_status != 0) break;
    }

    if (!sent_headers) {
      send_error(s, last_status >= 400 ? last_status : 502, "Upstream stream failed");
    }
    closesocket(s);
    return;
  }

  send_error(s, 404, "Not found");
  closesocket(s);
}

}  // namespace mintpy

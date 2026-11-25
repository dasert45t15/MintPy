#pragma once

#include <atomic>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>

namespace mintpy {

class AudioProxy {
 public:
  AudioProxy(std::unordered_set<std::wstring>& allowed_files, std::mutex& allowed_mutex, std::wstring ytdlp_path = L"");
  ~AudioProxy();

  bool start();
  void stop();

  int port() const { return port_.load(); }
  std::string token() const { return token_; }
  std::string base_url() const { return "http://127.0.0.1:" + std::to_string(port_.load()); }

 private:
  void accept_loop();
  void handle_client(uintptr_t client_sock);

  std::unordered_set<std::wstring>& allowed_files_;
  std::mutex& allowed_mutex_;
  std::wstring ytdlp_path_;

  std::string token_;
  std::atomic<int> port_{3737};
  std::atomic<bool> running_{false};
  uintptr_t listen_sock_{~uintptr_t(0)};
  std::thread accept_thread_;
};

}  // namespace mintpy

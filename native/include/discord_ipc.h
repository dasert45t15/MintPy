#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include "json.hpp"

namespace mintpy {

// Native C++ Discord Rich Presence client over Windows Named Pipe (\\.\pipe\discord-ipc-0..9)
class DiscordIpc {
 public:
  explicit DiscordIpc(std::string client_id = "1343602498263548004");
  ~DiscordIpc();

  void set_enabled(bool enabled);
  void set_activity(const nlohmann::json& activity);
  void stop();

 private:
  void worker_loop();
  bool connect_pipe();
  void disconnect_pipe();
  bool write_frame(uint32_t opcode, const std::string& payload);
  void send_activity_locked();

  std::string client_id_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool enabled_{true};
  bool dirty_{false};
  nlohmann::json current_activity_ = nlohmann::json::object();
  std::atomic<bool> stop_{false};
  void* pipe_{reinterpret_cast<void*>(~uintptr_t(0))};  // INVALID_HANDLE_VALUE
  uint64_t nonce_{1};
  std::thread thread_;
};

}  // namespace mintpy

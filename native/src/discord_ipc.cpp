#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include "discord_ipc.h"
#include "json_safe.h"
#include <chrono>
#include <cstring>

namespace mintpy {

DiscordIpc::DiscordIpc(std::string client_id) : client_id_(std::move(client_id)) {
  thread_ = std::thread(&DiscordIpc::worker_loop, this);
}

DiscordIpc::~DiscordIpc() {
  stop();
}

void DiscordIpc::stop() {
  if (stop_.exchange(true)) return;
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
  std::lock_guard lk(mutex_);
  disconnect_pipe();
}

void DiscordIpc::set_enabled(bool enabled) {
  {
    std::lock_guard lk(mutex_);
    enabled_ = enabled;
    dirty_ = true;
  }
  cv_.notify_one();
}

void DiscordIpc::set_activity(const nlohmann::json& activity) {
  {
    std::lock_guard lk(mutex_);
    current_activity_ = activity;
    dirty_ = true;
  }
  cv_.notify_one();
}

bool DiscordIpc::connect_pipe() {
  if (pipe_ != INVALID_HANDLE_VALUE) return true;
  for (int i = 0; i < 10; ++i) {
    std::string pipe_name = "\\\\.\\pipe\\discord-ipc-" + std::to_string(i);
    HANDLE h = CreateFileA(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      pipe_ = h;
      nlohmann::json handshake = {{"v", 1}, {"client_id", client_id_}};
      if (!write_frame(0, handshake.dump())) {
        disconnect_pipe();
        return false;
      }
      // Drain handshake response if available without blocking forever
      DWORD avail = 0;
      for (int wait = 0; wait < 10; ++wait) {
        if (PeekNamedPipe(h, nullptr, 0, nullptr, &avail, nullptr) && avail >= 8) {
          char hdr[8]{};
          DWORD rd = 0;
          ReadFile(h, hdr, 8, &rd, nullptr);
          uint32_t len = 0;
          std::memcpy(&len, hdr + 4, 4);
          if (len > 0 && len < 65536) {
            std::string dump(len, '\0');
            ReadFile(h, dump.data(), len, &rd, nullptr);
          }
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
      return true;
    }
  }
  return false;
}

void DiscordIpc::disconnect_pipe() {
  if (pipe_ != INVALID_HANDLE_VALUE) {
    CloseHandle(static_cast<HANDLE>(pipe_));
    pipe_ = INVALID_HANDLE_VALUE;
  }
}

bool DiscordIpc::write_frame(uint32_t opcode, const std::string& payload) {
  if (pipe_ == INVALID_HANDLE_VALUE) return false;
  uint32_t header[2] = {opcode, static_cast<uint32_t>(payload.size())};
  std::string packet;
  packet.resize(8 + payload.size());
  std::memcpy(packet.data(), header, 8);
  if (!payload.empty()) std::memcpy(packet.data() + 8, payload.data(), payload.size());
  DWORD written = 0;
  return WriteFile(static_cast<HANDLE>(pipe_), packet.data(), static_cast<DWORD>(packet.size()), &written, nullptr) != FALSE;
}

void DiscordIpc::send_activity_locked() {
  if (!enabled_) {
    if (pipe_ != INVALID_HANDLE_VALUE) {
      nlohmann::json clr = {{"cmd", "SET_ACTIVITY"}, {"args", {{"pid", GetCurrentProcessId()}}}, {"nonce", std::to_string(nonce_++)}};
      write_frame(1, clr.dump());
      disconnect_pipe();
    }
    return;
  }

  if (pipe_ == INVALID_HANDLE_VALUE && !connect_pipe()) return;

  std::string title = jstr(current_activity_, "title", "");
  std::string artist = jstr(current_activity_, "artist", "");
  std::string style = jstr(current_activity_, "style", "zen");
  double dur = jnum(current_activity_, "duration", 0.0);
  double pos = jnum(current_activity_, "position", 0.0);
  bool is_playing = jbool(current_activity_, "isPlaying", false);

  nlohmann::json act;
  if (title.empty()) {
    act = {
        {"details", "В медитации"},
        {"state", "Стиль: " + style},
        {"assets", {{"large_image", "mintpy_logo"}, {"large_text", "MintPy — Дзэн-плеер"}}},
        {"instance", false}
    };
  } else {
    act = {
        {"details", title.substr(0, 128)},
        {"state", (!artist.empty() ? ("от " + artist) : ("Стиль: " + style)).substr(0, 128)},
        {"assets", {
            {"large_image", "mintpy_logo"},
            {"large_text", "MintPy v5.3.8 — Дзэн-плеер"},
            {"small_image", is_playing ? "play" : "pause"},
            {"small_text", is_playing ? "Воспроизведение" : "Пауза"}
        }},
        {"instance", false}
    };
    auto now_s = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    long long pos_s = static_cast<long long>(pos > 0 ? pos : 0);
    if (is_playing && dur > 0) {
      act["timestamps"] = {{"start", now_s - pos_s}, {"end", now_s - pos_s + static_cast<long long>(dur)}};
    } else if (is_playing) {
      act["timestamps"] = {{"start", now_s - pos_s}};
    }
  }

  nlohmann::json frame = {
      {"cmd", "SET_ACTIVITY"},
      {"args", {{"pid", GetCurrentProcessId()}, {"activity", act}}},
      {"nonce", std::to_string(nonce_++)}
  };
  if (!write_frame(1, frame.dump())) {
    disconnect_pipe();
  }
}

void DiscordIpc::worker_loop() {
  while (!stop_.load()) {
    std::unique_lock lk(mutex_);
    cv_.wait_for(lk, std::chrono::seconds(15), [&]() { return dirty_ || stop_.load(); });
    if (stop_.load()) break;
    dirty_ = false;
    try {
      if (enabled_ || pipe_ != INVALID_HANDLE_VALUE) {
        send_activity_locked();
      }
    } catch (...) {}
  }
}

}  // namespace mintpy

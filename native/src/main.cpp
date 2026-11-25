#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <regex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "WebView2.h"
#include "audio_proxy.h"
#include "com_helpers.h"
#include "data_store.h"
#include "discord_ipc.h"
#include "http_client.h"
#include "js_bridge.h"
#include "json_safe.h"
#include "json.hpp"
#include "tag_scanner.h"
#include "utf_util.h"
#include "win_helpers.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClass[] = L"MintPyNativeWindowClass";
constexpr wchar_t kMutexName[] = L"Local\\MintPyNativeSingleInstanceMutex";
constexpr UINT WM_MINTPY_POST_JSON = WM_APP + 1;
constexpr UINT WM_MINTPY_TRAY = WM_APP + 2;
constexpr UINT WM_MINTPY_EXEC_UI = WM_APP + 3;

constexpr int HK_MEDIA_PLAY_PAUSE = 100;
constexpr int HK_MEDIA_NEXT = 101;
constexpr int HK_MEDIA_PREV = 102;
constexpr int HK_GLOBAL_MUTE = 200;

constexpr int TRAY_ID_OPEN = 1001;
constexpr int TRAY_ID_PLAYPAUSE = 1002;
constexpr int TRAY_ID_NEXT = 1003;
constexpr int TRAY_ID_PREV = 1004;
constexpr int TRAY_ID_EXIT = 1005;

struct AppState {
  HWND hwnd = nullptr;
  HICON hIconBig = nullptr;
  HICON hIconSmall = nullptr;
  NOTIFYICONDATAW nid{};
  bool tray_added = false;
  bool is_quitting = false;

  std::filesystem::path app_root;
  std::filesystem::path user_data_dir;
  std::filesystem::path covers_dir;
  std::filesystem::path pets_dir;
  std::wstring ytdlp_path;

  std::mutex allowed_mutex;
  std::unordered_set<std::wstring> allowed_roots;
  std::unordered_set<std::wstring> allowed_local_files;

  std::unique_ptr<mintpy::DataStore> store;
  std::unique_ptr<mintpy::AudioProxy> proxy;
  std::unique_ptr<mintpy::DiscordIpc> discord;

  ComPtr<ICoreWebView2Environment> wv_env;
  ComPtr<ICoreWebView2Controller> wv_ctrl;
  ComPtr<ICoreWebView2> webview;
  HMODULE wv_loader_mod = nullptr;

  bool is_mini_mode = false;
  RECT normal_bounds{0, 0, 1360, 860};
  bool mute_hotkey_registered = false;
};

AppState* g_app = nullptr;

void post_json_to_js(const nlohmann::json& msg) {
  if (!g_app || !g_app->hwnd) return;
  auto* payload = new std::wstring(mintpy::utf8_to_wide(msg.dump()));
  if (!PostMessageW(g_app->hwnd, WM_MINTPY_POST_JSON, 0, reinterpret_cast<LPARAM>(payload))) {
    delete payload;
  }
}

void emit_event(const std::string& event, const nlohmann::json& payload = nullptr) {
  post_json_to_js({{"event", event}, {"payload", payload}});
}

void run_on_ui(std::function<void()> fn) {
  if (!g_app || !g_app->hwnd) return;
  auto* ptr = new std::function<void()>(std::move(fn));
  if (!PostMessageW(g_app->hwnd, WM_MINTPY_EXEC_UI, 0, reinterpret_cast<LPARAM>(ptr))) {
    delete ptr;
  }
}

bool valid_pet_filename(const std::string& name) {
  static const std::regex pet_re(R"(^pet_[A-Za-z0-9_-]+\.(png|gif|jpe?g|webp)$)", std::regex::icase);
  return !name.empty() && name.size() < 120 && std::regex_match(name, pet_re);
}

void hydrate_allowed_files() {
  auto lib = g_app->store->get_library();
  std::vector<std::filesystem::path> roots;
  std::error_code ec;
  {
    std::lock_guard lk(g_app->allowed_mutex);
    if (lib.contains("folders") && lib["folders"].is_array()) {
      for (const auto& f : lib["folders"]) {
        if (!f.is_string()) continue;
        auto p = std::filesystem::weakly_canonical(mintpy::utf8_to_wide(f.get<std::string>()), ec);
        if (!ec) {
          g_app->allowed_roots.insert(p.wstring());
          roots.push_back(p);
        }
      }
    }
  }

  auto collect_tracks = [&](const nlohmann::json& arr) {
    if (!arr.is_array()) return;
    for (const auto& t : arr) {
      if (!t.is_object() || t.value("source", "") != "local") continue;
      std::string fp = t.value("filepath", "");
      if (fp.empty()) continue;
      std::filesystem::path p(mintpy::utf8_to_wide(fp));
      if (!mintpy::TagScanner::is_audio_file(p)) continue;
      auto canon = std::filesystem::weakly_canonical(p, ec);
      if (ec || !std::filesystem::is_regular_file(canon, ec)) continue;
      bool inside = false;
      for (const auto& r : roots) {
        if (mintpy::path_is_inside(canon, r)) { inside = true; break; }
      }
      if (inside) {
        std::lock_guard lk(g_app->allowed_mutex);
        g_app->allowed_local_files.insert(canon.wstring());
      }
    }
  };

  collect_tracks(lib.value("tracks", nlohmann::json::array()));
  collect_tracks(g_app->store->get_favorites());
  collect_tracks(g_app->store->get_history());
  auto pb = g_app->store->get_playback_state();
  collect_tracks(pb.value("queue", nlohmann::json::array()));
}

void update_window_geometry() {
  if (!g_app || !g_app->hwnd || !g_app->wv_ctrl) return;
  RECT rc{};
  GetClientRect(g_app->hwnd, &rc);
  g_app->wv_ctrl->put_Bounds(rc);
}

void show_main_window() {
  if (!g_app || !g_app->hwnd) return;
  if (IsIconic(g_app->hwnd)) ShowWindow(g_app->hwnd, SW_RESTORE);
  ShowWindow(g_app->hwnd, SW_SHOW);
  SetForegroundWindow(g_app->hwnd);
}

void apply_native_window_frame(HWND hwnd);

void set_mini_mode(bool enable) {
  if (!g_app || !g_app->hwnd || enable == g_app->is_mini_mode) return;
  if (enable) {
    GetWindowRect(g_app->hwnd, &g_app->normal_bounds);
    if (IsZoomed(g_app->hwnd)) ShowWindow(g_app->hwnd, SW_RESTORE);
    g_app->is_mini_mode = true;
    HMONITOR hMon = MonitorFromRect(&g_app->normal_bounds, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{sizeof(mi)};
    GetMonitorInfoW(hMon, &mi);
    int w = 460, h = 138;
    int x = (std::min<int>)(g_app->normal_bounds.left, mi.rcWork.right - w - 24);
    int y = (std::min<int>)(g_app->normal_bounds.top, mi.rcWork.bottom - h - 24);
    SetWindowPos(g_app->hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED);
    apply_native_window_frame(g_app->hwnd);
    emit_event("window:mini-mode-changed", true);
  } else {
    g_app->is_mini_mode = false;
    int w = (std::max<int>)(980, g_app->normal_bounds.right - g_app->normal_bounds.left);
    int h = (std::max<int>)(680, g_app->normal_bounds.bottom - g_app->normal_bounds.top);
    SetWindowPos(g_app->hwnd, HWND_NOTOPMOST, g_app->normal_bounds.left, g_app->normal_bounds.top, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED);
    apply_native_window_frame(g_app->hwnd);
    emit_event("window:mini-mode-changed", false);
  }
}

void apply_window_opacity(double v) {
  if (!g_app || !g_app->hwnd) return;
  double clamped = std::clamp(v, 0.05, 1.0);
  LONG_PTR ex = GetWindowLongPtrW(g_app->hwnd, GWL_EXSTYLE);
  if (clamped < 0.999) {
    if (!(ex & WS_EX_LAYERED)) SetWindowLongPtrW(g_app->hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
    SetLayeredWindowAttributes(g_app->hwnd, 0, static_cast<BYTE>(clamped * 255.0), LWA_ALPHA);
  } else if (ex & WS_EX_LAYERED) {
    SetWindowLongPtrW(g_app->hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);
  }
}

void handle_ipc_call(int id, const std::string& op, const nlohmann::json& args, std::vector<std::filesystem::path> extra_files = {}) {
  auto reply_ok = [&](const nlohmann::json& res) {
    if (id > 0) post_json_to_js({{"id", id}, {"ok", true}, {"result", res}});
  };
  auto reply_err = [&](const std::string& err) {
    if (id > 0) post_json_to_js({{"id", id}, {"ok", false}, {"error", err}});
  };

  try {
    if (op == "__startDrag") {
      run_on_ui([]() {
        ReleaseCapture();
        SendMessageW(g_app->hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
      });
      return;
    }
    if (op == "win-control") {
      std::string act = args.value("action", "");
      run_on_ui([act]() {
        if (act == "minimize") ShowWindow(g_app->hwnd, SW_MINIMIZE);
        else if (act == "maximize") ShowWindow(g_app->hwnd, IsZoomed(g_app->hwnd) ? SW_RESTORE : SW_MAXIMIZE);
        else if (act == "close") {
          if (g_app->tray_added && !g_app->is_quitting) ShowWindow(g_app->hwnd, SW_HIDE);
          else DestroyWindow(g_app->hwnd);
        }
      });
      return;
    }
    if (op == "set-window-opacity") {
      double val = args.value("value", 1.0);
      run_on_ui([val]() { apply_window_opacity(val); });
      return;
    }

    if (op == "yt-dlp-status") { reply_ok(true); return; }
    if (op == "get-stream-info") {
      reply_ok({{"base", g_app->proxy->base_url()}, {"token", g_app->proxy->token()}});
      return;
    }

    if (op == "get-settings") { reply_ok(g_app->store->get_settings()); return; }
    if (op == "save-settings") {
      auto s = args.value("settings", nlohmann::json::object());
      g_app->store->save_settings(s);
      if (g_app->discord) g_app->discord->set_enabled(s.value("discordRpcEnabled", true));
      reply_ok(true);
      return;
    }
    if (op == "setup:complete") {
      auto opts = args.contains("options") && args["options"].is_object() ? args["options"] : nlohmann::json::object();
      auto saved = g_app->store->complete_setup(opts);
      if (mintpy::jbool(opts, "createShortcut", false)) {
        run_on_ui([]() { mintpy::create_desktop_shortcut(); });
      }
      reply_ok({{"ok", true}, {"settings", saved}});
      return;
    }
    if (op == "setup:set-window-mode") {
      std::string mode = args.value("mode", "main");
      run_on_ui([]() {
        RECT rc{};
        GetWindowRect(g_app->hwnd, &rc);
        HMONITOR mon = MonitorFromRect(&rc, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi{sizeof(mi)};
        GetMonitorInfoW(mon, &mi);
        int w = rc.right - rc.left, h = rc.bottom - rc.top;
        int x = mi.rcWork.left + ((mi.rcWork.right - mi.rcWork.left) - w) / 2;
        int y = mi.rcWork.top + ((mi.rcWork.bottom - mi.rcWork.top) - h) / 2;
        SetWindowPos(g_app->hwnd, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
      });
      reply_ok({{"ok", true}, {"mode", mode}});
      return;
    }

    if (op == "get-favorites") { reply_ok(g_app->store->get_favorites()); return; }
    if (op == "add-favorite") { reply_ok(g_app->store->add_favorite(args.value("track", nlohmann::json::object()))); return; }
    if (op == "remove-favorite") { reply_ok(g_app->store->remove_favorite(args.value("trackId", ""))); return; }

    if (op == "get-playlists") { reply_ok(g_app->store->get_playlists()); return; }
    if (op == "create-playlist") { reply_ok(g_app->store->create_playlist(args.value("name", "Playlist"))); return; }
    if (op == "delete-playlist") { reply_ok(g_app->store->delete_playlist(args.value("playlistId", ""))); return; }
    if (op == "rename-playlist") { reply_ok(g_app->store->rename_playlist(args.value("playlistId", ""), args.value("name", ""))); return; }
    if (op == "get-playlist-tracks") { reply_ok(g_app->store->get_playlist_tracks(args.value("playlistId", ""))); return; }
    if (op == "add-to-playlist") { reply_ok(g_app->store->add_to_playlist(args.value("playlistId", ""), args.value("track", nlohmann::json::object()))); return; }
    if (op == "remove-from-playlist") { reply_ok(g_app->store->remove_from_playlist(args.value("playlistId", ""), args.value("trackId", ""))); return; }

    if (op == "get-playback-state") { reply_ok(g_app->store->get_playback_state()); return; }
    if (op == "save-playback-state") { g_app->store->save_playback_state(args.value("state", nlohmann::json::object())); reply_ok(true); return; }

    if (op == "get-history") { reply_ok(g_app->store->get_history()); return; }
    if (op == "record-history") { g_app->store->record_history(args.value("track", nlohmann::json::object())); reply_ok(true); return; }
    if (op == "clear-history") { g_app->store->clear_history(); reply_ok(true); return; }
    if (op == "remove-history-track") { g_app->store->remove_history_track(args.value("trackId", "")); reply_ok(true); return; }

    if (op == "get-library") { reply_ok(g_app->store->get_library()); return; }
    if (op == "get-missing-library-tracks") {
      auto lib = g_app->store->get_library();
      nlohmann::json missing = nlohmann::json::array();
      std::error_code ec;
      for (const auto& t : lib.value("tracks", nlohmann::json::array())) {
        if (t.value("source", "") != "local") continue;
        std::string fp = t.value("filepath", "");
        if (!fp.empty() && !std::filesystem::exists(mintpy::utf8_to_wide(fp), ec)) {
          missing.push_back({{"id", t.value("id", "")}, {"filepath", fp}, {"title", t.value("title", "")}});
        }
      }
      reply_ok(missing);
      return;
    }
    if (op == "remove-missing-library-tracks") {
      auto paths = args.value("paths", std::vector<std::string>{});
      {
        std::lock_guard lk(g_app->allowed_mutex);
        std::error_code ec;
        for (const auto& p : paths) {
          g_app->allowed_local_files.erase(std::filesystem::weakly_canonical(mintpy::utf8_to_wide(p), ec).wstring());
        }
      }
      reply_ok(g_app->store->remove_missing_tracks(paths));
      return;
    }

    if (op == "discord:set-activity") {
      if (g_app->discord) g_app->discord->set_activity(args.value("activity", nlohmann::json::object()));
      reply_ok(true);
      return;
    }
    if (op == "discord:set-enabled") {
      if (g_app->discord) g_app->discord->set_enabled(args.value("enabled", true));
      reply_ok(true);
      return;
    }

    if (op == "window:set-mini-mode") {
      bool enable = args.value("isMini", false);
      run_on_ui([enable]() { set_mini_mode(enable); });
      reply_ok(enable);
      return;
    }
    if (op == "window:get-mini-mode") { reply_ok(g_app->is_mini_mode); return; }

    if (op == "set-global-mute") {
      std::string acc = mintpy::jstr(args, "acc", "");
      run_on_ui([id, acc]() {
        if (g_app->mute_hotkey_registered) {
          UnregisterHotKey(g_app->hwnd, HK_GLOBAL_MUTE);
          g_app->mute_hotkey_registered = false;
        }
        if (acc.empty()) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"ok", true}}}});
          return;
        }
        UINT mods = 0, vk = 0;
        if (!mintpy::parse_hotkey_accelerator(acc, mods, vk)) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"ok", false}, {"error", "Unsupported shortcut"}}}});
          return;
        }
        if (!RegisterHotKey(g_app->hwnd, HK_GLOBAL_MUTE, mods | MOD_NOREPEAT, vk)) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"ok", false}, {"error", "Shortcut already in use"}}}});
          return;
        }
        g_app->mute_hotkey_registered = true;
        post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"ok", true}}}});
      });
      return;
    }

    if (op == "pick-folder") {
      run_on_ui([id]() {
        auto picked = mintpy::pick_folder_dialog(g_app->hwnd);
        if (picked.empty()) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", nullptr}});
          return;
        }
        std::error_code ec;
        auto canon = std::filesystem::weakly_canonical(picked, ec);
        {
          std::lock_guard lk(g_app->allowed_mutex);
          g_app->allowed_roots.insert(canon.wstring());
        }
        post_json_to_js({{"id", id}, {"ok", true}, {"result", mintpy::wide_to_utf8(canon.wstring())}});
      });
      return;
    }

    // Custom pets handlers
    if (op == "pick-pet-image") {
      run_on_ui([id]() {
        auto src = mintpy::pick_open_file_dialog(g_app->hwnd, L"Images", L"*.png;*.gif;*.jpg;*.jpeg;*.webp");
        if (src.empty()) { post_json_to_js({{"id", id}, {"ok", true}, {"result", nullptr}}); return; }
        std::error_code ec;
        if (std::filesystem::file_size(src, ec) > 8 * 1024 * 1024) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", nullptr}});
          return;
        }
        std::filesystem::create_directories(g_app->pets_dir, ec);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        std::wstring ext = std::filesystem::path(src).extension().wstring();
        std::string dest_name = "pet_" + std::to_string(ms) + mintpy::to_lower_ascii(mintpy::wide_to_utf8(ext));
        std::filesystem::copy_file(src, g_app->pets_dir / mintpy::utf8_to_wide(dest_name), std::filesystem::copy_options::overwrite_existing, ec);
        post_json_to_js({{"id", id}, {"ok", true}, {"result", dest_name}});
      });
      return;
    }
    if (op == "get-custom-pets") {
      nlohmann::json out = nlohmann::json::array();
      std::error_code ec;
      if (std::filesystem::exists(g_app->pets_dir, ec)) {
        for (const auto& entry : std::filesystem::directory_iterator(g_app->pets_dir, ec)) {
          if (!entry.is_regular_file(ec)) continue;
          std::string fname = mintpy::wide_to_utf8(entry.path().filename().wstring());
          if (!valid_pet_filename(fname)) continue;
          std::string stem = mintpy::wide_to_utf8(entry.path().stem().wstring());
          out.push_back({{"id", "custom:" + fname}, {"name", stem}, {"file", fname}});
        }
      }
      reply_ok(out);
      return;
    }
    if (op == "delete-custom-pet") {
      std::string file = args.value("file", "");
      if (!valid_pet_filename(file)) { reply_ok(false); return; }
      std::error_code ec;
      reply_ok(std::filesystem::remove(g_app->pets_dir / mintpy::utf8_to_wide(file), ec));
      return;
    }
    if (op == "get-pet-data-url") {
      std::string file = args.value("file", "");
      if (!valid_pet_filename(file)) { reply_ok(""); return; }
      auto p = g_app->pets_dir / mintpy::utf8_to_wide(file);
      std::error_code ec;
      uint64_t sz = std::filesystem::file_size(p, ec);
      if (ec || sz == 0 || sz > 8 * 1024 * 1024) { reply_ok(""); return; }
      std::ifstream ifs(p, std::ios::binary);
      std::vector<unsigned char> bytes(sz);
      ifs.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(sz));
      std::string ext = mintpy::to_lower_ascii(mintpy::wide_to_utf8(p.extension().wstring()));
      std::string mime = ext == ".png" ? "image/png" : ext == ".gif" ? "image/gif" : ext == ".webp" ? "image/webp" : "image/jpeg";
      reply_ok("data:" + mime + ";base64," + mintpy::base64_encode(bytes.data(), bytes.size()));
      return;
    }

    if (op == "export-backup") {
      run_on_ui([id]() {
        auto out_path = mintpy::pick_save_file_dialog(g_app->hwnd, L"MintPy-backup.json", L"MintPy backup", L"*.json");
        if (out_path.empty()) { post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"canceled", true}}}}); return; }
        nlohmann::json payload = {
            {"format", "mintpy-backup"},
            {"version", 1},
            {"data", g_app->store->dump_all()},
            {"customPets", nlohmann::json::array()}
        };
        std::ofstream ofs{std::filesystem::path(out_path), std::ios::binary | std::ios::trunc};
        ofs << payload.dump(2);
        post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"canceled", false}}}});
      });
      return;
    }
    if (op == "import-backup") {
      run_on_ui([id]() {
        auto in_path = mintpy::pick_open_file_dialog(g_app->hwnd, L"MintPy backup", L"*.json");
        if (in_path.empty()) { post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"canceled", true}}}}); return; }
        try {
          std::ifstream ifs{std::filesystem::path(in_path), std::ios::binary};
          auto backup = nlohmann::json::parse(ifs);
          if (backup.value("format", "") != "mintpy-backup" || !backup.contains("data")) {
            throw std::runtime_error("Unsupported MintPy backup");
          }
          g_app->store->replace_all(backup["data"]);
          hydrate_allowed_files();
          post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"canceled", false}, {"skippedLocalTracks", 0}}}});
        } catch (const std::exception& e) {
          post_json_to_js({{"id", id}, {"ok", false}, {"error", e.what()}});
        }
      });
      return;
    }

    // Worker-thread asynchronous heavy operations (zero UI blocking)
    if (op == "search-tracks") {
      std::string q = args.value("q", "");
      std::thread([id, q]() {
        try {
          auto tracks = mintpy::HttpClient::youtube_search(q, 20);
          post_json_to_js({{"id", id}, {"ok", true}, {"result", tracks}});
        } catch (const std::exception& e) {
          post_json_to_js({{"id", id}, {"ok", false}, {"error", e.what()}});
        }
      }).detach();
      return;
    }
    if (op == "resolve-search-track") {
      auto t = args.contains("track") && args["track"].is_object() ? args["track"] : nlohmann::json::object();
      std::thread([id, t]() {
        auto best = mintpy::HttpClient::resolve_search_track(
            mintpy::jstr(t, "artist", ""), mintpy::jstr(t, "title", ""), mintpy::jnum(t, "duration", 0.0));
        if (best.is_object()) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", {
              {"id", mintpy::jstr(best, "id", "")},
              {"title", mintpy::jstr(t, "title", "")},
              {"artist", mintpy::jstr(t, "artist", "")},
              {"duration", mintpy::jnum(best, "duration", mintpy::jnum(t, "duration", 0.0))},
              {"artwork", mintpy::jstr(best, "artwork", mintpy::jstr(t, "artwork", ""))}
          }}});
        } else {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", nullptr}});
        }
      }).detach();
      return;
    }
    if (op == "import-playlist-from-url") {
      std::string url = args.value("url", "");
      std::thread([id, url]() {
        try {
          auto res = mintpy::HttpClient::import_playlist_from_url(url, g_app->ytdlp_path);
          auto created = g_app->store->add_imported_playlist(res.value("name", "Imported"), res.value("tracks", nlohmann::json::array()));
          post_json_to_js({{"id", id}, {"ok", true}, {"result", created}});
        } catch (const std::exception& e) {
          post_json_to_js({{"id", id}, {"ok", false}, {"error", e.what()}});
        }
      }).detach();
      return;
    }
    if (op == "scan-folder") {
      std::string folder = args.value("folderPath", "");
      std::thread([id, folder]() {
        std::error_code ec;
        auto root = std::filesystem::weakly_canonical(mintpy::utf8_to_wide(folder), ec);
        bool allowed = false;
        {
          std::lock_guard lk(g_app->allowed_mutex);
          allowed = !ec && g_app->allowed_roots.count(root.wstring()) > 0;
        }
        if (!allowed) {
          post_json_to_js({{"id", id}, {"ok", true}, {"result", {{"error", "Папка не выбрана через диалог"}, {"tracks", nlohmann::json::array()}}}});
          return;
        }
        auto tracks = mintpy::TagScanner::scan_folder(root, g_app->covers_dir, g_app->allowed_local_files, g_app->allowed_mutex,
                                                      [](const std::string& msg) { emit_event("scan-progress", msg); });
        std::string root_utf8 = mintpy::wide_to_utf8(root.wstring());
        g_app->store->merge_library_scan(root_utf8, tracks);
        post_json_to_js({{"id", id}, {"ok", true}, {"result", tracks}});
      }).detach();
      return;
    }
    if (op == "audio:import-dropped-files" || op == "audio:import-dropped-file-objects") {
      std::vector<std::filesystem::path> paths = std::move(extra_files);
      if (paths.empty() && args.contains("paths") && args["paths"].is_array()) {
        for (const auto& p : args["paths"]) {
          if (p.is_string()) paths.emplace_back(mintpy::utf8_to_wide(p.get<std::string>()));
        }
      }
      std::thread([id, paths = std::move(paths)]() {
        auto tracks = mintpy::TagScanner::scan_paths(paths, g_app->covers_dir, g_app->allowed_local_files, g_app->allowed_roots, g_app->allowed_mutex);
        if (!tracks.empty()) g_app->store->merge_library_scan("", tracks);
        post_json_to_js({{"id", id}, {"ok", true}, {"result", tracks}});
      }).detach();
      return;
    }

    reply_err("Unknown operation: " + op);
  } catch (const std::exception& e) {
    reply_err(e.what());
  }
}

void init_tray_icon(HWND hwnd) {
  g_app->nid.cbSize = sizeof(NOTIFYICONDATAW);
  g_app->nid.hWnd = hwnd;
  g_app->nid.uID = 1;
  g_app->nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  g_app->nid.uCallbackMessage = WM_MINTPY_TRAY;
  g_app->nid.hIcon = g_app->hIconSmall ? g_app->hIconSmall : LoadIconW(nullptr, IDI_APPLICATION);
  wcscpy_s(g_app->nid.szTip, L"MintPy");
  if (Shell_NotifyIconW(NIM_ADD, &g_app->nid)) {
    g_app->tray_added = true;
  }
}

void load_app_icons(HINSTANCE hInstance, const std::filesystem::path& ico_path) {
  // Load high-resolution embedded resource icon from resource.res
  g_app->hIconBig = static_cast<HICON>(LoadImageW(hInstance, MAKEINTRESOURCEW(1), IMAGE_ICON, 256, 256, LR_DEFAULTCOLOR));
  if (!g_app->hIconBig) g_app->hIconBig = LoadIconW(hInstance, MAKEINTRESOURCEW(1));
  g_app->hIconSmall = static_cast<HICON>(LoadImageW(hInstance, MAKEINTRESOURCEW(1), IMAGE_ICON, 32, 32, LR_DEFAULTCOLOR));
  if (!g_app->hIconSmall) g_app->hIconSmall = static_cast<HICON>(LoadImageW(hInstance, MAKEINTRESOURCEW(1), IMAGE_ICON, 16, 16, LR_DEFAULTCOLOR));

  // Fallback to loading from assets/app-icon.ico if not embedded
  if ((!g_app->hIconBig || !g_app->hIconSmall) && std::filesystem::exists(ico_path)) {
    if (!g_app->hIconBig) {
      g_app->hIconBig = static_cast<HICON>(LoadImageW(nullptr, ico_path.c_str(), IMAGE_ICON, 256, 256, LR_LOADFROMFILE));
    }
    if (!g_app->hIconSmall) {
      g_app->hIconSmall = static_cast<HICON>(LoadImageW(nullptr, ico_path.c_str(), IMAGE_ICON, 32, 32, LR_LOADFROMFILE));
    }
  }
}

void init_webview2(HWND hwnd) {
  std::wstring loader_path;
  wchar_t exe_buf[MAX_PATH]{};
  GetModuleFileNameW(nullptr, exe_buf, MAX_PATH);
  std::filesystem::path exe_dir = std::filesystem::path(exe_buf).parent_path();
  std::error_code ec;
  for (const auto& cand : {
           exe_dir / L"WebView2Loader.dll",
           g_app->app_root / L"tools" / L"webview2" / L"build" / L"native" / L"x64" / L"WebView2Loader.dll"
       }) {
    if (std::filesystem::exists(cand, ec)) { loader_path = cand.wstring(); break; }
  }

  g_app->wv_loader_mod = loader_path.empty() ? LoadLibraryW(L"WebView2Loader.dll") : LoadLibraryW(loader_path.c_str());
  if (!g_app->wv_loader_mod) {
    MessageBoxW(hwnd, L"WebView2Loader.dll not found!", L"MintPy", MB_ICONERROR);
    return;
  }

  using CreateEnvFn = HRESULT(STDAPICALLTYPE*)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
  auto create_env = reinterpret_cast<CreateEnvFn>(GetProcAddress(g_app->wv_loader_mod, "CreateCoreWebView2EnvironmentWithOptions"));
  if (!create_env) return;

  std::filesystem::path wv_data = g_app->user_data_dir / L"WebView2";
  auto* env_opts = new mintpy::EnvOptionsWithCover(L"--autoplay-policy=no-user-gesture-required");
  auto* env_cb = new mintpy::EnvCompletedHandler([hwnd](HRESULT hr, ICoreWebView2Environment* env) {
    if (FAILED(hr) || !env) {
      MessageBoxW(hwnd, L"Microsoft Edge WebView2 Runtime is required to run MintPy.", L"MintPy", MB_ICONERROR);
      return;
    }
    g_app->wv_env = env;
    auto* ctrl_cb = new mintpy::ControllerCompletedHandler([hwnd](HRESULT hr2, ICoreWebView2Controller* ctrl) {
      if (FAILED(hr2) || !ctrl) return;
      g_app->wv_ctrl = ctrl;
      ctrl->get_CoreWebView2(&g_app->webview);
      if (!g_app->webview) return;

      // Solid opaque background matching the Zen theme (no desktop blur or transparency bleed)
      ComPtr<ICoreWebView2Controller2> ctrl2;
      if (SUCCEEDED(ctrl->QueryInterface(IID_ICoreWebView2Controller2, reinterpret_cast<void**>(ctrl2.GetAddressOf())))) {
        ctrl2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{255, 18, 21, 20});
      }

      ComPtr<ICoreWebView2Settings> settings;
      if (SUCCEEDED(g_app->webview->get_Settings(&settings))) {
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        ComPtr<ICoreWebView2Settings3> s3;
        if (SUCCEEDED(settings->QueryInterface(IID_ICoreWebView2Settings3, reinterpret_cast<void**>(s3.GetAddressOf())))) {
          s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
        }
      }

      // Inject window.api native C++ bridge before any page script executes
      g_app->webview->AddScriptToExecuteOnDocumentCreated(mintpy::kInjectedBridgeJs, nullptr);

      // Virtual host mapping for instant zero-copy disk loading
      ComPtr<ICoreWebView2_3> wv3;
      if (SUCCEEDED(g_app->webview->QueryInterface(IID_ICoreWebView2_3, reinterpret_cast<void**>(wv3.GetAddressOf())))) {
        wv3->SetVirtualHostNameToFolderMapping(L"mintpy.local", g_app->app_root.c_str(),
                                               COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
      }

      // Intercept cover:// URLs safely from %APPDATA%\mintpy\covers
      g_app->webview->AddWebResourceRequestedFilter(L"cover://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
      EventRegistrationToken res_tok{};
      auto* res_cb = new mintpy::WebResourceHandler([](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
        ComPtr<ICoreWebView2WebResourceRequest> req;
        if (FAILED(args->get_Request(&req))) return;
        LPWSTR uri_raw = nullptr;
        if (FAILED(req->get_Uri(&uri_raw)) || !uri_raw) return;
        std::wstring uri(uri_raw);
        CoTaskMemFree(uri_raw);

        // Extract basename cleanly: cover://covers/<sha1>.<ext>
        auto slash = uri.find_last_of(L'/');
        std::wstring fname = (slash != std::wstring::npos) ? uri.substr(slash + 1) : L"";
        static const std::regex cover_re(R"(^[a-f0-9]{40}\.(jpe?g|png|gif|webp|bmp|tiff?)$)", std::regex::icase);
        std::string fname_u8 = mintpy::wide_to_utf8(fname);
        if (!std::regex_match(fname_u8, cover_re)) return;

        std::filesystem::path disk = g_app->covers_dir / fname;
        ComPtr<IStream> stream;
        if (SUCCEEDED(SHCreateStreamOnFileEx(disk.c_str(), STGM_READ | STGM_SHARE_DENY_NONE, FILE_ATTRIBUTE_NORMAL, FALSE, nullptr, &stream))) {
          std::wstring ctype = L"Content-Type: image/jpeg\r\nAccess-Control-Allow-Origin: *";
          std::string low = mintpy::to_lower_ascii(fname_u8);
          if (low.find(".png") != std::string::npos) ctype = L"Content-Type: image/png\r\nAccess-Control-Allow-Origin: *";
          else if (low.find(".webp") != std::string::npos) ctype = L"Content-Type: image/webp\r\nAccess-Control-Allow-Origin: *";
          ComPtr<ICoreWebView2WebResourceResponse> resp;
          if (SUCCEEDED(g_app->wv_env->CreateWebResourceResponse(stream.Get(), 200, L"OK", ctype.c_str(), &resp))) {
            args->put_Response(resp.Get());
          }
        }
      });
      g_app->webview->add_WebResourceRequested(res_cb, &res_tok);
      res_cb->Release();

      // Receive IPC messages (plus WebView2 File additionalObjects for Drag & Drop)
      EventRegistrationToken msg_tok{};
      auto* msg_cb = new mintpy::WebMessageHandler([](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) {
        LPWSTR json_raw = nullptr;
        if (FAILED(args->get_WebMessageAsJson(&json_raw)) || !json_raw) return;
        std::string msg_str = mintpy::wide_to_utf8(json_raw);
        CoTaskMemFree(json_raw);

        std::vector<std::filesystem::path> extra_files;
        ComPtr<ICoreWebView2WebMessageReceivedEventArgs2> args2;
        if (SUCCEEDED(args->QueryInterface(IID_ICoreWebView2WebMessageReceivedEventArgs2, reinterpret_cast<void**>(args2.GetAddressOf())))) {
          ComPtr<ICoreWebView2ObjectCollectionView> col;
          if (SUCCEEDED(args2->get_AdditionalObjects(&col)) && col) {
            UINT32 count = 0;
            col->get_Count(&count);
            for (UINT32 i = 0; i < count; ++i) {
              ComPtr<IUnknown> unk;
              if (SUCCEEDED(col->GetValueAtIndex(i, &unk)) && unk) {
                ComPtr<ICoreWebView2File> wvFile;
                if (SUCCEEDED(unk->QueryInterface(IID_ICoreWebView2File, reinterpret_cast<void**>(wvFile.GetAddressOf()))) && wvFile) {
                  LPWSTR fpath = nullptr;
                  if (SUCCEEDED(wvFile->get_Path(&fpath)) && fpath) {
                    extra_files.emplace_back(fpath);
                    CoTaskMemFree(fpath);
                  }
                }
              }
            }
          }
        }

        try {
          auto msg = nlohmann::json::parse(msg_str);
          int id = mintpy::jint(msg, "id", 0);
          std::string op = mintpy::jstr(msg, "op", "");
          nlohmann::json op_args = msg.contains("args") && msg["args"].is_object() ? msg["args"] : nlohmann::json::object();
          handle_ipc_call(id, op, op_args, std::move(extra_files));
        } catch (...) {}
      });
      g_app->webview->add_WebMessageReceived(msg_cb, &msg_tok);
      msg_cb->Release();

      update_window_geometry();
      g_app->webview->Navigate(L"https://mintpy.local/src/index.html");
    });

    env->CreateCoreWebView2Controller(hwnd, ctrl_cb);
    ctrl_cb->Release();
  });

  create_env(nullptr, wv_data.c_str(), env_opts, env_cb);
  env_opts->Release();
  env_cb->Release();
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT uMsg, WPARAM wParam, LPARAM lParam) {
  switch (uMsg) {
    case WM_CREATE:
      DragAcceptFiles(hwnd, TRUE);
      RegisterHotKey(hwnd, HK_MEDIA_PLAY_PAUSE, 0, VK_MEDIA_PLAY_PAUSE);
      RegisterHotKey(hwnd, HK_MEDIA_NEXT, 0, VK_MEDIA_NEXT_TRACK);
      RegisterHotKey(hwnd, HK_MEDIA_PREV, 0, VK_MEDIA_PREV_TRACK);
      init_tray_icon(hwnd);
      return 0;

    case WM_NCCALCSIZE:
      if (wParam == TRUE) return 0;  // Seamless frameless window keeping DWM shadows & Aero snap
      break;

    case WM_NCHITTEST: {
      if (g_app && g_app->is_mini_mode) return HTCLIENT;
      RECT rc{};
      GetWindowRect(hwnd, &rc);
      int x = GET_X_LPARAM(lParam), y = GET_Y_LPARAM(lParam);
      constexpr int kBorder = 6;
      bool left = x >= rc.left && x < rc.left + kBorder;
      bool right = x <= rc.right && x > rc.right - kBorder;
      bool top = y >= rc.top && y < rc.top + kBorder;
      bool bottom = y <= rc.bottom && y > rc.bottom - kBorder;
      if (top && left) return HTTOPLEFT;
      if (top && right) return HTTOPRIGHT;
      if (bottom && left) return HTBOTTOMLEFT;
      if (bottom && right) return HTBOTTOMRIGHT;
      if (left) return HTLEFT;
      if (right) return HTRIGHT;
      if (top) return HTTOP;
      if (bottom) return HTBOTTOM;
      return HTCLIENT;
    }

    case WM_GETMINMAXINFO: {
      auto* mmi = reinterpret_cast<MINMAXINFO*>(lParam);
      if (g_app && g_app->is_mini_mode) {
        mmi->ptMinTrackSize = {400, 130};
      } else {
        mmi->ptMinTrackSize = {980, 680};
      }
      return 0;
    }

    case WM_SIZE:
      update_window_geometry();
      return 0;

    case WM_HOTKEY:
      if (wParam == HK_MEDIA_PLAY_PAUSE) emit_event("media-command", "play-pause");
      else if (wParam == HK_MEDIA_NEXT) emit_event("media-command", "next-track");
      else if (wParam == HK_MEDIA_PREV) emit_event("media-command", "prev-track");
      else if (wParam == HK_GLOBAL_MUTE) emit_event("global-mute-triggered");
      return 0;

    case WM_MINTPY_POST_JSON: {
      auto* wstr = reinterpret_cast<std::wstring*>(lParam);
      if (g_app && g_app->webview && wstr) {
        g_app->webview->PostWebMessageAsJson(wstr->c_str());
      }
      delete wstr;
      return 0;
    }

    case WM_MINTPY_EXEC_UI: {
      auto* fn = reinterpret_cast<std::function<void()>*>(lParam);
      if (fn) {
        (*fn)();
        delete fn;
      }
      return 0;
    }

    case WM_MINTPY_TRAY:
      if (lParam == WM_LBUTTONUP || lParam == WM_LBUTTONDBLCLK) {
        show_main_window();
      } else if (lParam == WM_RBUTTONUP) {
        POINT pt{};
        GetCursorPos(&pt);
        HMENU menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING, TRAY_ID_OPEN, L"Open MintPy");
        AppendMenuW(menu, MF_STRING, TRAY_ID_PLAYPAUSE, L"Play / Pause");
        AppendMenuW(menu, MF_STRING, TRAY_ID_NEXT, L"Next track");
        AppendMenuW(menu, MF_STRING, TRAY_ID_PREV, L"Previous track");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING, TRAY_ID_EXIT, L"Exit");
        SetForegroundWindow(hwnd);
        int cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hwnd, nullptr);
        DestroyMenu(menu);
        if (cmd == TRAY_ID_OPEN) show_main_window();
        else if (cmd == TRAY_ID_PLAYPAUSE) emit_event("media-command", "play-pause");
        else if (cmd == TRAY_ID_NEXT) emit_event("media-command", "next-track");
        else if (cmd == TRAY_ID_PREV) emit_event("media-command", "prev-track");
        else if (cmd == TRAY_ID_EXIT) {
          g_app->is_quitting = true;
          DestroyWindow(hwnd);
        }
      }
      return 0;

    case WM_CLOSE:
      if (g_app && g_app->tray_added && !g_app->is_quitting) {
        ShowWindow(hwnd, SW_HIDE);
        return 0;
      }
      break;

    case WM_DESTROY:
      UnregisterHotKey(hwnd, HK_MEDIA_PLAY_PAUSE);
      UnregisterHotKey(hwnd, HK_MEDIA_NEXT);
      UnregisterHotKey(hwnd, HK_MEDIA_PREV);
      if (g_app && g_app->mute_hotkey_registered) UnregisterHotKey(hwnd, HK_GLOBAL_MUTE);
      if (g_app && g_app->tray_added) Shell_NotifyIconW(NIM_DELETE, &g_app->nid);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, uMsg, wParam, lParam);
}

void apply_native_window_frame(HWND hwnd) {
  // Windows 11 Immersive Dark Mode (20 = DWMWA_USE_IMMERSIVE_DARK_MODE)
  BOOL dark = TRUE;
  DwmSetWindowAttribute(hwnd, 20, &dark, sizeof(dark));

  // Windows 11 Rounded Corners (33 = DWMWA_WINDOW_CORNER_PREFERENCE, 2 = DWMWCP_ROUND)
  DWORD corners = 2;
  DwmSetWindowAttribute(hwnd, 33, &corners, sizeof(corners));

  // Suppress Windows 11 default outer border line (34 = DWMWA_BORDER_COLOR, 0xFFFFFFFE = DWMWA_COLOR_NONE)
  COLORREF no_border = 0xFFFFFFFE;
  DwmSetWindowAttribute(hwnd, 34, &no_border, sizeof(no_border));
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int nCmdShow) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutexName);
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND existing = FindWindowW(kWindowClass, L"MintPy");
    if (existing) {
      if (IsIconic(existing)) ShowWindow(existing, SW_RESTORE);
      ShowWindow(existing, SW_SHOW);
      SetForegroundWindow(existing);
    }
    CloseHandle(mutex);
    CoUninitialize();
    return 0;
  }

  AppState state;
  g_app = &state;
  state.app_root = mintpy::find_app_root();
  state.user_data_dir = mintpy::get_app_data_dir();
  state.covers_dir = state.user_data_dir / L"covers";
  state.pets_dir = state.user_data_dir / L"pets";
  state.ytdlp_path = mintpy::find_ytdlp_exe(state.app_root);

  std::error_code ec;
  std::filesystem::create_directories(state.covers_dir, ec);

  state.store = std::make_unique<mintpy::DataStore>(state.user_data_dir / L"mintpy-data.json");
  state.store->load();
  hydrate_allowed_files();

  state.proxy = std::make_unique<mintpy::AudioProxy>(state.allowed_local_files, state.allowed_mutex, state.ytdlp_path);
  state.proxy->start();

  state.discord = std::make_unique<mintpy::DiscordIpc>();
  auto init_settings = state.store->get_settings();
  state.discord->set_enabled(init_settings.value("discordRpcEnabled", true));

  load_app_icons(hInstance, state.app_root / L"assets" / L"app-icon.ico");

  WNDCLASSEXW wc{sizeof(wc)};
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WindowProc;
  wc.hInstance = hInstance;
  wc.hIcon = state.hIconBig;
  wc.hIconSm = state.hIconSmall;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(16, 18, 17));
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);

  int sw = GetSystemMetrics(SM_CXSCREEN);
  int sh = GetSystemMetrics(SM_CYSCREEN);
  int w = 1360, h = 860;
  int x = (std::max)(0, (sw - w) / 2);
  int y = (std::max)(0, (sh - h) / 2);

  HWND hwnd = CreateWindowExW(
      WS_EX_APPWINDOW,
      kWindowClass,
      L"MintPy",
      WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN,
      x, y, w, h,
      nullptr, nullptr, hInstance, nullptr);
  if (!hwnd) return 1;
  state.hwnd = hwnd;

  // Native Windows 11 rounded corners and dark titlebar frame
  apply_native_window_frame(hwnd);

  ShowWindow(hwnd, nCmdShow);
  UpdateWindow(hwnd);
  init_webview2(hwnd);

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  state.discord->stop();
  state.proxy->stop();
  state.store->flush_sync();
  if (state.wv_ctrl) state.wv_ctrl->Close();
  if (state.wv_loader_mod) FreeLibrary(state.wv_loader_mod);
  if (mutex) CloseHandle(mutex);
  CoUninitialize();
  return static_cast<int>(msg.wParam);
}

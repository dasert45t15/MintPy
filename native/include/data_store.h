#pragma once

#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include "json.hpp"

namespace mintpy {

class DataStore {
 public:
  explicit DataStore(std::filesystem::path file_path);
  ~DataStore();

  void load();
  void flush_sync();

  nlohmann::json get_settings();
  void save_settings(const nlohmann::json& raw_settings);
  nlohmann::json complete_setup(const nlohmann::json& options);

  nlohmann::json get_library();
  void merge_library_scan(const std::string& folder_utf8, const nlohmann::json& tracks);
  nlohmann::json remove_missing_tracks(const std::vector<std::string>& paths);

  nlohmann::json get_favorites();
  nlohmann::json add_favorite(const nlohmann::json& track);
  nlohmann::json remove_favorite(const std::string& track_id);

  nlohmann::json get_playlists();
  nlohmann::json create_playlist(const std::string& name);
  bool delete_playlist(const std::string& playlist_id);
  bool rename_playlist(const std::string& playlist_id, const std::string& new_name);
  nlohmann::json get_playlist_tracks(const std::string& playlist_id);
  nlohmann::json add_to_playlist(const std::string& playlist_id, const nlohmann::json& track);
  nlohmann::json remove_from_playlist(const std::string& playlist_id, const std::string& track_id);
  nlohmann::json add_imported_playlist(const std::string& name, const nlohmann::json& tracks);

  nlohmann::json get_playback_state();
  void save_playback_state(const nlohmann::json& state);

  nlohmann::json get_history();
  void record_history(const nlohmann::json& track);
  void clear_history();
  void remove_history_track(const std::string& track_id);

  nlohmann::json dump_all();
  void replace_all(nlohmann::json imported_data);

  static nlohmann::json default_settings();
  static nlohmann::json normalize_settings(const nlohmann::json& raw);

 private:
  void mark_dirty();
  void writer_loop();
  void write_file_atomic(const nlohmann::json& snapshot);

  std::filesystem::path file_path_;
  std::mutex mutex_;
  nlohmann::json data_;

  std::mutex write_mutex_;
  std::condition_variable write_cv_;
  bool dirty_{false};
  std::atomic<bool> stop_writer_{false};
  std::thread writer_thread_;
};

}  // namespace mintpy

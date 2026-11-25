#pragma once

#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_set>
#include <vector>
#include "json.hpp"

namespace mintpy {

class TagScanner {
 public:
  static bool is_audio_file(const std::filesystem::path& p);
  static bool should_skip_dir(const std::wstring& name);

  // Multithreaded scan of a single folder (max_depth = 10)
  static nlohmann::json scan_folder(
      const std::filesystem::path& root,
      const std::filesystem::path& covers_dir,
      std::unordered_set<std::wstring>& allowed_local_files,
      std::mutex& allowed_mutex,
      const std::function<void(const std::string& msg)>& progress_cb = nullptr);

  // Multithreaded scan of dropped files & folders
  static nlohmann::json scan_paths(
      const std::vector<std::filesystem::path>& paths,
      const std::filesystem::path& covers_dir,
      std::unordered_set<std::wstring>& allowed_local_files,
      std::unordered_set<std::wstring>& allowed_roots,
      std::mutex& allowed_mutex);

  // Parse a single audio file's tags + cover artwork + duration
  static nlohmann::json parse_audio_file(
      const std::filesystem::path& file_path,
      const std::filesystem::path& covers_dir);
};

}  // namespace mintpy

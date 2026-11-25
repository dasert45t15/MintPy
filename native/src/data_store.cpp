#include "data_store.h"
#include "utf_util.h"

#include <chrono>
#include <fstream>
#include <unordered_set>

namespace mintpy {

namespace {

constexpr int SCHEMA_VERSION = 2;

bool is_valid_style(const std::string& s) {
  return s == "zen" || s == "lofi" || s == "synthwave" || s == "aurora" || s == "ocean" || s == "forest";
}

bool is_valid_appearance(const std::string& a) {
  return a == "system" || a == "light" || a == "dark";
}

nlohmann::json default_data() {
  return {
      {"schemaVersion", SCHEMA_VERSION},
      {"favorites", nlohmann::json::array()},
      {"history", nlohmann::json::array()},
      {"playback", {{"queue", nlohmann::json::array()}, {"currentIndex", -1}}},
      {"playlists", nlohmann::json::array()},
      {"library", {{"folders", nlohmann::json::array()}, {"tracks", nlohmann::json::array()}}},
      {"settings", DataStore::default_settings()}
  };
}

}  // namespace

nlohmann::json DataStore::default_settings() {
  return {
      {"opacity", 1.0},
      {"auraIntensity", 0.35},
      {"compactMode", false},
      {"appearance", "system"},
      {"accentColor", "blue-purple"},
      {"customColor", ""},
      {"cornerRadius", 30},
      {"keybinds", nlohmann::json::object()},
      {"style", "zen"},
      {"pet", ""},
      {"petSize", 96},
      {"petPos", nullptr},
      {"volumeNormalize", false},
      {"eqBands", {{"low", 0}, {"mid", 0}, {"high", 0}}},
      {"crossfadeSeconds", 5},
      {"setupCompleted", false},
      {"discordRpcEnabled", true},
      {"volume", 30},
      {"smartQueueEnabled", true}
  };
}

nlohmann::json DataStore::normalize_settings(const nlohmann::json& raw) {
  nlohmann::json res = default_settings();
  if (!raw.is_object()) return res;
  for (auto it = raw.begin(); it != raw.end(); ++it) {
    if (!res.contains(it.key())) continue;
    const auto& k = it.key();
    const auto& v = it.value();
    if (k == "opacity" && v.is_number()) res[k] = std::clamp(v.get<double>(), 0.05, 1.0);
    else if (k == "auraIntensity" && v.is_number()) res[k] = std::clamp(v.get<double>(), 0.0, 1.0);
    else if (k == "cornerRadius" && v.is_number()) res[k] = std::clamp(v.get<int>(), 0, 100);
    else if (k == "petSize" && v.is_number()) res[k] = std::clamp(v.get<int>(), 40, 200);
    else if (k == "crossfadeSeconds" && v.is_number()) res[k] = std::clamp(v.get<int>(), 0, 12);
    else if (k == "volume" && v.is_number()) res[k] = std::clamp(v.get<int>(), 0, 100);
    else if ((k == "compactMode" || k == "volumeNormalize" || k == "setupCompleted" || k == "discordRpcEnabled" || k == "smartQueueEnabled") && v.is_boolean()) res[k] = v;
    else if (k == "appearance" && v.is_string() && is_valid_appearance(v.get<std::string>())) res[k] = v;
    else if (k == "style" && v.is_string() && is_valid_style(v.get<std::string>())) res[k] = v;
    else if (k == "eqBands" && v.is_object()) {
      res[k] = {
          {"low", std::clamp(v.value("low", 0), -12, 12)},
          {"mid", std::clamp(v.value("mid", 0), -12, 12)},
          {"high", std::clamp(v.value("high", 0), -12, 12)}
      };
    } else if ((k == "accentColor" || k == "customColor" || k == "pet") && v.is_string()) {
      res[k] = v;
    } else if (k == "petPos" && (v.is_null() || v.is_object())) {
      res[k] = v;
    } else if (k == "keybinds" && v.is_object()) {
      res[k] = v;
    }
  }
  return res;
}

DataStore::DataStore(std::filesystem::path file_path) : file_path_(std::move(file_path)) {
  data_ = default_data();
  writer_thread_ = std::thread(&DataStore::writer_loop, this);
}

DataStore::~DataStore() {
  stop_writer_.store(true);
  write_cv_.notify_all();
  if (writer_thread_.joinable()) writer_thread_.join();
  flush_sync();
}

void DataStore::load() {
  std::lock_guard lk(mutex_);
  std::error_code ec;
  if (!std::filesystem::exists(file_path_, ec)) {
    data_ = default_data();
    return;
  }
  try {
    std::ifstream ifs(file_path_, std::ios::binary);
    if (!ifs.good()) { data_ = default_data(); return; }
    nlohmann::json raw = nlohmann::json::parse(ifs);
    if (!raw.is_object()) { data_ = default_data(); return; }
    nlohmann::json d = default_data();
    if (raw.contains("favorites") && raw["favorites"].is_array()) d["favorites"] = raw["favorites"];
    if (raw.contains("history") && raw["history"].is_array()) d["history"] = raw["history"];
    if (raw.contains("playlists") && raw["playlists"].is_array()) d["playlists"] = raw["playlists"];
    if (raw.contains("playback") && raw["playback"].is_object()) {
      if (raw["playback"].contains("queue") && raw["playback"]["queue"].is_array()) d["playback"]["queue"] = raw["playback"]["queue"];
      if (raw["playback"].contains("currentIndex") && raw["playback"]["currentIndex"].is_number_integer()) d["playback"]["currentIndex"] = raw["playback"]["currentIndex"];
    }
    if (raw.contains("library") && raw["library"].is_object()) {
      if (raw["library"].contains("folders") && raw["library"]["folders"].is_array()) d["library"]["folders"] = raw["library"]["folders"];
      if (raw["library"].contains("tracks") && raw["library"]["tracks"].is_array()) d["library"]["tracks"] = raw["library"]["tracks"];
    }
    d["settings"] = normalize_settings(raw.value("settings", nlohmann::json::object()));
    data_ = std::move(d);
  } catch (...) {
    std::filesystem::path bak = file_path_;
    bak += L".corrupt.bak";
    std::filesystem::copy_file(file_path_, bak, std::filesystem::copy_options::overwrite_existing, ec);
    data_ = default_data();
  }
}

void DataStore::mark_dirty() {
  {
    std::lock_guard lk(write_mutex_);
    dirty_ = true;
  }
  write_cv_.notify_one();
}

void DataStore::writer_loop() {
  while (!stop_writer_.load()) {
    std::unique_lock lk(write_mutex_);
    write_cv_.wait(lk, [&]() { return dirty_ || stop_writer_.load(); });
    if (stop_writer_.load()) break;
    // Debounce burst updates (playback + history + settings)
    lk.unlock();
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    nlohmann::json snapshot;
    {
      std::lock_guard wlk(write_mutex_);
      if (!dirty_) continue;
      dirty_ = false;
    }
    {
      std::lock_guard dlk(mutex_);
      snapshot = data_;
    }
    write_file_atomic(snapshot);
  }
}

void DataStore::flush_sync() {
  nlohmann::json snapshot;
  bool should_write = false;
  {
    std::lock_guard wlk(write_mutex_);
    if (dirty_) { dirty_ = false; should_write = true; }
  }
  if (!should_write) return;
  {
    std::lock_guard dlk(mutex_);
    snapshot = data_;
  }
  write_file_atomic(snapshot);
}

void DataStore::write_file_atomic(const nlohmann::json& snapshot) {
  std::error_code ec;
  std::filesystem::create_directories(file_path_.parent_path(), ec);
  std::filesystem::path tmp = file_path_;
  tmp += L".tmp";
  {
    std::ofstream ofs(tmp, std::ios::binary | std::ios::trunc);
    if (!ofs.good()) return;
    std::string dumped = snapshot.dump();
    ofs.write(dumped.data(), static_cast<std::streamsize>(dumped.size()));
  }
  MoveFileExW(tmp.c_str(), file_path_.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
}

nlohmann::json DataStore::get_settings() {
  std::lock_guard lk(mutex_);
  return data_["settings"];
}

void DataStore::save_settings(const nlohmann::json& raw_settings) {
  std::lock_guard lk(mutex_);
  data_["settings"] = normalize_settings(raw_settings);
  mark_dirty();
}

nlohmann::json DataStore::complete_setup(const nlohmann::json& options) {
  std::lock_guard lk(mutex_);
  auto cur = data_["settings"];
  cur["setupCompleted"] = true;
  if (options.is_object()) {
    if (options.contains("style") && options["style"].is_string()) cur["style"] = options["style"];
    if (options.contains("theme") && options["theme"].is_string()) cur["appearance"] = options["theme"];
  }
  data_["settings"] = normalize_settings(cur);
  mark_dirty();
  return data_["settings"];
}

nlohmann::json DataStore::get_library() {
  std::lock_guard lk(mutex_);
  return data_["library"];
}

void DataStore::merge_library_scan(const std::string& folder_utf8, const nlohmann::json& tracks) {
  std::lock_guard lk(mutex_);
  auto& lib = data_["library"];
  if (!folder_utf8.empty()) {
    bool has_folder = false;
    for (const auto& f : lib["folders"]) {
      if (f.is_string() && f.get<std::string>() == folder_utf8) { has_folder = true; break; }
    }
    if (!has_folder) lib["folders"].push_back(folder_utf8);
  }
  std::unordered_map<std::string, nlohmann::json> by_path;
  for (const auto& t : lib["tracks"]) {
    if (t.is_object() && t.contains("filepath")) by_path[t["filepath"].get<std::string>()] = t;
  }
  for (const auto& t : tracks) {
    if (t.is_object() && t.contains("filepath")) by_path[t["filepath"].get<std::string>()] = t;
  }
  nlohmann::json merged = nlohmann::json::array();
  for (auto& [k, v] : by_path) merged.push_back(std::move(v));
  lib["tracks"] = std::move(merged);
  mark_dirty();
}

nlohmann::json DataStore::remove_missing_tracks(const std::vector<std::string>& paths) {
  std::lock_guard lk(mutex_);
  std::unordered_set<std::string> path_set(paths.begin(), paths.end());
  std::unordered_set<std::string> removed_ids;
  nlohmann::json kept_lib = nlohmann::json::array();
  for (const auto& t : data_["library"]["tracks"]) {
    std::string fp = t.value("filepath", "");
    std::string id = t.value("id", "");
    if (!fp.empty() && path_set.count(fp)) {
      removed_ids.insert(id);
    } else {
      kept_lib.push_back(t);
    }
  }
  data_["library"]["tracks"] = std::move(kept_lib);
  auto filter_out = [&](nlohmann::json& arr) {
    nlohmann::json out = nlohmann::json::array();
    for (const auto& t : arr) {
      if (!removed_ids.count(t.value("id", ""))) out.push_back(t);
    }
    arr = std::move(out);
  };
  filter_out(data_["favorites"]);
  for (auto& pl : data_["playlists"]) {
    if (pl.contains("tracks") && pl["tracks"].is_array()) filter_out(pl["tracks"]);
  }
  filter_out(data_["playback"]["queue"]);
  if (data_["playback"]["queue"].empty()) data_["playback"]["currentIndex"] = -1;
  else if (data_["playback"]["currentIndex"].get<int>() >= static_cast<int>(data_["playback"]["queue"].size())) {
    data_["playback"]["currentIndex"] = static_cast<int>(data_["playback"]["queue"].size()) - 1;
  }
  mark_dirty();
  return {{"removed", removed_ids.size()}, {"tracks", data_["library"]["tracks"]}};
}

nlohmann::json DataStore::get_favorites() {
  std::lock_guard lk(mutex_);
  return data_["favorites"];
}

nlohmann::json DataStore::add_favorite(const nlohmann::json& track) {
  std::lock_guard lk(mutex_);
  std::string id = track.value("id", "");
  if (!id.empty()) {
    bool exists = false;
    for (const auto& t : data_["favorites"]) {
      if (t.value("id", "") == id) { exists = true; break; }
    }
    if (!exists) {
      nlohmann::json next = nlohmann::json::array();
      next.push_back(track);
      for (auto& t : data_["favorites"]) next.push_back(std::move(t));
      data_["favorites"] = std::move(next);
      mark_dirty();
    }
  }
  return data_["favorites"];
}

nlohmann::json DataStore::remove_favorite(const std::string& track_id) {
  std::lock_guard lk(mutex_);
  nlohmann::json next = nlohmann::json::array();
  for (const auto& t : data_["favorites"]) {
    if (t.value("id", "") != track_id) next.push_back(t);
  }
  data_["favorites"] = std::move(next);
  mark_dirty();
  return data_["favorites"];
}

nlohmann::json DataStore::get_playlists() {
  std::lock_guard lk(mutex_);
  nlohmann::json out = nlohmann::json::array();
  for (const auto& p : data_["playlists"]) {
    out.push_back({
        {"id", p.value("id", "")},
        {"name", p.value("name", "")},
        {"trackCount", p.contains("tracks") && p["tracks"].is_array() ? p["tracks"].size() : 0}
    });
  }
  return out;
}

nlohmann::json DataStore::create_playlist(const std::string& name) {
  std::lock_guard lk(mutex_);
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string id = "pl_" + std::to_string(ms);
  nlohmann::json pl = {{"id", id}, {"name", trim_copy(name)}, {"tracks", nlohmann::json::array()}};
  data_["playlists"].push_back(pl);
  mark_dirty();
  return {{"id", id}, {"name", pl["name"]}, {"trackCount", 0}};
}

bool DataStore::delete_playlist(const std::string& playlist_id) {
  std::lock_guard lk(mutex_);
  nlohmann::json next = nlohmann::json::array();
  for (const auto& p : data_["playlists"]) {
    if (p.value("id", "") != playlist_id) next.push_back(p);
  }
  data_["playlists"] = std::move(next);
  mark_dirty();
  return true;
}

bool DataStore::rename_playlist(const std::string& playlist_id, const std::string& new_name) {
  std::lock_guard lk(mutex_);
  for (auto& p : data_["playlists"]) {
    if (p.value("id", "") == playlist_id) {
      p["name"] = trim_copy(new_name);
      mark_dirty();
      return true;
    }
  }
  return false;
}

nlohmann::json DataStore::get_playlist_tracks(const std::string& playlist_id) {
  std::lock_guard lk(mutex_);
  for (const auto& p : data_["playlists"]) {
    if (p.value("id", "") == playlist_id && p.contains("tracks")) return p["tracks"];
  }
  return nlohmann::json::array();
}

nlohmann::json DataStore::add_to_playlist(const std::string& playlist_id, const nlohmann::json& track) {
  std::lock_guard lk(mutex_);
  std::string tid = track.value("id", "");
  for (auto& p : data_["playlists"]) {
    if (p.value("id", "") == playlist_id) {
      if (!p.contains("tracks") || !p["tracks"].is_array()) p["tracks"] = nlohmann::json::array();
      bool exists = false;
      for (const auto& t : p["tracks"]) {
        if (t.value("id", "") == tid) { exists = true; break; }
      }
      if (!exists && !tid.empty()) {
        p["tracks"].push_back(track);
        mark_dirty();
      }
      return p["tracks"];
    }
  }
  return nlohmann::json::array();
}

nlohmann::json DataStore::remove_from_playlist(const std::string& playlist_id, const std::string& track_id) {
  std::lock_guard lk(mutex_);
  for (auto& p : data_["playlists"]) {
    if (p.value("id", "") == playlist_id && p.contains("tracks")) {
      nlohmann::json next = nlohmann::json::array();
      for (const auto& t : p["tracks"]) {
        if (t.value("id", "") != track_id) next.push_back(t);
      }
      p["tracks"] = std::move(next);
      mark_dirty();
      return p["tracks"];
    }
  }
  return nlohmann::json::array();
}

nlohmann::json DataStore::add_imported_playlist(const std::string& name, const nlohmann::json& tracks) {
  std::lock_guard lk(mutex_);
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string id = "pl_" + std::to_string(ms);
  nlohmann::json pl = {{"id", id}, {"name", name}, {"tracks", tracks}};
  data_["playlists"].push_back(pl);
  mark_dirty();
  return {{"id", id}, {"name", name}, {"trackCount", tracks.size()}};
}

nlohmann::json DataStore::get_playback_state() {
  std::lock_guard lk(mutex_);
  return data_["playback"];
}

void DataStore::save_playback_state(const nlohmann::json& state) {
  std::lock_guard lk(mutex_);
  if (state.is_object() && state.contains("queue") && state["queue"].is_array()) {
    data_["playback"]["queue"] = state["queue"];
    int idx = state.value("currentIndex", -1);
    int qsz = static_cast<int>(data_["playback"]["queue"].size());
    data_["playback"]["currentIndex"] = (idx >= -1 && idx < qsz) ? idx : -1;
    mark_dirty();
  }
}

nlohmann::json DataStore::get_history() {
  std::lock_guard lk(mutex_);
  return data_["history"];
}

void DataStore::record_history(const nlohmann::json& track) {
  std::lock_guard lk(mutex_);
  std::string id = track.value("id", "");
  if (id.empty()) return;
  int old_count = 0;
  nlohmann::json rest = nlohmann::json::array();
  for (const auto& h : data_["history"]) {
    if (h.value("id", "") == id) old_count = (std::max)(old_count, h.value("playCount", 0));
    else if (rest.size() < 499) rest.push_back(h);
  }
  nlohmann::json item = track;
  item["playedAt"] = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  item["playCount"] = old_count + 1;
  nlohmann::json next = nlohmann::json::array();
  next.push_back(std::move(item));
  for (auto& h : rest) next.push_back(std::move(h));
  data_["history"] = std::move(next);
  mark_dirty();
}

void DataStore::clear_history() {
  std::lock_guard lk(mutex_);
  data_["history"] = nlohmann::json::array();
  mark_dirty();
}

void DataStore::remove_history_track(const std::string& track_id) {
  std::lock_guard lk(mutex_);
  nlohmann::json next = nlohmann::json::array();
  for (const auto& h : data_["history"]) {
    if (h.value("id", "") != track_id) next.push_back(h);
  }
  data_["history"] = std::move(next);
  mark_dirty();
}

nlohmann::json DataStore::dump_all() {
  std::lock_guard lk(mutex_);
  return data_;
}

void DataStore::replace_all(nlohmann::json imported_data) {
  std::lock_guard lk(mutex_);
  if (imported_data.is_object()) {
    data_ = std::move(imported_data);
    data_["schemaVersion"] = SCHEMA_VERSION;
    data_["settings"] = normalize_settings(data_.value("settings", nlohmann::json::object()));
    mark_dirty();
  }
}

}  // namespace mintpy

#pragma once

#include <string>
#include "json.hpp"

namespace mintpy {

inline std::string jstr(const nlohmann::json& j, const char* key, const std::string& def = "") {
  if (!j.is_object()) return def;
  auto it = j.find(key);
  if (it == j.end() || !it->is_string()) return def;
  return it->get<std::string>();
}

inline double jnum(const nlohmann::json& j, const char* key, double def = 0.0) {
  if (!j.is_object()) return def;
  auto it = j.find(key);
  if (it == j.end() || !it->is_number()) return def;
  return it->get<double>();
}

inline int jint(const nlohmann::json& j, const char* key, int def = 0) {
  if (!j.is_object()) return def;
  auto it = j.find(key);
  if (it == j.end() || !it->is_number()) return def;
  return static_cast<int>(it->get<double>());
}

inline bool jbool(const nlohmann::json& j, const char* key, bool def = false) {
  if (!j.is_object()) return def;
  auto it = j.find(key);
  if (it == j.end() || !it->is_boolean()) return def;
  return it->get<bool>();
}

}  // namespace mintpy

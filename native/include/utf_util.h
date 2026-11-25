#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace mintpy {

inline std::wstring utf8_to_wide(const std::string& s) {
  if (s.empty()) return {};
  int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (len <= 0) {
    len = MultiByteToWideChar(CP_ACP, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (len <= 0) return {};
    std::wstring out(len, L'\0');
    MultiByteToWideChar(CP_ACP, 0, s.data(), static_cast<int>(s.size()), out.data(), len);
    return out;
  }
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), len);
  return out;
}

inline std::string wide_to_utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int len = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (len <= 0) return {};
  std::string out(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), len, nullptr, nullptr);
  return out;
}

inline std::string latin1_to_utf8(const char* data, size_t len) {
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; ++i) {
    unsigned char c = static_cast<unsigned char>(data[i]);
    if (c == 0) break;
    if (c < 0x80) {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back(static_cast<char>(0xC0 | (c >> 6)));
      out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    }
  }
  return out;
}

inline std::string utf16_bytes_to_utf8(const char* data, size_t len, bool big_endian) {
  if (len < 2) return {};
  size_t count = len / 2;
  std::wstring ws;
  ws.reserve(count);
  for (size_t i = 0; i + 1 < len; i += 2) {
    uint16_t ch = big_endian
      ? (static_cast<uint16_t>(static_cast<unsigned char>(data[i])) << 8) | static_cast<unsigned char>(data[i + 1])
      : static_cast<uint16_t>(static_cast<unsigned char>(data[i])) | (static_cast<uint16_t>(static_cast<unsigned char>(data[i + 1])) << 8);
    if (ch == 0) break;
    ws.push_back(static_cast<wchar_t>(ch));
  }
  return wide_to_utf8(ws);
}

inline std::string trim_copy(std::string s) {
  auto is_ws = [](unsigned char c) { return std::isspace(c) != 0; };
  s.erase(s.begin(), std::find_if_not(s.begin(), s.end(), is_ws));
  s.erase(std::find_if_not(s.rbegin(), s.rend(), is_ws).base(), s.end());
  return s;
}

inline std::string to_lower_ascii(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

inline std::string url_encode(const std::string& s) {
  static const char hex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(s.size() * 3);
  for (unsigned char c : s) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(hex[(c >> 4) & 0xF]);
      out.push_back(hex[c & 0xF]);
    }
  }
  return out;
}

inline std::string url_decode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) {
      auto hexval = [](char ch) -> int {
        if (ch >= '0' && ch <= '9') return ch - '0';
        if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
        if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
        return -1;
      };
      int hi = hexval(s[i + 1]);
      int lo = hexval(s[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    } else if (s[i] == '+') {
      out.push_back(' ');
      continue;
    }
    out.push_back(s[i]);
  }
  return out;
}

inline std::string sha1_hex(const void* data, size_t len) {
  BCRYPT_ALG_HANDLE hAlg = nullptr;
  BCRYPT_HASH_HANDLE hHash = nullptr;
  DWORD hashLen = 20, cbData = 0;
  unsigned char hash[20] = {};
  if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) == 0) {
    DWORD objSize = 0;
    BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objSize), sizeof(objSize), &cbData, 0);
    std::vector<unsigned char> hashObj(objSize);
    if (BCryptCreateHash(hAlg, &hHash, hashObj.data(), objSize, nullptr, 0, 0) == 0) {
      BCryptHashData(hHash, static_cast<PUCHAR>(const_cast<void*>(data)), static_cast<ULONG>(len), 0);
      BCryptFinishHash(hHash, hash, hashLen, 0);
      BCryptDestroyHash(hHash);
    }
    BCryptCloseAlgorithmProvider(hAlg, 0);
  }
  static const char hex[] = "0123456789abcdef";
  std::string out(40, '0');
  for (size_t i = 0; i < 20; ++i) {
    out[i * 2] = hex[(hash[i] >> 4) & 0xF];
    out[i * 2 + 1] = hex[hash[i] & 0xF];
  }
  return out;
}

inline std::string sha1_hex(const std::string& s) {
  return sha1_hex(s.data(), s.size());
}

inline std::string base64_encode(const unsigned char* data, size_t len) {
  if (!data || len == 0) return {};
  DWORD outLen = 0;
  if (!CryptBinaryToStringA(data, static_cast<DWORD>(len), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &outLen)) {
    return {};
  }
  std::string out(outLen, '\0');
  if (!CryptBinaryToStringA(data, static_cast<DWORD>(len), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, out.data(), &outLen)) {
    return {};
  }
  while (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

inline std::vector<unsigned char> base64_decode(const std::string& b64) {
  if (b64.empty()) return {};
  DWORD outLen = 0;
  if (!CryptStringToBinaryA(b64.data(), static_cast<DWORD>(b64.size()), CRYPT_STRING_BASE64, nullptr, &outLen, nullptr, nullptr)) {
    return {};
  }
  std::vector<unsigned char> out(outLen);
  if (!CryptStringToBinaryA(b64.data(), static_cast<DWORD>(b64.size()), CRYPT_STRING_BASE64, out.data(), &outLen, nullptr, nullptr)) {
    return {};
  }
  out.resize(outLen);
  return out;
}

inline bool path_is_inside(const std::filesystem::path& child, const std::filesystem::path& root) {
  std::error_code ec;
  auto c = std::filesystem::weakly_canonical(child, ec);
  if (ec) return false;
  auto r = std::filesystem::weakly_canonical(root, ec);
  if (ec) return false;
  auto rel = std::filesystem::relative(c, r, ec);
  if (ec || rel.empty()) return false;
  auto relStr = rel.wstring();
  if (relStr == L"." || relStr == L".." || relStr.rfind(L"..\\", 0) == 0 || relStr.rfind(L"../", 0) == 0) return false;
  return !rel.is_absolute();
}

}  // namespace mintpy

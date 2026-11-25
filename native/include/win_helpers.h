#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include "utf_util.h"

namespace mintpy {

inline std::filesystem::path get_app_data_dir() {
  PWSTR raw = nullptr;
  std::filesystem::path res;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &raw)) && raw) {
    res = std::filesystem::path(raw) / L"mintpy";
    CoTaskMemFree(raw);
  } else {
    wchar_t buf[MAX_PATH]{};
    GetEnvironmentVariableW(L"APPDATA", buf, MAX_PATH);
    res = std::filesystem::path(buf) / L"mintpy";
  }
  std::error_code ec;
  std::filesystem::create_directories(res, ec);
  return res;
}

inline std::filesystem::path find_app_root() {
  wchar_t exe_buf[MAX_PATH]{};
  GetModuleFileNameW(nullptr, exe_buf, MAX_PATH);
  std::filesystem::path dir = std::filesystem::path(exe_buf).parent_path();
  std::error_code ec;
  for (int up = 0; up < 4; ++up) {
    if (std::filesystem::exists(dir / L"src" / L"index.html", ec)) {
      return dir;
    }
    if (std::filesystem::exists(dir / L"resources" / L"app" / L"src" / L"index.html", ec)) {
      return dir / L"resources" / L"app";
    }
    if (!dir.has_parent_path() || dir == dir.parent_path()) break;
    dir = dir.parent_path();
  }
  return std::filesystem::current_path(ec);
}

inline std::wstring find_ytdlp_exe(const std::filesystem::path& app_root) {
  wchar_t exe_buf[MAX_PATH]{};
  GetModuleFileNameW(nullptr, exe_buf, MAX_PATH);
  std::filesystem::path exe_dir = std::filesystem::path(exe_buf).parent_path();
  std::error_code ec;
  for (const auto& cand : {
           app_root / L"bin" / L"yt-dlp.exe",
           exe_dir / L"bin" / L"yt-dlp.exe",
           exe_dir / L"resources" / L"bin" / L"yt-dlp.exe"
       }) {
    if (std::filesystem::exists(cand, ec)) return cand.wstring();
  }
  return L"";
}

inline std::wstring pick_folder_dialog(HWND owner) {
  std::wstring selected;
  IFileOpenDialog* dlg = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (SUCCEEDED(dlg->Show(owner))) {
      IShellItem* item = nullptr;
      if (SUCCEEDED(dlg->GetResult(&item))) {
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
          selected = path;
          CoTaskMemFree(path);
        }
        item->Release();
      }
    }
    dlg->Release();
  }
  return selected;
}

inline std::wstring pick_open_file_dialog(HWND owner, const wchar_t* filter_name, const wchar_t* filter_spec) {
  std::wstring selected;
  IFileOpenDialog* dlg = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
    COMDLG_FILTERSPEC spec{filter_name, filter_spec};
    dlg->SetFileTypes(1, &spec);
    if (SUCCEEDED(dlg->Show(owner))) {
      IShellItem* item = nullptr;
      if (SUCCEEDED(dlg->GetResult(&item))) {
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
          selected = path;
          CoTaskMemFree(path);
        }
        item->Release();
      }
    }
    dlg->Release();
  }
  return selected;
}

inline std::wstring pick_save_file_dialog(HWND owner, const wchar_t* default_name, const wchar_t* filter_name, const wchar_t* filter_spec) {
  std::wstring selected;
  IFileSaveDialog* dlg = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
    COMDLG_FILTERSPEC spec{filter_name, filter_spec};
    dlg->SetFileTypes(1, &spec);
    if (default_name) dlg->SetFileName(default_name);
    dlg->SetDefaultExtension(L"json");
    if (SUCCEEDED(dlg->Show(owner))) {
      IShellItem* item = nullptr;
      if (SUCCEEDED(dlg->GetResult(&item))) {
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
          selected = path;
          CoTaskMemFree(path);
        }
        item->Release();
      }
    }
    dlg->Release();
  }
  return selected;
}

inline bool create_desktop_shortcut() {
  wchar_t exe_buf[MAX_PATH]{};
  GetModuleFileNameW(nullptr, exe_buf, MAX_PATH);
  PWSTR desktop_raw = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_Desktop, 0, nullptr, &desktop_raw)) || !desktop_raw) return false;
  std::filesystem::path lnk = std::filesystem::path(desktop_raw) / L"MintPy.lnk";
  CoTaskMemFree(desktop_raw);

  IShellLinkW* psl = nullptr;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&psl)))) return false;
  psl->SetPath(exe_buf);
  psl->SetDescription(L"MintPy Zen Audio Player");
  psl->SetIconLocation(exe_buf, 0);
  IPersistFile* ppf = nullptr;
  bool ok = false;
  if (SUCCEEDED(psl->QueryInterface(IID_PPV_ARGS(&ppf)))) {
    ok = SUCCEEDED(ppf->Save(lnk.c_str(), TRUE));
    ppf->Release();
  }
  psl->Release();
  return ok;
}

inline bool parse_hotkey_accelerator(const std::string& acc, UINT& modifiers, UINT& vk) {
  modifiers = 0;
  vk = 0;
  if (acc.empty()) return false;
  std::istringstream iss(acc);
  std::string tok;
  while (std::getline(iss, tok, '+')) {
    tok = trim_copy(tok);
    std::string low = to_lower_ascii(tok);
    if (low == "control" || low == "ctrl") modifiers |= MOD_CONTROL;
    else if (low == "alt") modifiers |= MOD_ALT;
    else if (low == "shift") modifiers |= MOD_SHIFT;
    else if (low == "super" || low == "meta") modifiers |= MOD_WIN;
    else {
      if (low.rfind("key", 0) == 0 && low.size() == 4) low = low.substr(3);
      if (low.size() == 1 && ((low[0] >= 'a' && low[0] <= 'z') || (low[0] >= '0' && low[0] <= '9'))) {
        vk = static_cast<UINT>(std::toupper(static_cast<unsigned char>(low[0])));
      } else if (low == "space") vk = VK_SPACE;
      else if (low == "arrowup" || low == "up") vk = VK_UP;
      else if (low == "arrowdown" || low == "down") vk = VK_DOWN;
      else if (low == "arrowleft" || low == "left") vk = VK_LEFT;
      else if (low == "arrowright" || low == "right") vk = VK_RIGHT;
      else if (low == "m") vk = 'M';
    }
  }
  return vk != 0;
}

}  // namespace mintpy

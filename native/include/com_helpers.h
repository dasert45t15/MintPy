#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include "WebView2.h"

#include <atomic>
#include <functional>
#include <string>
#include <vector>

namespace mintpy {

template <typename T, const IID* Iid>
class ComCallback1 : public T {
 public:
  ComCallback1() = default;
  virtual ~ComCallback1() = default;

  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG c = --ref_;
    if (c == 0) delete this;
    return c;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == *Iid) {
      *ppv = static_cast<T*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

 private:
  std::atomic<ULONG> ref_{1};
};

class EnvCompletedHandler final : public ComCallback1<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, &IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
 public:
  explicit EnvCompletedHandler(std::function<void(HRESULT, ICoreWebView2Environment*)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT res, ICoreWebView2Environment* env) override {
    if (fn_) fn_(res, env);
    return S_OK;
  }
 private:
  std::function<void(HRESULT, ICoreWebView2Environment*)> fn_;
};

class ControllerCompletedHandler final : public ComCallback1<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, &IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
 public:
  explicit ControllerCompletedHandler(std::function<void(HRESULT, ICoreWebView2Controller*)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT res, ICoreWebView2Controller* ctrl) override {
    if (fn_) fn_(res, ctrl);
    return S_OK;
  }
 private:
  std::function<void(HRESULT, ICoreWebView2Controller*)> fn_;
};

class WebMessageHandler final : public ComCallback1<ICoreWebView2WebMessageReceivedEventHandler, &IID_ICoreWebView2WebMessageReceivedEventHandler> {
 public:
  explicit WebMessageHandler(std::function<void(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args) override {
    if (fn_) fn_(sender, args);
    return S_OK;
  }
 private:
  std::function<void(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*)> fn_;
};

class WebResourceHandler final : public ComCallback1<ICoreWebView2WebResourceRequestedEventHandler, &IID_ICoreWebView2WebResourceRequestedEventHandler> {
 public:
  explicit WebResourceHandler(std::function<void(ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) override {
    if (fn_) fn_(sender, args);
    return S_OK;
  }
 private:
  std::function<void(ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*)> fn_;
};

class NavigationCompletedHandler final : public ComCallback1<ICoreWebView2NavigationCompletedEventHandler, &IID_ICoreWebView2NavigationCompletedEventHandler> {
 public:
  explicit NavigationCompletedHandler(std::function<void(ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) override {
    if (fn_) fn_(sender, args);
    return S_OK;
  }
 private:
  std::function<void(ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*)> fn_;
};

// Minimal COM implementation of ICoreWebView2CustomSchemeRegistration & ICoreWebView2EnvironmentOptions
// for registering cover:// protocol without requiring MSVC-only WRL wrl/implements.h
class CustomSchemeReg final : public ICoreWebView2CustomSchemeRegistration {
 public:
  explicit CustomSchemeReg(std::wstring scheme) : scheme_(std::move(scheme)) {}
  virtual ~CustomSchemeReg() = default;

  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG c = --ref_;
    if (c == 0) delete this;
    return c;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_ICoreWebView2CustomSchemeRegistration) {
      *ppv = static_cast<ICoreWebView2CustomSchemeRegistration*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  HRESULT STDMETHODCALLTYPE get_SchemeName(LPWSTR* schemeName) override {
    if (!schemeName) return E_POINTER;
    size_t sz = (scheme_.size() + 1) * sizeof(wchar_t);
    *schemeName = static_cast<LPWSTR>(CoTaskMemAlloc(sz));
    if (!*schemeName) return E_OUTOFMEMORY;
    memcpy(*schemeName, scheme_.c_str(), sz);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_TreatAsSecure(BOOL* value) override {
    if (!value) return E_POINTER;
    *value = TRUE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE put_TreatAsSecure(BOOL) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE GetAllowedOrigins(UINT32* count, LPWSTR** origins) override {
    if (!count || !origins) return E_POINTER;
    static const wchar_t kStar[] = L"*";
    *count = 1;
    *origins = static_cast<LPWSTR*>(CoTaskMemAlloc(sizeof(LPWSTR)));
    (*origins)[0] = static_cast<LPWSTR>(CoTaskMemAlloc(sizeof(kStar)));
    memcpy((*origins)[0], kStar, sizeof(kStar));
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetAllowedOrigins(UINT32, LPCWSTR*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE get_HasAuthorityComponent(BOOL* value) override {
    if (!value) return E_POINTER;
    *value = TRUE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE put_HasAuthorityComponent(BOOL) override { return S_OK; }

 private:
  std::atomic<ULONG> ref_{1};
  std::wstring scheme_;
};

class EnvOptionsWithCover final : public ICoreWebView2EnvironmentOptions, public ICoreWebView2EnvironmentOptions4 {
 public:
  explicit EnvOptionsWithCover(std::wstring additional_args = L"")
      : additional_args_(std::move(additional_args)), cover_reg_(new CustomSchemeReg(L"cover")) {}
  virtual ~EnvOptionsWithCover() {
    if (cover_reg_) cover_reg_->Release();
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG c = --ref_;
    if (c == 0) delete this;
    return c;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_ICoreWebView2EnvironmentOptions) {
      *ppv = static_cast<ICoreWebView2EnvironmentOptions*>(this);
      AddRef();
      return S_OK;
    }
    if (riid == IID_ICoreWebView2EnvironmentOptions4) {
      *ppv = static_cast<ICoreWebView2EnvironmentOptions4*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  HRESULT STDMETHODCALLTYPE get_AdditionalBrowserArguments(LPWSTR* value) override {
    if (!value) return E_POINTER;
    if (additional_args_.empty()) { *value = nullptr; return S_OK; }
    size_t sz = (additional_args_.size() + 1) * sizeof(wchar_t);
    *value = static_cast<LPWSTR>(CoTaskMemAlloc(sz));
    memcpy(*value, additional_args_.c_str(), sz);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE put_AdditionalBrowserArguments(LPCWSTR v) override {
    additional_args_ = v ? v : L"";
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_Language(LPWSTR* value) override { if (value) *value = nullptr; return S_OK; }
  HRESULT STDMETHODCALLTYPE put_Language(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE get_TargetCompatibleBrowserVersion(LPWSTR* value) override {
    if (!value) return E_POINTER;
    static const wchar_t ver[] = L"120.0.0.0";
    *value = static_cast<LPWSTR>(CoTaskMemAlloc(sizeof(ver)));
    memcpy(*value, ver, sizeof(ver));
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE put_TargetCompatibleBrowserVersion(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE get_AllowSingleSignOnUsingOSPrimaryAccount(BOOL* v) override {
    if (!v) return E_POINTER;
    *v = FALSE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE put_AllowSingleSignOnUsingOSPrimaryAccount(BOOL) override { return S_OK; }

  HRESULT STDMETHODCALLTYPE GetCustomSchemeRegistrations(UINT32* count, ICoreWebView2CustomSchemeRegistration*** regs) override {
    if (!count || !regs) return E_POINTER;
    *count = 1;
    *regs = static_cast<ICoreWebView2CustomSchemeRegistration**>(CoTaskMemAlloc(sizeof(ICoreWebView2CustomSchemeRegistration*)));
    (*regs)[0] = cover_reg_;
    cover_reg_->AddRef();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetCustomSchemeRegistrations(UINT32, ICoreWebView2CustomSchemeRegistration**) override {
    return S_OK;
  }

 private:
  std::atomic<ULONG> ref_{1};
  std::wstring additional_args_;
  CustomSchemeReg* cover_reg_;
};

}  // namespace mintpy

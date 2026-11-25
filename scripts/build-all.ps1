$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
  Write-Host "=== [1/5] Syntax check ==="
  node scripts/check-syntax.js
  if ($LASTEXITCODE -ne 0) { throw "Syntax check failed" }

  Write-Host "=== [2/5] Architecture & unit tests ==="
  node --test
  if ($LASTEXITCODE -ne 0) { throw "Unit tests failed" }

  Write-Host "=== [3/5] Building Windows Native C++20 binary ==="
  powershell -ExecutionPolicy Bypass -File scripts/build-cpp.ps1
  if ($LASTEXITCODE -ne 0) { throw "Native C++ build failed" }

  Write-Host "=== [4/5] Building Windows NSIS Installer & Portable archive ==="
  powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }

  Write-Host "=== [5/5] Building signed Android APK ==="
  python scripts/build-android-apk.py
  if ($LASTEXITCODE -ne 0) { throw "Android APK build failed" }

  Write-Host "`nALL RELEASES BUILT SUCCESSFULLY:"
  Get-ChildItem (Join-Path $Root "releases") | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
} finally {
  Pop-Location
}

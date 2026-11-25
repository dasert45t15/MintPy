$ErrorActionPreference = "Stop"
Stop-Process -Name "MintPy-Native" -Force -ErrorAction SilentlyContinue

$Root = Split-Path -Parent $PSScriptRoot
$NativeDir = Join-Path $Root "native"
$OutDir = Join-Path $Root "releases"
$OutExe = Join-Path $OutDir "MintPy-Native.exe"
$WebView2Include = Join-Path $Root "tools\webview2\build\native\include"
$WebView2Dll = Join-Path $Root "tools\webview2\build\native\x64\WebView2Loader.dll"

# Find g++ in PATH or WinGet WinLibs package
$GppCmd = Get-Command g++ -ErrorAction SilentlyContinue
if ($GppCmd) {
  $Gpp = $GppCmd.Source
} else {
  $Found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "g++.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $Found) { throw "g++.exe not found. Install WinLibs MinGW-w64 UCRT." }
  $Gpp = $Found.FullName
}

if (-not (Test-Path (Join-Path $WebView2Include "WebView2.h"))) {
  throw "WebView2 SDK not found in tools\webview2. Download Microsoft.Web.WebView2 NuGet first."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Sources = @(
  (Join-Path $NativeDir "src\main.cpp"),
  (Join-Path $NativeDir "src\http_client.cpp"),
  (Join-Path $NativeDir "src\tag_scanner.cpp"),
  (Join-Path $NativeDir "src\audio_proxy.cpp"),
  (Join-Path $NativeDir "src\data_store.cpp"),
  (Join-Path $NativeDir "src\discord_ipc.cpp")
)

$BinDir = Split-Path $Gpp
$Windres = Join-Path $BinDir "windres.exe"
$RcFile = Join-Path $NativeDir "res\resource.rc"
$ResFile = Join-Path $NativeDir "res\resource.res"

if ((Test-Path $Windres) -and (Test-Path $RcFile)) {
  Write-Host "Compiling Windows resource icon with windres..."
  & $Windres -i $RcFile -O coff -o $ResFile
  if ($LASTEXITCODE -eq 0 -and (Test-Path $ResFile)) {
    $Sources += $ResFile
  }
}

$Args = @(
  "-std=c++20",
  "-O3",
  "-DNDEBUG",
  "-DUNICODE",
  "-D_UNICODE",
  "-DWINVER=0x0A00",
  "-D_WIN32_WINNT=0x0A00",
  "-municode",
  "-mwindows",
  "-I$($NativeDir)\include",
  "-I$($NativeDir)\third_party",
  "-I$WebView2Include"
) + $Sources + @(
  "-o", $OutExe,
  "-static",
  "-static-libgcc",
  "-static-libstdc++",
  "-lwinhttp",
  "-lws2_32",
  "-lbcrypt",
  "-lcrypt32",
  "-lgdiplus",
  "-lole32",
  "-loleaut32",
  "-lshell32",
  "-lshlwapi",
  "-luuid",
  "-ldwmapi",
  "-luser32",
  "-lgdi32"
)

Write-Host "Compiling MintPy-Native.exe with $Gpp..."
& $Gpp @Args
if ($LASTEXITCODE -ne 0) {
  throw "Compilation failed with exit code $LASTEXITCODE"
}

if (Test-Path $WebView2Dll) {
  Copy-Item -Force $WebView2Dll (Join-Path $OutDir "WebView2Loader.dll")
}

if (-not ((Test-Path $OutExe) -and ((Get-Item $OutExe).Length -gt 0))) {
  throw "Compiled binary missing or empty: $OutExe"
}

# Clean up temporary resource file and old versioned native builds
if (Test-Path $ResFile) {
  Remove-Item -Force $ResFile -ErrorAction SilentlyContinue
}
$OldNativePatterns = @("MintPy-Native-*.exe", "MintPy-Native.exe.bak", "*.tmp")
foreach ($Pattern in $OldNativePatterns) {
  Get-ChildItem -Path $OutDir -Filter $Pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -notin @("MintPy-Native.exe", "MintPy-Setup.exe", "WebView2Loader.dll")) {
      Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
      Write-Host "Removed old native build artifact: $($_.Name)"
    }
  }
}

$SizeMB = [math]::Round((Get-Item $OutExe).Length / 1MB, 2)
Write-Host "SUCCESS! Built $OutExe ($SizeMB MB)"

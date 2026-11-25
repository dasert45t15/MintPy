$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$NsisScript = Join-Path $Root "scripts\installer.nsi"
$OutExe = Join-Path $Root "releases\MintPy-Setup.exe"

# Search for makensis.exe
$MakensisCmd = Get-Command makensis -ErrorAction SilentlyContinue
if ($MakensisCmd) {
  $Makensis = $MakensisCmd.Source
} else {
  $Found = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache" -Filter "makensis.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $Found) {
    $Found = Get-ChildItem "C:\Program Files", "C:\Program Files (x86)", $env:LOCALAPPDATA -Filter "makensis.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $Found) {
    throw "makensis.exe not found on the system."
  }
  $Makensis = $Found.FullName
}

Write-Host "Compiling installer using $Makensis..."
Set-Location (Split-Path $NsisScript)
& $Makensis $NsisScript

if ($LASTEXITCODE -ne 0) {
  throw "makensis failed with exit code $LASTEXITCODE"
}

if (-not ((Test-Path $OutExe) -and ((Get-Item $OutExe).Length -gt 0))) {
  throw "Installer was not created or is empty: $OutExe"
}

# Clean up old PC installer/portable/bundler artifacts after verified build
$ReleasesDir = Join-Path $Root "releases"
$ProtectedNames = @("MintPy-Native.exe", "MintPy-Setup.exe", "WebView2Loader.dll")
$OldInstallerPatterns = @(
  "MintPy Setup *.exe",
  "MintPy-Setup-*.exe",
  "MintPy *.exe",
  "*.blockmap",
  "builder-*.yml",
  "latest.yml"
)
foreach ($Pattern in $OldInstallerPatterns) {
  Get-ChildItem -Path $ReleasesDir -Filter $Pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -notin $ProtectedNames -and $_.Extension -ne ".apk") {
      Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
      Write-Host "Removed old installer artifact: $($_.Name)"
    }
  }
}
$UnpackedDir = Join-Path $ReleasesDir "win-unpacked"
if (Test-Path $UnpackedDir) {
  Remove-Item -Recurse -Force $UnpackedDir -ErrorAction SilentlyContinue
  Write-Host "Removed old unpacked folder: win-unpacked"
}

$SizeMB = [math]::Round((Get-Item $OutExe).Length / 1MB, 2)
Write-Host "SUCCESS! Created $OutExe ($SizeMB MB)"

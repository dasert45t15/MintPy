$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Pkg = Get-Content (Join-Path $Root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$Pkg.version
$NsisScript = Join-Path $Root "scripts\installer.nsi"
$ReleasesDir = Join-Path $Root "releases"
$OutExe = Join-Path $ReleasesDir "MintPy-Setup.exe"
$PortableZip = Join-Path $ReleasesDir "MintPy-Portable-v$Version-win64.zip"

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

Write-Host "Compiling MintPy v$Version installer using $Makensis..."
Push-Location (Split-Path $NsisScript)
try {
  & $Makensis "/DPRODUCT_VERSION=$Version" $NsisScript
  if ($LASTEXITCODE -ne 0) {
    throw "makensis failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

if (-not ((Test-Path $OutExe) -and ((Get-Item $OutExe).Length -gt 0))) {
  throw "Installer was not created or is empty: $OutExe"
}

# Build matching compact Portable x64 zip (excludes mobile-only wallpapers)
$Stage = Join-Path $env:TEMP ("mintpy_portable_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
try {
  Copy-Item (Join-Path $ReleasesDir "MintPy-Native.exe"), (Join-Path $ReleasesDir "WebView2Loader.dll"), (Join-Path $Root "package.json"), (Join-Path $Root "LICENSE"), (Join-Path $Root "README.md") -Destination $Stage
  Copy-Item -Recurse (Join-Path $Root "shared") -Destination (Join-Path $Stage "shared")
  Copy-Item -Recurse (Join-Path $Root "src") -Destination (Join-Path $Stage "src")
  Copy-Item -Recurse (Join-Path $Root "assets") -Destination (Join-Path $Stage "assets")
  $MobThemesInPortable = Join-Path $Stage "assets\themes\mobile"
  if (Test-Path $MobThemesInPortable) {
    Remove-Item -Recurse -Force $MobThemesInPortable
  }
  Get-ChildItem -Path (Join-Path $Stage "assets") -Filter "*-chroma.png" -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
  if (Test-Path $PortableZip) { Remove-Item -Force $PortableZip }
  Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $PortableZip -CompressionLevel Optimal
} finally {
  if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
}

# Clean up old PC installer & portable artifacts after verified build
$ProtectedNames = @("MintPy-Native.exe", "MintPy-Setup.exe", (Split-Path $PortableZip -Leaf), "WebView2Loader.dll")
$OldInstallerPatterns = @(
  "MintPy Setup *.exe",
  "MintPy-Setup-*.exe",
  "MintPy *.exe",
  "MintPy-Portable-*.zip",
  "*.blockmap",
  "builder-*.yml",
  "latest.yml"
)
foreach ($Pattern in $OldInstallerPatterns) {
  Get-ChildItem -Path $ReleasesDir -Filter $Pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -notin $ProtectedNames -and $_.Extension -ne ".apk") {
      Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
      Write-Host "Removed old PC artifact: $($_.Name)"
    }
  }
}

$SizeMB = [math]::Round((Get-Item $OutExe).Length / 1MB, 2)
$ZipMB = [math]::Round((Get-Item $PortableZip).Length / 1MB, 2)
Write-Host "SUCCESS! Created $OutExe ($SizeMB MB) and $PortableZip ($ZipMB MB)"

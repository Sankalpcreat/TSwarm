$ErrorActionPreference = "Stop"

$Repo = "Sankalpcreat/TSwarm"
$Product = "canvas-terminal"
$Api = "https://api.github.com/repos/$Repo/releases/latest"

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

$release = Invoke-RestMethod -Uri $Api -UseBasicParsing
$assets = $release.assets | ForEach-Object { $_.browser_download_url }

$patterns = @(
  "$arch-setup.exe",
  "$arch.msi",
  "$arch.exe",
  "setup.exe",
  ".msi",
  ".exe"
)

$assetUrl = $null
foreach ($p in $patterns) {
  $assetUrl = $assets | Where-Object { $_ -like "*$p" } | Select-Object -First 1
  if ($assetUrl) { break }
}

if (-not $assetUrl) {
  throw "No matching release asset found"
}

$tmp = New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetTempPath() + "tswarm")
$installer = Join-Path $tmp.FullName "installer.exe"

Invoke-WebRequest -Uri $assetUrl -OutFile $installer
Start-Process -FilePath $installer -Wait
Write-Host "Installed. You can now run $Product from Start Menu."

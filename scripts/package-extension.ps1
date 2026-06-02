$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageJsonPath = Join-Path $Root "package.json"
$PackageJson = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$Version = $PackageJson.version
$Dist = Join-Path $Root "dist"
$Manifest = Join-Path $Dist "manifest.json"
$ReleaseDir = Join-Path $Root "release"
$ZipPath = Join-Path $ReleaseDir "s3marks-v$Version.zip"

if (-not (Test-Path -LiteralPath $Manifest)) {
  throw "dist/manifest.json does not exist. Run npm run build first."
}

if (-not (Test-Path -LiteralPath $ReleaseDir)) {
  New-Item -ItemType Directory -Path $ReleaseDir | Out-Null
}

if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath
}

Push-Location $Dist
try {
  Compress-Archive -Path * -DestinationPath $ZipPath -CompressionLevel Optimal
} finally {
  Pop-Location
}

Write-Host "Created extension package: $ZipPath"

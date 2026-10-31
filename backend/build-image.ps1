$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$imageName = 'circuit-sim-backend:latest'
$archivePath = Join-Path $PSScriptRoot 'circuit-sim-backend-linux-amd64.tar'
$env:DOCKER_CONFIG = Join-Path $env:TEMP 'circuit-sim-docker-config'
New-Item -ItemType Directory -Path $env:DOCKER_CONFIG -Force | Out-Null

docker build --platform linux/amd64 --tag $imageName $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw "Docker build failed with exit code $LASTEXITCODE" }

docker save --output $archivePath $imageName
if ($LASTEXITCODE -ne 0) { throw "Docker save failed with exit code $LASTEXITCODE" }

$archive = Get-Item -LiteralPath $archivePath
Write-Host "Image archive ready: $($archive.FullName) ($([math]::Round($archive.Length / 1GB, 2)) GB)"

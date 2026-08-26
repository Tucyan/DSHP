param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
& node (Join-Path $PSScriptRoot 'verify-isolation.mjs')
if ($LASTEXITCODE -ne 0) { throw "Isolation verification failed with exit code $LASTEXITCODE" }

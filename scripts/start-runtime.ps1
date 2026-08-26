param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
$env:DSH_HOME = $config.dshHome
$env:DSH_AGENTS_HOME = $config.agentsHome
$env:DSH_WORKSPACE = $config.workspace
if ($DryRun) { [ordered]@{ command='dsh'; cwd=$config.workspace; env=@{ DSH_HOME=$env:DSH_HOME; DSH_AGENTS_HOME=$env:DSH_AGENTS_HOME; DSH_WORKSPACE=$env:DSH_WORKSPACE }; webPort=$config.webPort } | ConvertTo-Json -Depth 4; exit 0 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'init-runtime.ps1')
& dsh --help

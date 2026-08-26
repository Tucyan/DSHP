param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
if ($DryRun) { $config | ConvertTo-Json -Depth 2; exit 0 }
foreach ($name in @('dshHome','agentsHome','workspace','plugins','skills','sessions','storage','credentials')) { New-Item -ItemType Directory -Force -Path $config.$name | Out-Null }
Write-Output "Initialized isolated runtime under $($config.root)"

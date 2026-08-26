param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
$home = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
if ($home -and (([IO.Path]::GetFullPath($config.dshHome)).ToLower() -eq ([IO.Path]::Combine($home,'.dsh')).ToLower() -or ([IO.Path]::GetFullPath($config.agentsHome)).ToLower() -eq ([IO.Path]::Combine($home,'.agents')).ToLower())) { throw 'default home collision' }
foreach ($name in @('dshHome','agentsHome','workspace','plugins','skills','sessions','storage','credentials')) { if (-not ([IO.Path]::GetFullPath($config.$name).StartsWith([IO.Path]::GetFullPath($repo), [StringComparison]::OrdinalIgnoreCase))) { throw "$name escaped repository" } }
Write-Output 'Isolation verified: all runtime paths are repository-local and default homes are untouched.'

param([switch]$DryRun, [switch]$LiveQQ)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
$env:DSH_HOME = $config.dshHome
$env:DSH_AGENTS_HOME = $config.agentsHome
$env:DSH_WORKSPACE = $config.workspace
$env:PGA_RUNTIME_ROOT = $config.root
$env:PGA_PLUGINS_DIR = $config.plugins
$env:PGA_SKILLS_DIR = $config.skills
$env:PGA_SESSIONS_DIR = $config.sessions
$env:PGA_STORAGE_DIR = $config.storage
$env:PGA_CREDENTIALS_DIR = $config.credentials
if ($DryRun) {
  [ordered]@{ command='dsh'; cwd=$config.workspace; args=@('web','--port', [string]$config.webPort); env=@{ DSH_HOME=$env:DSH_HOME; DSH_AGENTS_HOME=$env:DSH_AGENTS_HOME; DSH_WORKSPACE=$env:DSH_WORKSPACE; PGA_RUNTIME_ROOT=$env:PGA_RUNTIME_ROOT; PGA_PLUGINS_DIR=$env:PGA_PLUGINS_DIR; PGA_SKILLS_DIR=$env:PGA_SKILLS_DIR; PGA_SESSIONS_DIR=$env:PGA_SESSIONS_DIR; PGA_STORAGE_DIR=$env:PGA_STORAGE_DIR; PGA_CREDENTIALS_DIR=$env:PGA_CREDENTIALS_DIR }; webPort=$config.webPort } | ConvertTo-Json -Depth 4; exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'init-runtime.ps1')
Set-Location $config.workspace
if ($LiveQQ) {
  if (-not $env:QQBOT_APPID -or -not $env:QQBOT_SECRET) { throw 'Live QQ requires QQBOT_APPID and QQBOT_SECRET in the process environment; no credential file is read.' }
  & dsh web --port $config.webPort
} else {
  & dsh web --port $config.webPort
}

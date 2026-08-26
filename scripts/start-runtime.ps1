param([switch]$DryRun, [switch]$LiveQQ, [string]$PeerId)
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
$disabledPatch = Join-Path $repo 'config/qq-disabled.patch.yml'
$profilePatch = Join-Path $config.dshHome 'profiles/web/cordis.patch.yml'
$livePeer = if ($PeerId) { $PeerId } else { $env:QQ_PEER_ID }
if ($LiveQQ) {
  if (-not $livePeer -or $livePeer -match '[\x00-\x1F\x7F]' -or $livePeer.Contains(':') -or $livePeer.Contains('[') -or $livePeer.Contains(']') -or $livePeer.Contains('"') -or $livePeer.Contains('\')) { throw 'Live QQ requires one safe -PeerId or QQ_PEER_ID.' }
  if (-not (Test-Path -LiteralPath $profilePatch)) { throw 'managed QQ profile overlay is missing; run install-runtime-bundles.ps1 -Install first.' }
  $managedProfile = Get-Content -LiteralPath $profilePatch -Raw
  if (-not $managedProfile.Contains('Personal Growth Agent QQ profile')) { throw 'managed QQ profile overlay is missing; run install-runtime-bundles.ps1 -Install first.' }
  & node (Join-Path $PSScriptRoot 'validate-qq-profile.mjs') --file $profilePatch --peer-id $livePeer
  if ($LASTEXITCODE -ne 0) { throw 'managed QQ profile binding mismatch' }
}
if ($DryRun) {
  $dryArgs = if ($LiveQQ) { @('web','--port', [string]$config.webPort) } else { @('web','--patch',$disabledPatch,'--port', [string]$config.webPort) }
  [ordered]@{ command='corepack'; args=@('pnpm@11.7.0','--filter','@personal-growth/dsh-adapter','exec','dsh') + $dryArgs; cwd=$config.workspace; env=@{ DSH_HOME=$env:DSH_HOME; DSH_AGENTS_HOME=$env:DSH_AGENTS_HOME; DSH_WORKSPACE=$env:DSH_WORKSPACE; PGA_RUNTIME_ROOT=$env:PGA_RUNTIME_ROOT; PGA_PLUGINS_DIR=$env:PGA_PLUGINS_DIR; PGA_SKILLS_DIR=$env:PGA_SKILLS_DIR; PGA_SESSIONS_DIR=$env:PGA_SESSIONS_DIR; PGA_STORAGE_DIR=$env:PGA_STORAGE_DIR; PGA_CREDENTIALS_DIR=$env:PGA_CREDENTIALS_DIR }; webPort=$config.webPort } | ConvertTo-Json -Depth 4; exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'init-runtime.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Location $config.workspace
if ($LiveQQ) {
  if (-not $env:QQBOT_APPID -or -not $env:QQBOT_SECRET) { throw 'Live QQ requires QQBOT_APPID and QQBOT_SECRET in the process environment; no credential file is read.' }
  & corepack pnpm@11.7.0 --filter @personal-growth/dsh-adapter exec dsh web --port $config.webPort
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  & corepack pnpm@11.7.0 --filter @personal-growth/dsh-adapter exec dsh web --patch $disabledPatch --port $config.webPort
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

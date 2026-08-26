param([switch]$Install, [string]$PeerId)
$ErrorActionPreference = 'Stop'
if (-not $Install) { throw 'This is opt-in only. Re-run with -Install to invoke pnpm through DSH for @tencent-connect/dsh-qqbot@0.4.0.' }
if (-not $PeerId -or $PeerId -match '[\x00-\x1F\x7F]' -or $PeerId.Contains(':') -or $PeerId.Contains('[') -or $PeerId.Contains(']') -or $PeerId.Contains('"')) { throw 'A single QQ peer id is required with -PeerId; it is written only to the isolated profile allowlist.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'init-runtime.ps1')
$env:DSH_HOME = $config.dshHome
$env:DSH_AGENTS_HOME = $config.agentsHome
Push-Location $config.workspace
try {
  foreach ($bundle in @('packages/agent-core','packages/personal-memory','packages/personal-heartbeat','packages/qq-adapter')) {
    & dsh plugin --profile web add (Join-Path $repo $bundle)
    if ($LASTEXITCODE -ne 0) { throw "Self bundle installation failed for $bundle with exit code $LASTEXITCODE" }
  }
  & dsh plugin --profile web add '@tencent-connect/dsh-qqbot@0.4.0'
  if ($LASTEXITCODE -ne 0) { throw "Tencent QQ bundle installation failed with exit code $LASTEXITCODE" }
  $profilePatch = Join-Path $config.dshHome 'profiles/web/cordis.patch.yml'
  $patchText = @"
- insert:
    - id: im-qqbot
      name: '@tencent-connect/dsh-qqbot'
      config:
        appId: __FROM_ENV__
        appSecret: __FROM_ENV__
        access:
          c2cMode: allowlist
          c2cAllow: ["$PeerId"]
          groupMode: disabled
          groupAllow: []
        requireMention: true
        debug: false
"@
  if (-not (Test-Path -LiteralPath $profilePatch)) { Set-Content -LiteralPath $profilePatch -Value $patchText -Encoding utf8 }
  elseif (-not ((Get-Content -LiteralPath $profilePatch -Raw).Contains('Personal Growth Agent QQ profile'))) { Add-Content -LiteralPath $profilePatch -Value ("`n# Personal Growth Agent QQ profile`n" + $patchText) -Encoding utf8 }
} finally { Pop-Location }
Write-Output 'Installed the pinned Tencent QQ bundle into the isolated DSH web profile.'

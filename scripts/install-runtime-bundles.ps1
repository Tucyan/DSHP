param([switch]$Install, [string]$PeerId)
$ErrorActionPreference = 'Stop'
if (-not $Install) { throw 'This is opt-in only. Re-run with -Install to invoke pnpm through DSH for @tencent-connect/dsh-qqbot@0.4.0.' }
if (-not $PeerId -or $PeerId -match '[\x00-\x1F\x7F]' -or $PeerId.Contains(':') -or $PeerId.Contains('[') -or $PeerId.Contains(']') -or $PeerId.Contains('"') -or $PeerId.Contains('\')) { throw 'A single QQ peer id is required with -PeerId; it is written only to the isolated profile allowlist.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:PGA_REPO_ROOT = $repo
$config = (& node (Join-Path $PSScriptRoot 'runtime-config.mjs') --json | ConvertFrom-Json)
Push-Location $repo
try {
  & corepack pnpm@11.7.0 build
  if ($LASTEXITCODE -ne 0) { throw "Project build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'init-runtime.ps1')
if ($LASTEXITCODE -ne 0) { throw "Isolated runtime initialization failed with exit code $LASTEXITCODE" }
$env:DSH_HOME = $config.dshHome
$env:DSH_AGENTS_HOME = $config.agentsHome
$profilePatch = Join-Path $config.dshHome 'profiles/web/cordis.patch.yml'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilePatch) | Out-Null
$patchText = (& node (Join-Path $PSScriptRoot 'render-qq-profile.mjs') --peer-id $PeerId | Out-String).TrimEnd()
if ($LASTEXITCODE -ne 0) { throw "QQ profile rendering failed with exit code $LASTEXITCODE" }
$disabledPatchText = (& node (Join-Path $PSScriptRoot 'render-qq-profile.mjs') --peer-id $PeerId --disabled | Out-String).TrimEnd()
if ($LASTEXITCODE -ne 0) { throw "QQ disabled profile rendering failed with exit code $LASTEXITCODE" }
$marker = 'Personal Growth Agent QQ profile'
function Write-AtomicText([string]$path, [string]$content) {
  $temp = "$path.$PID.tmp"
  Set-Content -LiteralPath $temp -Value $content -Encoding utf8
  Move-Item -LiteralPath $temp -Destination $path -Force
}
if (Test-Path -LiteralPath $profilePatch) {
  $existingPatch = Get-Content -LiteralPath $profilePatch -Raw
  if ($existingPatch.Contains($marker)) {
    & node (Join-Path $PSScriptRoot 'validate-qq-profile.mjs') --file $profilePatch --peer-id $PeerId --allow-disabled
    if ($LASTEXITCODE -ne 0) { throw 'managed QQ profile binding mismatch' }
    $profilePrefix = ''
  } elseif ($existingPatch -match '(?m)^\s*-\s+id:\s+im-qqbot\s*$') {
    throw 'existing QQ profile contains an unmanaged im-qqbot row'
  } else {
    $profilePrefix = $existingPatch.TrimEnd() + "`n"
  }
} else {
  $profilePrefix = ''
}
$enabledProfile = $profilePrefix + $patchText + "`n"
$disabledProfile = $profilePrefix + $disabledPatchText + "`n"
# Establish the fail-closed profile before the first plugin installation.
Write-AtomicText $profilePatch $disabledProfile
$installationSucceeded = $false
try {
  Push-Location $config.workspace
  try {
    foreach ($bundle in @('packages/agent-core','packages/personal-memory','packages/personal-heartbeat')) {
      & corepack pnpm@11.7.0 --filter @personal-growth/dsh-adapter exec dsh plugin --profile web add (Join-Path $repo $bundle)
      if ($LASTEXITCODE -ne 0) { throw "Self bundle installation failed for $bundle with exit code $LASTEXITCODE" }
    }
    & corepack pnpm@11.7.0 --filter @personal-growth/dsh-adapter exec dsh plugin --profile web add '@tencent-connect/dsh-qqbot@0.4.0'
    if ($LASTEXITCODE -ne 0) { throw "Tencent QQ bundle installation failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
  $installationSucceeded = $true
} finally {
  if ($installationSucceeded) { Write-AtomicText $profilePatch $enabledProfile }
  else { Write-AtomicText $profilePatch $disabledProfile }
}
Write-Output 'Installed the pinned Tencent QQ bundle into the isolated DSH web profile.'

# V3.1 Windows deployment and rollback

Integrated-source Windows stress (`bun scripts/check-v3-1-lock-stress.ts 3`)
passed three rounds against 302 simulated accounts per
worker. Each tier had exactly two expected `busy` fail-closed probes; all
ordinary operations succeeded. Lock-wait and total durations include the
deliberate approximately 60-second probes, while transaction durations cover
successful callbacks, commits, and releases:

| Processes | Ordinary operations | Expected `busy` probes | Lock wait p95/max (ms) | Transaction p95/max (ms) | Total p95/max (ms) |
| --------- | ------------------- | ---------------------- | ---------------------- | ------------------------ | ------------------ |
| 2         | 22/22               | 2/2                    | 60001/60399            | 1388/1564                | 60001/60399        |
| 4         | 40/40               | 2/2                    | 8919/60548             | 1441/1545                | 10191/60548        |
| 8         | 76/76               | 2/2                    | 16830/60501            | 1371/1395                | 18013/60501        |
| 16        | 148/148             | 2/2                    | 31935/60802            | 1232/1337                | 33138/60802        |

The harness reported zero network attempts, no assertion violations, and a
successful exit. Latencies are machine-dependent measurements, not asserted
thresholds.

This is an operator-run procedure. It must not run from an OmO session: close
**every** OmO process first, including sessions using other models. Do not stop
OmO processes automatically. The source checkout and installed extension must
both be verified before copying. Do not copy account, credential, health-state,
or OmO runtime files.

After the final tests and formatting pass, record the exact tested source bytes
and the current installed source bytes in a local approval manifest. Run this
from the repository root in PowerShell while the current installation is still
untouched:

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path .).Path
$live = Join-Path $env:USERPROFILE '.omo\agent\npm\node_modules\@gwylook\pi-antigravity'
$paths = @(
  'src\health\errors.ts',
  'src\health\private-file.ts',
  'src\health\store.ts',
  'src\runtime\account-credential-source.ts',
  'src\runtime\persistent-credential-source.ts',
  'src\stream\stream.ts',
  'src\types\types.ts'
)
$manifestPath = Join-Path $env:LOCALAPPDATA 'pi-antigravity-v3-1-approved.csv'
$approved = foreach ($path in $paths) {
  [pscustomobject]@{
    RelativePath = $path
    NewSha256 = (Get-FileHash (Join-Path $repo $path) -Algorithm SHA256).Hash
    OldSha256 = (Get-FileHash (Join-Path $live $path) -Algorithm SHA256).Hash
  }
}
$approved | Export-Csv $manifestPath -NoTypeInformation
$approved | Format-Table -AutoSize
```

Review and retain that manifest separately from the source checkout. Do not
regenerate it after sign-off: a changed source file or installed file must fail
the deployment guard. Record the verified branch name and final test results
beside the manifest; record its commit after live validation. Confirm the installed account and health-state counts
without printing credentials, and retain the existing health database intact.

Once all OmO windows and background processes have been closed, open an
independent PowerShell window at the verified repository root and run the
following. `Get-Process omo` checks the installed host executable
(`omo.exe`); it is an absolute deployment gate, not an instruction to
terminate any process:

First, record a read-only baseline in that PowerShell window. Keep the window
open for the deployment and immediate verification; the variables below remain
in that session. The state paths are outside the seven-file copy:

```powershell
$ErrorActionPreference = 'Stop'
if (Get-Process omo -ErrorAction SilentlyContinue) {
  throw 'All OmO processes must be closed before deployment.'
}
$agentDir = if ($env:PI_CODING_AGENT_DIR) {
  $env:PI_CODING_AGENT_DIR
} else {
  Join-Path $env:USERPROFILE '.omo\agent'
}
$settingsPath = Join-Path $agentDir 'pi-antigravity.json'
$accountsPath = if ((Test-Path -LiteralPath $settingsPath -PathType Leaf) -and
    (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).legacyAccountsMigrated) {
  $settingsPath
} else {
  Join-Path $agentDir 'antigravity-accounts.json'
}
$healthPath = Join-Path $agentDir 'antigravity-account-health.json'
$stateBaseline = [pscustomobject]@{
  AccountCount = @((Get-Content -LiteralPath $accountsPath -Raw | ConvertFrom-Json).accounts.PSObject.Properties).Count
  HealthRecordCount = @((Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json).records.PSObject.Properties).Count
  AccountsSha256 = (Get-FileHash -LiteralPath $accountsPath -Algorithm SHA256).Hash
  HealthSha256 = (Get-FileHash -LiteralPath $healthPath -Algorithm SHA256).Hash
}
if ($stateBaseline.AccountCount -ne 302) {
  throw "Expected 302 linked accounts; found $($stateBaseline.AccountCount)."
}
Write-Host "Baseline: $($stateBaseline.AccountCount) accounts, $($stateBaseline.HealthRecordCount) health records."
```

Then run the guarded source deployment in the same window:

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path .).Path
$live = Join-Path $env:USERPROFILE '.omo\agent\npm\node_modules\@gwylook\pi-antigravity'
$manifestPath = Join-Path $env:LOCALAPPDATA 'pi-antigravity-v3-1-approved.csv'
$approved = @(Import-Csv $manifestPath)
$expected = @(
  'src\health\errors.ts',
  'src\health\private-file.ts',
  'src\health\store.ts',
  'src\runtime\account-credential-source.ts',
  'src\runtime\persistent-credential-source.ts',
  'src\stream\stream.ts',
  'src\types\types.ts'
)
if (Get-Process omo -ErrorAction SilentlyContinue) {
  throw 'All OmO processes must be closed before changing the installed extension.'
}
if ($approved.Count -ne 7 -or
    @($approved.RelativePath | Select-Object -Unique).Count -ne 7 -or
    @($approved | Where-Object { $_.RelativePath -notin $expected }).Count -ne 0) {
  throw 'The approved seven-file source manifest is incomplete.'
}
foreach ($entry in $approved) {
  $source = Join-Path $repo $entry.RelativePath
  $target = Join-Path $live $entry.RelativePath
  if ((Get-FileHash $source -Algorithm SHA256).Hash -ne $entry.NewSha256) {
    throw "Source changed since verification: $($entry.RelativePath)"
  }
  if ((Get-FileHash $target -Algorithm SHA256).Hash -ne $entry.OldSha256) {
    throw "Installed file changed since verification: $($entry.RelativePath)"
  }
}
$backup = Join-Path $env:LOCALAPPDATA ('pi-antigravity-v3-1-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($entry in $approved) {
  $destination = Join-Path $backup $entry.RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
  Copy-Item (Join-Path $live $entry.RelativePath) $destination
  if ((Get-FileHash $destination -Algorithm SHA256).Hash -ne $entry.OldSha256) {
    throw "Backup verification failed: $($entry.RelativePath)"
  }
}
Write-Host "Verified rollback backup: $backup"
foreach ($entry in $approved) {
  Write-Host "Deploying $($entry.RelativePath)"
  Copy-Item (Join-Path $repo $entry.RelativePath) (Join-Path $live $entry.RelativePath)
  if ((Get-FileHash (Join-Path $live $entry.RelativePath) -Algorithm SHA256).Hash -ne $entry.NewSha256) {
    throw "Deployment verification failed: $($entry.RelativePath)"
  }
}
Write-Host "Source deployment verified. Rollback directory: $backup"
```

Before restarting OmO, verify that all seven sources were deployed and the
account and health files are byte-for-byte unchanged. Run in the same window:

```powershell
foreach ($entry in $approved) {
  if ((Get-FileHash (Join-Path $live $entry.RelativePath) -Algorithm SHA256).Hash -ne $entry.NewSha256) {
    throw "Deployed source changed: $($entry.RelativePath)"
  }
}
$accountCount = @((Get-Content -LiteralPath $accountsPath -Raw | ConvertFrom-Json).accounts.PSObject.Properties).Count
$healthRecordCount = @((Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json).records.PSObject.Properties).Count
if ($accountCount -ne $stateBaseline.AccountCount -or
    $healthRecordCount -ne $stateBaseline.HealthRecordCount -or
    (Get-FileHash -LiteralPath $accountsPath -Algorithm SHA256).Hash -ne $stateBaseline.AccountsSha256 -or
    (Get-FileHash -LiteralPath $healthPath -Algorithm SHA256).Hash -ne $stateBaseline.HealthSha256) {
  throw 'Linked accounts or persistent health state changed during source deployment.'
}
Write-Host "Verified seven sources; $accountCount accounts and $healthRecordCount health records preserved."
```

If any operation fails or controlled verification after restart fails, close
**all** OmO processes again before restoring the seven backed-up source files.
Use the exact rollback directory printed by the deployment, not the newest
directory in a glob. If a deployment copy was interrupted, note the exact
approved relative path printed before that copy. Only enter that path below
when the installed file is incomplete or missing; leave the prompt blank for
ordinary rollback. If you cannot establish which copy was interrupted, stop
and inspect instead of overriding an unexpected installed hash. Run this in
independent PowerShell after closing OmO:

```powershell
$ErrorActionPreference = 'Stop'
$live = Join-Path $env:USERPROFILE '.omo\agent\npm\node_modules\@gwylook\pi-antigravity'
$approved = @(Import-Csv (Join-Path $env:LOCALAPPDATA 'pi-antigravity-v3-1-approved.csv'))
$expected = @(
  'src\health\errors.ts',
  'src\health\private-file.ts',
  'src\health\store.ts',
  'src\runtime\account-credential-source.ts',
  'src\runtime\persistent-credential-source.ts',
  'src\stream\stream.ts',
  'src\types\types.ts'
)
$backup = Read-Host 'Enter the exact verified rollback directory'
$interruptedPath = (Read-Host 'Exact relative path of interrupted deployment copy (blank otherwise)').Trim()
if (Get-Process omo -ErrorAction SilentlyContinue) {
  throw 'All OmO processes must be closed before rollback.'
}
if ($approved.Count -ne 7 -or
    @($approved.RelativePath | Select-Object -Unique).Count -ne 7 -or
    @($approved | Where-Object { $_.RelativePath -notin $expected }).Count -ne 0) {
  throw 'The approved seven-file source manifest is incomplete.'
}
if ($interruptedPath -and $interruptedPath -cnotin $expected) {
  throw 'Interrupted copy path is outside the approved seven source files.'
}
foreach ($entry in $approved) {
  if ((Get-FileHash (Join-Path $backup $entry.RelativePath) -Algorithm SHA256).Hash -ne $entry.OldSha256) {
    throw "Backup changed: $($entry.RelativePath)"
  }
  $target = Join-Path $live $entry.RelativePath
  $current = if (Test-Path -LiteralPath $target -PathType Leaf) {
    (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  } else { $null }
  if ($current -ne $entry.OldSha256 -and
      $current -ne $entry.NewSha256 -and
      $entry.RelativePath -cne $interruptedPath) {
    throw "Installed source changed unexpectedly: $($entry.RelativePath)"
  }
}
foreach ($entry in $approved) {
  Copy-Item (Join-Path $backup $entry.RelativePath) (Join-Path $live $entry.RelativePath)
  if ((Get-FileHash (Join-Path $live $entry.RelativePath) -Algorithm SHA256).Hash -ne $entry.OldSha256) {
    throw "Rollback verification failed: $($entry.RelativePath)"
  }
}
```

Never restore, delete, or rewrite `antigravity-account-health.json`, linked
accounts, or credential files as part of this source rollback.

After a successful restart, use the existing diagnostic command and one
controlled request with a simulated/offline account where possible. Only a
minimal live request is warranted for end-to-end confirmation; do not probe all
linked accounts. Verify that ordinary concurrent sessions do not require
Continue for transient health locking and that account and health records
remain present. Do not open a follow-up upstream PR until that live check and
the Windows multi-process stress results are both satisfactory.

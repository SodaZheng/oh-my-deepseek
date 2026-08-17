export function renderWslWindowsLauncher() {
  return `$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content -LiteralPath (Join-Path $Root 'wsl-launch.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$WslPath = (Get-Command wsl.exe -ErrorAction Stop).Source
$Arguments = @('--distribution', [string]$Config.distro)
if ($Config.user) {
  $Arguments += @('--user', [string]$Config.user)
}
$Arguments += @('--exec', [string]$Config.nodePath, [string]$Config.supervisorPath)
& $WslPath @Arguments
exit $LASTEXITCODE
`;
}

export function renderWindowsHostBrowser() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [ValidateSet('Run', 'Activate', 'Stop')][string]$Mode = 'Run'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$DevToolsPortFile = Join-Path $Config.chromeProfilePath 'DevToolsActivePort'

function Get-DevToolsPort {
  try {
    $FirstLine = (Get-Content -LiteralPath $DevToolsPortFile -TotalCount 1 -ErrorAction Stop).Trim()
    $Port = 0
    if ([int]::TryParse($FirstLine, [ref]$Port) -and $Port -gt 0) { return $Port }
  } catch {}
  return $null
}

function Invoke-DevTools([string]$Path) {
  $Port = Get-DevToolsPort
  if (-not $Port) { return $null }
  try {
    return Invoke-RestMethod -Uri ("http://127.0.0.1:{0}{1}" -f $Port, $Path) -TimeoutSec 2
  } catch {
    return $null
  }
}

function Get-TargetSnapshot {
  $Port = Get-DevToolsPort
  if (-not $Port) { return [pscustomobject]@{ ok = $false; items = @() } }
  try {
    $Response = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/json/list" -f $Port) -TimeoutSec 2
    return [pscustomobject]@{ ok = $true; items = @($Response) }
  } catch {
    return [pscustomobject]@{ ok = $false; items = @() }
  }
}

function Get-Origin([string]$Value) {
  try {
    $Uri = [Uri]$Value
    $PortPart = if ($Uri.IsDefaultPort) { '' } else { ':' + $Uri.Port }
    return $Uri.Scheme + '://' + $Uri.Host + $PortPart
  } catch {
    return $null
  }
}

function Get-AppTarget {
  $ExpectedOrigin = Get-Origin ([string]$Config.url)
  $Snapshot = Get-TargetSnapshot
  if (-not $Snapshot.ok) { return $null }
  return @($Snapshot.items) | Where-Object {
    $_.type -eq 'page' -and (Get-Origin ([string]$_.url)) -eq $ExpectedOrigin
  } | Select-Object -First 1
}

function Test-TcpPort {
  $Client = [System.Net.Sockets.TcpClient]::new()
  try {
    $Connect = $Client.BeginConnect([string]$Config.readyHost, [int]$Config.readyPort, $null, $null)
    if (-not $Connect.AsyncWaitHandle.WaitOne(300)) { return $false }
    $Client.EndConnect($Connect)
    return $true
  } catch {
    return $false
  } finally {
    $Client.Dispose()
  }
}

function Stop-ManagedChrome {
  if (-not (Test-Path -LiteralPath $Config.browserPidPath -PathType Leaf)) { return }
  try {
    $BrowserPid = [int](Get-Content -LiteralPath $Config.browserPidPath -Raw -ErrorAction Stop).Trim()
    & taskkill.exe /PID $BrowserPid /T 2>$null | Out-Null
    Start-Sleep -Milliseconds 750
    if (Get-Process -Id $BrowserPid -ErrorAction SilentlyContinue) {
      & taskkill.exe /PID $BrowserPid /T /F 2>$null | Out-Null
    }
  } catch {}
  Remove-Item -LiteralPath $Config.browserPidPath -Force -ErrorAction SilentlyContinue
}

function Test-ManagedChrome {
  if (-not (Test-Path -LiteralPath $Config.browserPidPath -PathType Leaf)) { return $false }
  try {
    $BrowserPid = [int](Get-Content -LiteralPath $Config.browserPidPath -Raw -ErrorAction Stop).Trim()
    return $null -ne (Get-Process -Id $BrowserPid -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Start-HostChrome {
  Stop-ManagedChrome
  New-Item -ItemType Directory -Path $Config.chromeProfilePath -Force | Out-Null
  Remove-Item -LiteralPath $DevToolsPortFile -Force -ErrorAction SilentlyContinue
  $Arguments = @(
    '--app=data:text/html,Preparing%20Chrome%20Runtime',
    '--window-position=-10000,-10000',
    '--window-size=1,1',
    ('--user-data-dir="' + [string]$Config.chromeProfilePath + '"'),
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble'
  )
  $Browser = Start-Process -FilePath $Config.chromePath -ArgumentList $Arguments -PassThru
  [System.IO.File]::WriteAllText([string]$Config.browserPidPath, [string]$Browser.Id, [System.Text.Encoding]::ASCII)
}

function Wait-ForDevTools([datetime]$Deadline) {
  while ([datetime]::UtcNow -lt $Deadline) {
    if (Invoke-DevTools '/json/version') { return }
    if (-not (Test-ManagedChrome)) { throw 'Windows Chrome 在初始化期间退出' }
    Start-Sleep -Milliseconds 200
  }
  throw 'Windows Chrome 初始化超时'
}

function Wait-ForHostService([datetime]$Deadline) {
  while ([datetime]::UtcNow -lt $Deadline) {
    if (Test-TcpPort) { return }
    Start-Sleep -Milliseconds 250
  }
  throw ("Windows 宿主机无法连接 WSL 服务 {0}:{1}。请检查 DSH 监听地址及 WSL localhost 转发设置" -f $Config.readyHost, $Config.readyPort)
}

function Open-AppWindow {
  $Arguments = @(
    ('--app=' + [string]$Config.url),
    ('--user-data-dir="' + [string]$Config.chromeProfilePath + '"'),
    '--no-first-run',
    '--no-default-browser-check'
  )
  Start-Process -FilePath $Config.chromePath -ArgumentList $Arguments | Out-Null
}

function Wait-ForAppTarget([datetime]$Deadline) {
  while ([datetime]::UtcNow -lt $Deadline) {
    $Target = Get-AppTarget
    if ($Target) { return $Target }
    if (-not (Test-ManagedChrome)) { throw 'Windows Chrome 在 App 窗口打开前退出' }
    Start-Sleep -Milliseconds 250
  }
  throw '无法确认 Windows Chrome App 窗口已打开'
}

function Close-PrewarmTargets([string]$AppTargetId) {
  $Snapshot = Get-TargetSnapshot
  if (-not $Snapshot.ok) { return }
  foreach ($Target in @($Snapshot.items)) {
    if ($Target.id -eq $AppTargetId -or $Target.type -ne 'page' -or -not ([string]$Target.url).StartsWith('data:text/html,Preparing')) { continue }
    Invoke-DevTools ('/json/close/' + [string]$Target.id) | Out-Null
  }
}

function Run-BrowserLifecycle {
  $Deadline = [datetime]::UtcNow.AddSeconds([int]$Config.timeoutSeconds)
  Start-HostChrome
  Wait-ForDevTools $Deadline
  Wait-ForHostService $Deadline
  Open-AppWindow
  $Target = Wait-ForAppTarget ([datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30)))
  Close-PrewarmTargets ([string]$Target.id)
  while ($true) {
    $Snapshot = Get-TargetSnapshot
    if ($Snapshot.ok -and -not (@($Snapshot.items) | Where-Object { $_.id -eq $Target.id })) { return }
    if (-not (Test-ManagedChrome)) { return }
    Start-Sleep -Milliseconds 500
  }
}

if ($Mode -eq 'Activate') {
  $Target = Get-AppTarget
  if (-not $Target) { exit 1 }
  Invoke-DevTools ('/json/activate/' + [string]$Target.id) | Out-Null
  exit 0
}

if ($Mode -eq 'Stop') {
  Stop-ManagedChrome
  exit 0
}

$ExitCode = 0
try {
  Remove-Item -LiteralPath $Config.lastErrorPath -Force -ErrorAction SilentlyContinue
  Run-BrowserLifecycle
} catch {
  $Message = $_.Exception.Message
  [System.IO.File]::WriteAllText([string]$Config.lastErrorPath, $Message, [System.Text.UTF8Encoding]::new($false))
  Write-Error $Message
  $ExitCode = 1
} finally {
  Stop-ManagedChrome
}
exit $ExitCode
`;
}

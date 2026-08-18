export function renderWindowsHostBrowser() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [ValidateSet('Run', 'Activate', 'Stop')][string]$Mode = 'Run'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$DevToolsPortFile = Join-Path $Config.chromeProfilePath 'DevToolsActivePort'
Add-Type -AssemblyName System.Net.Http
$HttpClient = [System.Net.Http.HttpClient]::new()
$HttpClient.Timeout = [TimeSpan]::FromSeconds(2)
$HttpClient.DefaultRequestHeaders.CacheControl = [System.Net.Http.Headers.CacheControlHeaderValue]::new()
$HttpClient.DefaultRequestHeaders.CacheControl.NoCache = $true
$script:BrowserProcess = $null

if ($Config.launchMode -eq 'installed-pwa') {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OmdChromeWindow {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

  public static long[] GetWindows(string executablePath) {
    var handles = new List<long>();
    EnumWindows((hwnd, lParam) => {
      if (!IsWindowVisible(hwnd)) return true;
      var className = new StringBuilder(256);
      GetClassName(hwnd, className, className.Capacity);
      if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      var process = OpenProcess(0x1000, false, processId);
      if (process == IntPtr.Zero) return true;
      try {
        var path = new StringBuilder(32768);
        var size = path.Capacity;
        if (QueryFullProcessImageName(process, 0, path, ref size)
            && string.Equals(path.ToString(), executablePath, StringComparison.OrdinalIgnoreCase)) {
          handles.Add(hwnd.ToInt64());
        }
      } finally {
        CloseHandle(process);
      }
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static bool IsAlive(long handle) { return IsWindow(new IntPtr(handle)); }
  public static bool Activate(long handle) {
    var hwnd = new IntPtr(handle);
    if (!IsWindow(hwnd)) return false;
    ShowWindow(hwnd, 9);
    return SetForegroundWindow(hwnd);
  }
  public static bool Close(long handle) {
    var hwnd = new IntPtr(handle);
    return IsWindow(hwnd) && PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
}

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
  if (-not $Port) { return [pscustomobject]@{ ok = $false; value = $null } }
  try {
    $Content = $HttpClient.GetStringAsync(("http://127.0.0.1:{0}{1}" -f $Port, $Path)).GetAwaiter().GetResult()
    $Value = if ([string]::IsNullOrWhiteSpace($Content)) { $null } else { $Content | ConvertFrom-Json }
    return [pscustomobject]@{ ok = $true; value = $Value }
  } catch {
    return [pscustomobject]@{ ok = $false; value = $null }
  }
}

function Get-TargetSnapshot {
  $Request = Invoke-DevTools '/json/list'
  if (-not $Request.ok) { return [pscustomobject]@{ ok = $false; items = @() } }
  return [pscustomobject]@{ ok = $true; items = @($Request.value) }
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

function Get-PwaWindows {
  return @([OmdChromeWindow]::GetWindows([string]$Config.chromePath))
}

function Read-PwaWindowHandle {
  if (-not (Test-Path -LiteralPath $Config.windowHandlePath -PathType Leaf)) { return $null }
  try {
    $Handle = [long](Get-Content -LiteralPath $Config.windowHandlePath -Raw -ErrorAction Stop).Trim()
    if ([OmdChromeWindow]::IsAlive($Handle)) { return $Handle }
  } catch {}
  return $null
}

function Stop-PwaWindow {
  $Handle = Read-PwaWindowHandle
  if ($Handle) { [OmdChromeWindow]::Close($Handle) | Out-Null }
  Remove-Item -LiteralPath $Config.windowHandlePath -Force -ErrorAction SilentlyContinue
}

function Start-PwaWindow([datetime]$Deadline) {
  $Baseline = @{}
  foreach ($Handle in Get-PwaWindows) { $Baseline[[string]$Handle] = $true }
  $QuotedArguments = @($Config.pwaArguments | ForEach-Object {
    $Value = [string]$_
    if ($Value -match '[\s"]') { '"' + $Value.Replace('"', '\"') + '"' } else { $Value }
  })
  Start-Process -FilePath $Config.pwaLauncherPath -ArgumentList ($QuotedArguments -join ' ') | Out-Null
  while ([datetime]::UtcNow -lt $Deadline) {
    foreach ($Handle in Get-PwaWindows) {
      if (-not $Baseline.ContainsKey([string]$Handle)) {
        [System.IO.File]::WriteAllText([string]$Config.windowHandlePath, [string]$Handle, [System.Text.Encoding]::ASCII)
        return $Handle
      }
    }
    Start-Sleep -Milliseconds 100
  }
  throw '无法确认已安装的 Windows Chrome App 窗口已打开'
}

function Test-HttpService {
  $Response = $null
  try {
    $Response = $HttpClient.GetAsync([string]$Config.url).GetAwaiter().GetResult()
    if (-not $Response.IsSuccessStatusCode) { return $false }
    $ContentType = [string]$Response.Content.Headers.ContentType
    if (-not $ContentType.Contains('text/html')) { return $true }
    $Content = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $Content.Contains('<title>DeepSeek Harness</title>')) { return $true }
    return $Content.Contains('window.__DSH_BOOT__') -and $Content.Contains('"url":"/plugins/')
  } catch {
    return $false
  } finally {
    if ($Response) { $Response.Dispose() }
  }
}

function Wait-ForHostService([datetime]$Deadline) {
  $ConsecutiveSuccesses = 0
  while ([datetime]::UtcNow -lt $Deadline) {
    if (Test-HttpService) {
      $ConsecutiveSuccesses += 1
      if ($ConsecutiveSuccesses -ge 2) { return }
    } else {
      $ConsecutiveSuccesses = 0
    }
    Start-Sleep -Milliseconds 250
  }
  throw ("Windows 宿主机无法读取 WSL 服务 {0}。请检查 DSH 是否完成启动及 WSL localhost 转发设置" -f $Config.url)
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
  $script:BrowserProcess = $null
}

function Test-ManagedChrome {
  if ($script:BrowserProcess) {
    try {
      $script:BrowserProcess.Refresh()
      return -not $script:BrowserProcess.HasExited
    } catch {
      return $false
    }
  }
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
    ('--app=' + [string]$Config.url),
    '--window-position=100,100',
    '--window-size=1280,800',
    ('--user-data-dir="' + [string]$Config.chromeProfilePath + '"'),
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble'
  )
  $script:BrowserProcess = Start-Process -FilePath $Config.chromePath -ArgumentList $Arguments -PassThru
  [System.IO.File]::WriteAllText([string]$Config.browserPidPath, [string]$script:BrowserProcess.Id, [System.Text.Encoding]::ASCII)
}

function Wait-ForDevTools([datetime]$Deadline) {
  while ([datetime]::UtcNow -lt $Deadline) {
    if ((Invoke-DevTools '/json/version').ok) { return }
    if (-not (Test-ManagedChrome)) { throw 'Windows Chrome 在初始化期间退出' }
    Start-Sleep -Milliseconds 200
  }
  throw 'Windows Chrome 初始化超时'
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

function Run-BrowserLifecycle {
  $ServiceDeadline = [datetime]::UtcNow.AddSeconds([int]$Config.timeoutSeconds)
  Wait-ForHostService $ServiceDeadline
  if ($Config.launchMode -eq 'installed-pwa') {
    $Handle = Start-PwaWindow ([datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30)))
    [OmdChromeWindow]::Activate($Handle) | Out-Null
    while ([OmdChromeWindow]::IsAlive($Handle)) { Start-Sleep -Milliseconds 500 }
    Remove-Item -LiteralPath $Config.windowHandlePath -Force -ErrorAction SilentlyContinue
    return
  }
  Start-HostChrome
  $BrowserDeadline = [datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30))
  Wait-ForDevTools $BrowserDeadline
  $Target = Wait-ForAppTarget ([datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30)))
  Invoke-DevTools ('/json/activate/' + [string]$Target.id) | Out-Null
  while ($true) {
    $Snapshot = Get-TargetSnapshot
    if ($Snapshot.ok -and -not (@($Snapshot.items) | Where-Object { $_.id -eq $Target.id })) { return }
    if (-not (Test-ManagedChrome)) { return }
    Start-Sleep -Milliseconds 750
  }
}

if ($Mode -eq 'Activate') {
  if ($Config.launchMode -eq 'installed-pwa') {
    $Handle = Read-PwaWindowHandle
    if (-not $Handle) { exit 1 }
    if ([OmdChromeWindow]::Activate($Handle)) { exit 0 }
    exit 1
  }
  $Target = Get-AppTarget
  if (-not $Target) { exit 1 }
  Invoke-DevTools ('/json/activate/' + [string]$Target.id) | Out-Null
  exit 0
}

if ($Mode -eq 'Stop') {
  if ($Config.launchMode -eq 'installed-pwa') { Stop-PwaWindow } else { Stop-ManagedChrome }
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
  if ($Config.launchMode -eq 'installed-pwa') { Stop-PwaWindow } else { Stop-ManagedChrome }
  $HttpClient.Dispose()
}
exit $ExitCode
`;
}

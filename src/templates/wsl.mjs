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

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class OmdChromeWindow {
  private const uint EventObjectCreate = 0x8000;
  private const uint EventObjectShow = 0x8002;
  private const uint WineventOutOfContext = 0;
  private const uint WineventSkipOwnProcess = 2;
  private const uint WmQuit = 0x0012;
  private const uint WmNull = 0x0000;
  private const uint SmtoAbortIfHung = 0x0002;
  private const uint RdwFirstPaint = 0x0001 | 0x0080 | 0x0100;
  private const int DwmwaCloak = 13;
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint threadId, uint eventTime);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] private static extern bool RedrawWindow(IntPtr hwnd, IntPtr updateRect, IntPtr updateRegion, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hwnd, ref WindowPlacement placement);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
  [DllImport("dwmapi.dll")] private static extern int DwmFlush();
  [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);
  [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);

  [StructLayout(LayoutKind.Sequential)]
  private struct Message {
    internal IntPtr window;
    internal uint message;
    internal UIntPtr wParam;
    internal IntPtr lParam;
    internal uint time;
    internal int x;
    internal int y;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct Point {
    internal int x;
    internal int y;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct Rect {
    internal int left;
    internal int top;
    internal int right;
    internal int bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct WindowPlacement {
    internal int length;
    internal int flags;
    internal int showCommand;
    internal Point minimumPosition;
    internal Point maximumPosition;
    internal Rect normalPosition;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct MonitorInfo {
    internal int size;
    internal Rect monitor;
    internal Rect work;
    internal uint flags;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PropertyKey {
    internal Guid formatId;
    internal uint propertyId;
    internal PropertyKey(Guid formatId, uint propertyId) {
      this.formatId = formatId;
      this.propertyId = propertyId;
    }
  }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  private struct PropVariant {
    [FieldOffset(0)] internal ushort valueType;
    [FieldOffset(8)] internal IntPtr pointerValue;
    internal static PropVariant FromString(string value) {
      return new PropVariant {
        valueType = 31,
        pointerValue = Marshal.StringToCoTaskMemUni(value)
      };
    }
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  private interface IPropertyStore {
    [PreserveSig] int GetCount(out uint propertyCount);
    [PreserveSig] int GetAt(uint propertyIndex, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  private static readonly object GateSync = new object();
  private static HashSet<long> gateBaseline = new HashSet<long>();
  private static HashSet<long> gateCandidates = new HashSet<long>();
  private static HashSet<long> gateShownCandidates = new HashSet<long>();
  private static string gateExecutablePath = "";
  private static string gateExpectedAppId = "";
  private static ManualResetEventSlim gateReady = new ManualResetEventSlim(false);
  private static ManualResetEventSlim gateCaptured = new ManualResetEventSlim(false);
  private static WinEventDelegate gateCallback;
  private static Thread gateThread;
  private static IntPtr gateHook = IntPtr.Zero;
  private static uint gateThreadId;
  private static long gateHandle;
  private static int gateActive;

  public static bool BeginWindowGate(string executablePath, string expectedAppId, long[] baselineHandles) {
    CancelWindowGate();
    gateExecutablePath = executablePath ?? "";
    gateExpectedAppId = expectedAppId ?? "";
    gateBaseline = new HashSet<long>(baselineHandles ?? new long[0]);
    gateCandidates = new HashSet<long>();
    gateShownCandidates = new HashSet<long>();
    gateReady = new ManualResetEventSlim(false);
    gateCaptured = new ManualResetEventSlim(false);
    gateHandle = 0;
    Interlocked.Exchange(ref gateActive, 1);
    gateThread = new Thread(RunWindowGate) { IsBackground = true };
    gateThread.SetApartmentState(ApartmentState.STA);
    gateThread.Start();
    return gateReady.Wait(2000) && gateHook != IntPtr.Zero;
  }

  public static long WaitForGatedWindow(int timeoutMilliseconds) {
    if (timeoutMilliseconds < 1 || !gateCaptured.Wait(timeoutMilliseconds)) return 0;
    return Interlocked.Read(ref gateHandle);
  }

  public static bool ReleaseWindowGate(long handle) {
    var hwnd = new IntPtr(handle);
    lock (GateSync) {
      Interlocked.Exchange(ref gateActive, 0);
      StopWindowGate();
      if (!IsWindow(hwnd)) return false;
      SetWindowCloaked(hwnd, false);
      ShowWindow(hwnd, 9);
      SetForegroundWindow(hwnd);
      return IsWindowVisible(hwnd);
    }
  }

  public static bool WaitForWindowReadyToReveal(long handle, int timeoutMilliseconds) {
    var hwnd = new IntPtr(handle);
    var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(100, timeoutMilliseconds));
    string lastTitle = null;
    var stableReadings = 0;
    while (IsWindow(hwnd) && DateTime.UtcNow < deadline) {
      Rect client;
      var titleBuffer = new StringBuilder(512);
      GetWindowText(hwnd, titleBuffer, titleBuffer.Capacity);
      var title = titleBuffer.ToString().Trim();
      var hasClientArea = GetClientRect(hwnd, out client)
        && client.right - client.left >= 320
        && client.bottom - client.top >= 240;
      if (hasClientArea && !string.IsNullOrWhiteSpace(title)) {
        stableReadings = string.Equals(lastTitle, title, StringComparison.Ordinal) ? stableReadings + 1 : 1;
        lastTitle = title;
        if (stableReadings >= 6) {
          UIntPtr messageResult;
          RedrawWindow(hwnd, IntPtr.Zero, IntPtr.Zero, RdwFirstPaint);
          SendMessageTimeout(hwnd, WmNull, UIntPtr.Zero, IntPtr.Zero, SmtoAbortIfHung, 500, out messageResult);
          DwmFlush();
          Thread.Sleep(16);
          DwmFlush();
          return true;
        }
      } else {
        stableReadings = 0;
        lastTitle = null;
      }
      Thread.Sleep(50);
    }
    return false;
  }

  public static void CancelWindowGate() {
    Interlocked.Exchange(ref gateActive, 0);
    StopWindowGate();
  }

  private static void RunWindowGate() {
    gateThreadId = GetCurrentThreadId();
    gateCallback = OnGateWindowEvent;
    gateHook = SetWinEventHook(
      EventObjectCreate,
      EventObjectShow,
      IntPtr.Zero,
      gateCallback,
      0,
      0,
      WineventOutOfContext | WineventSkipOwnProcess
    );
    gateReady.Set();
    if (gateHook == IntPtr.Zero) return;
    try {
      Message message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {}
    } finally {
      UnhookWinEvent(gateHook);
      gateHook = IntPtr.Zero;
      gateThreadId = 0;
    }
  }

  private static void StopWindowGate() {
    var threadId = gateThreadId;
    if (threadId != 0) {
      gateThreadId = 0;
      PostThreadMessage(threadId, WmQuit, UIntPtr.Zero, IntPtr.Zero);
    }
  }

  private static void OnGateWindowEvent(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint threadId, uint eventTime) {
    if (Interlocked.CompareExchange(ref gateActive, 0, 0) == 0 || objectId != 0 || childId != 0 || window == IntPtr.Zero) return;
    if (eventType != EventObjectCreate && eventType != EventObjectShow) return;
    var handle = window.ToInt64();
    if (handle == Interlocked.Read(ref gateHandle)) {
      lock (GateSync) {
        if (Interlocked.CompareExchange(ref gateActive, 0, 0) != 0) {
          SetWindowCloaked(window, true);
          ShowWindow(window, 0);
        }
      }
      return;
    }
    if (gateBaseline.Contains(handle)) return;
    var className = new StringBuilder(256);
    GetClassName(window, className, className.Capacity);
    if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return;
    if (WindowMatchesExecutable(window, gateExecutablePath)) {
      lock (GateSync) {
        if (eventType == EventObjectShow) gateShownCandidates.Add(handle);
      }
      SetWindowCloaked(window, true);
      ShowWindow(window, 0);
    }
    lock (GateSync) {
      if (!gateCandidates.Add(handle)) return;
    }
    Task.Run(() => InspectGateCandidate(window));
  }

  private static void InspectGateCandidate(IntPtr window) {
    string lastMismatchedAppId = null;
    var mismatchedReadings = 0;
    for (var attempt = 0; attempt < 200 && IsWindow(window); attempt += 1) {
      if (Interlocked.CompareExchange(ref gateActive, 0, 0) == 0) return;
      if (WindowMatchesExecutable(window, gateExecutablePath)) {
        SetWindowCloaked(window, true);
        ShowWindow(window, 0);
        var appId = GetStringProperty(window.ToInt64(), 5);
        var matchesExpectedApp = string.IsNullOrWhiteSpace(gateExpectedAppId)
          ? GateCandidateWasShown(window.ToInt64())
          : string.Equals(appId, gateExpectedAppId, StringComparison.OrdinalIgnoreCase);
        if (matchesExpectedApp) {
          if (Interlocked.CompareExchange(ref gateHandle, window.ToInt64(), 0) == 0) {
            SetWindowCloaked(window, true);
            ShowWindow(window, 0);
            gateCaptured.Set();
          }
          return;
        }
        if (!string.IsNullOrWhiteSpace(appId)) {
          mismatchedReadings = string.Equals(lastMismatchedAppId, appId, StringComparison.OrdinalIgnoreCase)
            ? mismatchedReadings + 1
            : 1;
          lastMismatchedAppId = appId;
          if (mismatchedReadings >= 20) {
            RestoreRejectedGateCandidate(window);
            return;
          }
        } else {
          mismatchedReadings = 0;
          lastMismatchedAppId = null;
        }
      }
      Thread.Sleep(10);
    }
    RestoreRejectedGateCandidate(window);
  }

  private static bool WindowMatchesExecutable(IntPtr hwnd, string executablePath) {
    uint processId;
    GetWindowThreadProcessId(hwnd, out processId);
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return false;
    try {
      var processPath = new StringBuilder(32768);
      var size = processPath.Capacity;
      return QueryFullProcessImageName(process, 0, processPath, ref size)
        && string.Equals(processPath.ToString(), executablePath, StringComparison.OrdinalIgnoreCase);
    } finally {
      CloseHandle(process);
    }
  }

  private static bool SetWindowCloaked(IntPtr hwnd, bool cloaked) {
    var value = cloaked ? 1 : 0;
    return DwmSetWindowAttribute(hwnd, DwmwaCloak, ref value, sizeof(int)) >= 0;
  }

  private static bool GateCandidateWasShown(long handle) {
    lock (GateSync) {
      return gateShownCandidates.Contains(handle);
    }
  }

  private static void RestoreRejectedGateCandidate(IntPtr window) {
    if (!IsWindow(window)) return;
    var wasShown = GateCandidateWasShown(window.ToInt64());
    SetWindowCloaked(window, false);
    if (wasShown) ShowWindow(window, 9);
  }

  private static long[] CollectWindows(string executablePath, bool visibleOnly) {
    var handles = new List<long>();
    EnumWindows((hwnd, lParam) => {
      if (visibleOnly && !IsWindowVisible(hwnd)) return true;
      var className = new StringBuilder(256);
      GetClassName(hwnd, className, className.Capacity);
      if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;
      if (WindowMatchesExecutable(hwnd, executablePath)) handles.Add(hwnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static long[] GetWindows(string executablePath) {
    return CollectWindows(executablePath, true);
  }

  public static long[] GetAllWindows(string executablePath) {
    return CollectWindows(executablePath, false);
  }

  public static bool IsAlive(long handle) { return IsWindow(new IntPtr(handle)); }
  public static bool Activate(long handle) {
    var hwnd = new IntPtr(handle);
    if (!IsWindow(hwnd)) return false;
    ShowWindow(hwnd, 9);
    return SetForegroundWindow(hwnd);
  }
  public static int[] GetNormalSize(long handle) {
    var hwnd = new IntPtr(handle);
    if (!IsWindow(hwnd)) return null;
    var placement = new WindowPlacement { length = Marshal.SizeOf(typeof(WindowPlacement)) };
    if (!GetWindowPlacement(hwnd, ref placement)) return null;
    var width = placement.normalPosition.right - placement.normalPosition.left;
    var height = placement.normalPosition.bottom - placement.normalPosition.top;
    if (width <= 0 || height <= 0) return null;
    return new[] { width, height };
  }
  public static bool CenterWithSize(long handle, int requestedWidth, int requestedHeight) {
    var hwnd = new IntPtr(handle);
    if (!IsWindow(hwnd) || requestedWidth <= 0 || requestedHeight <= 0) return false;
    var monitor = MonitorFromWindow(hwnd, 2);
    if (monitor == IntPtr.Zero) return false;
    var info = new MonitorInfo { size = Marshal.SizeOf(typeof(MonitorInfo)) };
    if (!GetMonitorInfo(monitor, ref info)) return false;
    var workWidth = info.work.right - info.work.left;
    var workHeight = info.work.bottom - info.work.top;
    var width = Math.Max(320, Math.Min(requestedWidth, workWidth));
    var height = Math.Max(240, Math.Min(requestedHeight, workHeight));
    var x = info.work.left + (workWidth - width) / 2;
    var y = info.work.top + (workHeight - height) / 2;
    return SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0010);
  }
  public static bool Close(long handle) {
    var hwnd = new IntPtr(handle);
    return IsWindow(hwnd) && PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
  public static bool SetTaskbarProperties(long handle, string appUserModelId, string iconResource) {
    var hwnd = new IntPtr(handle);
    if (!IsWindow(hwnd) || string.IsNullOrWhiteSpace(appUserModelId) || string.IsNullOrWhiteSpace(iconResource)) return false;
    var interfaceId = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(hwnd, ref interfaceId, out store) < 0 || store == null) return false;
    var formatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    var iconKey = new PropertyKey(formatId, 3);
    var appIdKey = new PropertyKey(formatId, 5);
    var iconValue = PropVariant.FromString(iconResource);
    var appIdValue = PropVariant.FromString(appUserModelId);
    try {
      // RelaunchIconResource must be applied before AppUserModelID so the
      // taskbar refresh triggered by the identity observes the custom icon.
      if (store.SetValue(ref iconKey, ref iconValue) < 0) return false;
      if (store.SetValue(ref appIdKey, ref appIdValue) < 0) return false;
      return store.Commit() >= 0;
    } finally {
      PropVariantClear(ref appIdValue);
      PropVariantClear(ref iconValue);
      Marshal.FinalReleaseComObject(store);
    }
  }

  private static string GetStringProperty(long handle, uint propertyId) {
    var hwnd = new IntPtr(handle);
    if (!IsWindow(hwnd)) return null;
    var interfaceId = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(hwnd, ref interfaceId, out store) < 0 || store == null) return null;
    var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), propertyId);
    var value = new PropVariant();
    try {
      if (store.GetValue(ref key, out value) < 0 || value.pointerValue == IntPtr.Zero) return null;
      if (value.valueType == 31) return Marshal.PtrToStringUni(value.pointerValue);
      if (value.valueType == 8) return Marshal.PtrToStringBSTR(value.pointerValue);
      return null;
    } finally {
      PropVariantClear(ref value);
      Marshal.FinalReleaseComObject(store);
    }
  }

  public static string GetAppUserModelId(long handle) { return GetStringProperty(handle, 5); }
  public static string GetTaskbarIconResource(long handle) { return GetStringProperty(handle, 3); }
}
'@

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

function Get-ChromeWindowBaseline {
  $Baseline = @{}
  foreach ($Handle in [OmdChromeWindow]::GetAllWindows([string]$Config.chromePath)) {
    $Baseline[[string]$Handle] = $true
  }
  return $Baseline
}

function Start-WindowGate([hashtable]$Baseline, [string]$ExpectedAppUserModelId) {
  [long[]]$BaselineHandles = @($Baseline.Keys | ForEach-Object { [long]$_ })
  return [OmdChromeWindow]::BeginWindowGate(
    [string]$Config.chromePath,
    $ExpectedAppUserModelId,
    $BaselineHandles
  )
}

function Wait-ForGatedWindow([datetime]$Deadline) {
  $RemainingMilliseconds = [Math]::Max(1, [int]($Deadline - [datetime]::UtcNow).TotalMilliseconds)
  return [OmdChromeWindow]::WaitForGatedWindow($RemainingMilliseconds)
}

function Wait-ForNewChromeWindow([hashtable]$Baseline, [datetime]$Deadline, [string]$ErrorMessage) {
  while ([datetime]::UtcNow -lt $Deadline) {
    foreach ($Handle in Get-PwaWindows) {
      if (-not $Baseline.ContainsKey([string]$Handle)) { return $Handle }
    }
    Start-Sleep -Milliseconds 100
  }
  throw $ErrorMessage
}

function Read-SavedWindowSize {
  if (-not (Test-Path -LiteralPath $Config.windowBoundsPath -PathType Leaf)) { return $null }
  try {
    $Saved = Get-Content -LiteralPath $Config.windowBoundsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Width = [int]$Saved.width
    $Height = [int]$Saved.height
    if ($Width -lt 320 -or $Height -lt 240 -or $Width -gt 32768 -or $Height -gt 32768) { return $null }
    return [pscustomobject]@{ width = $Width; height = $Height }
  } catch {
    return $null
  }
}

function Save-WindowSize([long]$Handle) {
  $Size = [OmdChromeWindow]::GetNormalSize($Handle)
  if (-not $Size -or $Size.Count -lt 2) { return }
  $Width = [int]$Size[0]
  $Height = [int]$Size[1]
  if ($Width -lt 320 -or $Height -lt 240) { return }
  $Key = ('{0}x{1}' -f $Width, $Height)
  if ($script:LastSavedWindowSize -eq $Key) { return }
  $Directory = [System.IO.Path]::GetDirectoryName([string]$Config.windowBoundsPath)
  [System.IO.Directory]::CreateDirectory($Directory) | Out-Null
  $Json = @{ width = $Width; height = $Height } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText([string]$Config.windowBoundsPath, $Json, [System.Text.UTF8Encoding]::new($false))
  $script:LastSavedWindowSize = $Key
}

function Restore-WindowSizeAndCenter([long]$Handle) {
  $Saved = Read-SavedWindowSize
  if ($Saved) {
    $Width = [int]$Saved.width
    $Height = [int]$Saved.height
  } else {
    $Current = [OmdChromeWindow]::GetNormalSize($Handle)
    if (-not $Current -or $Current.Count -lt 2) { return }
    $Width = [int]$Current[0]
    $Height = [int]$Current[1]
  }
  [OmdChromeWindow]::CenterWithSize($Handle, $Width, $Height) | Out-Null
  Start-Sleep -Milliseconds 100
  [OmdChromeWindow]::CenterWithSize($Handle, $Width, $Height) | Out-Null
}

function Wait-ForWindowToClose([long]$Handle) {
  while ([OmdChromeWindow]::IsAlive($Handle)) {
    Save-WindowSize $Handle
    Start-Sleep -Milliseconds 100
  }
}

function Set-TaskbarIdentity([long]$Handle) {
  $ExpectedAppUserModelId = [string]$Config.appUserModelId
  $ExpectedIconResource = [string]$Config.taskbarIconResource
  $ExistingAppUserModelId = [OmdChromeWindow]::GetAppUserModelId($Handle)
  $SourceAppUserModelId = [string]$Config.sourceAppUserModelId
  if (-not [string]::IsNullOrWhiteSpace($SourceAppUserModelId) -and
      -not [string]::Equals($ExistingAppUserModelId, $SourceAppUserModelId, [StringComparison]::OrdinalIgnoreCase) -and
      -not [string]::Equals($ExistingAppUserModelId, $ExpectedAppUserModelId, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Windows Chrome PWA 窗口的 AppUserModelID 与检测到的官方快捷方式不一致'
  }

  for ($Attempt = 0; $Attempt -lt 5; $Attempt += 1) {
    $PropertiesWereSet = [OmdChromeWindow]::SetTaskbarProperties(
      $Handle,
      $ExpectedAppUserModelId,
      $ExpectedIconResource
    )
    Start-Sleep -Milliseconds 100
    $ActualAppUserModelId = [OmdChromeWindow]::GetAppUserModelId($Handle)
    $ActualTaskbarIconResource = [OmdChromeWindow]::GetTaskbarIconResource($Handle)
    if ($PropertiesWereSet -and
        [string]::Equals($ActualAppUserModelId, $ExpectedAppUserModelId, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($ActualTaskbarIconResource, $ExpectedIconResource, [StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }
  throw '无法把 Windows Chrome App 窗口关联到自有任务栏身份和图标'
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
  $Baseline = Get-ChromeWindowBaseline
  $GateStarted = Start-WindowGate $Baseline ([string]$Config.sourceAppUserModelId)
  $WindowWasGated = $false
  $Handle = 0
  $QuotedArguments = @($Config.pwaArguments | ForEach-Object {
    $Value = [string]$_
    if ($Value -match '[\s"]') { '"' + $Value.Replace('"', '\"') + '"' } else { $Value }
  })
  $HandleDirectory = [System.IO.Path]::GetDirectoryName([string]$Config.windowHandlePath)
  [System.IO.Directory]::CreateDirectory($HandleDirectory) | Out-Null
  [System.IO.File]::WriteAllText([string]$Config.windowHandlePath, 'managed-launch', [System.Text.Encoding]::ASCII)
  try {
    Start-Process -FilePath $Config.pwaLauncherPath -ArgumentList ($QuotedArguments -join ' ') | Out-Null
    $Handle = if ($GateStarted) { Wait-ForGatedWindow $Deadline } else { 0 }
    if ($Handle) {
      $WindowWasGated = $true
    } else {
      [OmdChromeWindow]::CancelWindowGate()
      $Handle = Wait-ForNewChromeWindow $Baseline $Deadline '无法确认已安装的 Windows Chrome App 窗口已打开'
    }
    Set-TaskbarIdentity $Handle
    Restore-WindowSizeAndCenter $Handle
    if ($WindowWasGated) {
      [OmdChromeWindow]::WaitForWindowReadyToReveal($Handle, 1500) | Out-Null
      if (-not [OmdChromeWindow]::ReleaseWindowGate($Handle)) { throw '无法显示准备完成的 Windows Chrome App 窗口' }
    } else {
      [OmdChromeWindow]::Activate($Handle) | Out-Null
    }
    [System.IO.File]::WriteAllText([string]$Config.windowHandlePath, [string]$Handle, [System.Text.Encoding]::ASCII)
    return $Handle
  } catch {
    [OmdChromeWindow]::CancelWindowGate()
    if ($Handle) { [OmdChromeWindow]::Close($Handle) | Out-Null }
    Remove-Item -LiteralPath $Config.windowHandlePath -Force -ErrorAction SilentlyContinue
    throw
  }
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
    $Pattern = '(?:window\.__DSH_BOOT__|globalThis\[(?:"__DSH_BOOT__"|''__DSH_BOOT__'')\])\s*=\s*(\{.*?\})\s*</script>'
    $Match = [regex]::Match($Content, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $Match.Success) { return $false }
    try {
      $Boot = $Match.Groups[1].Value | ConvertFrom-Json
      $Entries = @($Boot.entries)
      if ($Entries.Count -eq 0) { return $false }
      foreach ($Entry in $Entries) {
        if ([string]::IsNullOrWhiteSpace([string]$Entry.id) -or -not ([string]$Entry.url).StartsWith('/plugins/')) { return $false }
      }
      return $true
    } catch {
      return $false
    }
  } catch {
    return $false
  } finally {
    if ($Response) { $Response.Dispose() }
  }
}

function Test-LaunchSurface {
  $Response = $null
  try {
    $Response = $HttpClient.GetAsync([string]$Config.url).GetAwaiter().GetResult()
    if (-not $Response.IsSuccessStatusCode) { return $false }
    $ContentType = [string]$Response.Content.Headers.ContentType
    if (-not $ContentType.Contains('text/html')) { return $true }
    $Content = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return $Content.Contains('id="omd-launch"') -or
      $Content.Contains('window.__DSH_BOOT__') -or
      $Content.Contains('globalThis["__DSH_BOOT__"]') -or
      $Content.Contains("globalThis['__DSH_BOOT__']")
  } catch {
    return $false
  } finally {
    if ($Response) { $Response.Dispose() }
  }
}

function Wait-ForLaunchSurface([datetime]$Deadline) {
  while ([datetime]::UtcNow -lt $Deadline) {
    if (Test-LaunchSurface) { return }
    Start-Sleep -Milliseconds 50
  }
  throw ("Windows 宿主机无法读取启动页 {0}" -f $Config.url)
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
    Start-Sleep -Milliseconds 100
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
    Start-Sleep -Milliseconds 100
  }
  throw '无法确认 Windows Chrome App 窗口已打开'
}

function Run-BrowserLifecycle {
  $ServiceDeadline = [datetime]::UtcNow.AddSeconds([int]$Config.timeoutSeconds)
  if ($Config.loadingMode) { Wait-ForLaunchSurface $ServiceDeadline } else { Wait-ForHostService $ServiceDeadline }
  if ($Config.launchMode -eq 'installed-pwa') {
    $Handle = Start-PwaWindow ([datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30)))
    Wait-ForWindowToClose $Handle
    Remove-Item -LiteralPath $Config.windowHandlePath -Force -ErrorAction SilentlyContinue
    return
  }
  $WindowBaseline = Get-ChromeWindowBaseline
  $GateStarted = Start-WindowGate $WindowBaseline ''
  $WindowWasGated = $false
  Start-HostChrome
  $BrowserDeadline = [datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30))
  Wait-ForDevTools $BrowserDeadline
  $Target = Wait-ForAppTarget ([datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30)))
  $WindowDeadline = [datetime]::UtcNow.AddSeconds([Math]::Min([int]$Config.timeoutSeconds, 30))
  $WindowHandle = if ($GateStarted) { Wait-ForGatedWindow $WindowDeadline } else { 0 }
  if ($WindowHandle) {
    $WindowWasGated = $true
  } else {
    [OmdChromeWindow]::CancelWindowGate()
    $WindowHandle = Wait-ForNewChromeWindow $WindowBaseline $WindowDeadline '无法确认 Windows Chrome App 窗口已打开'
  }
  Set-TaskbarIdentity $WindowHandle
  Restore-WindowSizeAndCenter $WindowHandle
  if ($WindowWasGated) {
    [OmdChromeWindow]::WaitForWindowReadyToReveal($WindowHandle, 1500) | Out-Null
    if (-not [OmdChromeWindow]::ReleaseWindowGate($WindowHandle)) { throw '无法显示准备完成的 Windows Chrome App 窗口' }
  } else {
    [OmdChromeWindow]::Activate($WindowHandle) | Out-Null
  }
  Invoke-DevTools ('/json/activate/' + [string]$Target.id) | Out-Null
  while ($true) {
    Save-WindowSize $WindowHandle
    $Snapshot = Get-TargetSnapshot
    if ($Snapshot.ok -and -not (@($Snapshot.items) | Where-Object { $_.id -eq $Target.id })) { return }
    if (-not (Test-ManagedChrome)) { return }
    Start-Sleep -Milliseconds 100
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

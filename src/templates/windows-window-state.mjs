export function renderWindowsWindowState() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][int]$ChromeProcessId,
  [Parameter(Mandatory=$true)][string]$BoundsPath,
  [Parameter(Mandatory=$true)][string]$ReadyPath,
  [int]$TimeoutSeconds = 10,
  [switch]$CompileOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OmdNativeWindowState {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hwnd, ref WindowPlacement placement);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

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

  public static long FindWindow(int expectedProcessId) {
    long result = 0;
    EnumWindows((hwnd, lParam) => {
      if (!IsWindowVisible(hwnd)) return true;
      var className = new StringBuilder(256);
      GetClassName(hwnd, className, className.Capacity);
      if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (processId != (uint)expectedProcessId) return true;
      result = hwnd.ToInt64();
      return false;
    }, IntPtr.Zero);
    return result;
  }

  public static bool IsAlive(long handle) {
    return IsWindow(new IntPtr(handle));
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
    ShowWindow(hwnd, 9);
    return SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0010);
  }
}
'@

if ($CompileOnly) { exit 0 }

function Read-SavedWindowSize {
  if (-not (Test-Path -LiteralPath $BoundsPath -PathType Leaf)) { return $null }
  try {
    $Saved = Get-Content -LiteralPath $BoundsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Width = [int]$Saved.width
    $Height = [int]$Saved.height
    if ($Width -lt 320 -or $Height -lt 240 -or $Width -gt 32768 -or $Height -gt 32768) { return $null }
    return [pscustomobject]@{ width = $Width; height = $Height }
  } catch {
    return $null
  }
}

function Save-WindowSize([long]$Handle) {
  $Size = [OmdNativeWindowState]::GetNormalSize($Handle)
  if (-not $Size -or $Size.Count -lt 2) { return }
  $Width = [int]$Size[0]
  $Height = [int]$Size[1]
  if ($Width -lt 320 -or $Height -lt 240) { return }
  $Key = ('{0}x{1}' -f $Width, $Height)
  if ($script:LastSavedWindowSize -eq $Key) { return }
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($BoundsPath)) | Out-Null
  $Json = @{ width = $Width; height = $Height } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($BoundsPath, $Json, [System.Text.UTF8Encoding]::new($false))
  $script:LastSavedWindowSize = $Key
}

$Deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
$Handle = 0
while ([datetime]::UtcNow -lt $Deadline) {
  $Handle = [OmdNativeWindowState]::FindWindow($ChromeProcessId)
  if ($Handle -ne 0) { break }
  Start-Sleep -Milliseconds 100
}
if ($Handle -eq 0) { throw '无法确认原生 Windows Chrome App 窗口已打开' }

$Saved = Read-SavedWindowSize
if ($Saved) {
  $Width = [int]$Saved.width
  $Height = [int]$Saved.height
} else {
  $Current = [OmdNativeWindowState]::GetNormalSize($Handle)
  if (-not $Current -or $Current.Count -lt 2) { throw '无法读取原生 Windows Chrome App 窗口尺寸' }
  $Width = [int]$Current[0]
  $Height = [int]$Current[1]
}

[OmdNativeWindowState]::CenterWithSize($Handle, $Width, $Height) | Out-Null
Start-Sleep -Milliseconds 100
[OmdNativeWindowState]::CenterWithSize($Handle, $Width, $Height) | Out-Null
[System.IO.File]::WriteAllText($ReadyPath, [string]$Handle, [System.Text.Encoding]::ASCII)

while ([OmdNativeWindowState]::IsAlive($Handle)) {
  Save-WindowSize $Handle
  Start-Sleep -Milliseconds 100
}
`;
}

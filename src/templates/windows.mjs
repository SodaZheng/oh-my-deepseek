export function renderWindowsHiddenLauncher({ programPath, programArguments, missingTitle, missingMessage, waitForExit = false }) {
  return `var shell = new ActiveXObject("WScript.Shell");
var fileSystem = new ActiveXObject("Scripting.FileSystemObject");
var programPath = ${stringifyForJScript(programPath)};
var programArguments = ${stringifyForJScript(programArguments)};
if (!fileSystem.FileExists(programPath)) {
  shell.Popup(${stringifyForJScript(missingMessage)}, 0, ${stringifyForJScript(missingTitle)}, 16);
  WScript.Quit(1);
}

function quoteArgument(value, force) {
  value = String(value);
  if (!force && value.length > 0 && !/[\\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\\\*)"/g, '$1$1\\\\"').replace(/(\\\\*)$/, '$1$1') + '"';
}
var commandParts = [quoteArgument(programPath, true)];
for (var index = 0; index < programArguments.length; index += 1) commandParts.push(quoteArgument(programArguments[index], false));
var command = commandParts.join(' ');
WScript.Quit(shell.Run(command, 0, ${waitForExit ? "true" : "false"}));
`;
}

export function renderWindowsNativeLauncherSource({ programPath, programArguments, appUserModelId, missingTitle, missingMessage }) {
  const encoded = (value) => Buffer.from(String(value), "utf8").toString("base64");
  const argumentValues = programArguments.map((value) => `Decode("${encoded(value)}")`).join(", ");
  return `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class OhMyDeepSeekLauncher {
  private static readonly string ProgramPath = Decode("${encoded(programPath)}");
  private static readonly string[] ProgramArguments = new string[] { ${argumentValues} };
  private static readonly string AppUserModelId = Decode("${encoded(appUserModelId)}");
  private static readonly string MissingTitle = Decode("${encoded(missingTitle)}");
  private static readonly string MissingMessage = Decode("${encoded(missingMessage)}");

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int MessageBoxW(IntPtr window, string message, string title, uint type);

  [STAThread]
  private static int Main() {
    try {
      SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
      if (!File.Exists(ProgramPath)) {
        MessageBoxW(IntPtr.Zero, MissingMessage, MissingTitle, 0x10);
        return 1;
      }
      var startInfo = new ProcessStartInfo {
        FileName = ProgramPath,
        Arguments = BuildCommandLine(ProgramArguments),
        WorkingDirectory = Path.GetDirectoryName(ProgramPath),
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden,
      };
      using (var process = Process.Start(startInfo)) {
        if (process == null) throw new InvalidOperationException("Failed to start the WSL supervisor.");
        process.WaitForExit();
        return process.ExitCode;
      }
    } catch (Exception error) {
      MessageBoxW(IntPtr.Zero, error.Message, MissingTitle, 0x10);
      return 1;
    }
  }

  private static string BuildCommandLine(string[] arguments) {
    var result = new StringBuilder();
    for (var index = 0; index < arguments.Length; index += 1) {
      if (index > 0) result.Append(' ');
      result.Append(QuoteArgument(arguments[index]));
    }
    return result.ToString();
  }

  private static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\\t', '\\n', '\\v', '"' }) < 0) return value;
    var result = new StringBuilder();
    result.Append('"');
    var backslashes = 0;
    foreach (var character in value) {
      if (character == '\\\\') {
        backslashes += 1;
        continue;
      }
      if (character == '"') {
        result.Append('\\\\', backslashes * 2 + 1);
        result.Append('"');
      } else {
        result.Append('\\\\', backslashes);
        result.Append(character);
      }
      backslashes = 0;
    }
    result.Append('\\\\', backslashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static string Decode(string value) {
    return Encoding.UTF8.GetString(Convert.FromBase64String(value));
  }
}
`;
}

export function renderWindowsPwaMonitorSource({ appUserModelId, launcherPath, windowHandlePath, monitorId }) {
  const encoded = (value) => Buffer.from(String(value), "utf8").toString("base64");
  return `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class OhMyDeepSeekPwaMonitor {
  private const uint EventObjectShow = 0x8002;
  private const uint WineventOutOfContext = 0;
  private const uint WineventSkipOwnProcess = 2;
  private const uint WmClose = 0x0010;
  private static readonly string ExpectedAppId = Decode("${encoded(appUserModelId)}");
  private static readonly string LauncherPath = Decode("${encoded(launcherPath)}");
  private static readonly string WindowHandlePath = Decode("${encoded(windowHandlePath)}");
  private static readonly string MutexName = "Local\\\\OhMyDeepSeek.PwaMonitor." + Decode("${encoded(monitorId)}");
  private static WinEventDelegate callback;
  private static int handling;

  private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint threadId, uint eventTime);

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
  private struct PropertyKey {
    internal Guid formatId;
    internal uint propertyId;
    internal PropertyKey(Guid formatId, uint propertyId) { this.formatId = formatId; this.propertyId = propertyId; }
  }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  private struct PropVariant {
    [FieldOffset(0)] internal ushort valueType;
    [FieldOffset(8)] internal IntPtr pointerValue;
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

  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr window, StringBuilder value, int count);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);
  [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);

  [STAThread]
  private static int Main() {
    bool created;
    using (var mutex = new Mutex(true, MutexName, out created)) {
      if (!created) return 0;
      callback = OnWindowShown;
      var hook = SetWinEventHook(EventObjectShow, EventObjectShow, IntPtr.Zero, callback, 0, 0, WineventOutOfContext | WineventSkipOwnProcess);
      if (hook == IntPtr.Zero) return 1;
      try {
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {}
      } finally {
        UnhookWinEvent(hook);
      }
    }
    return 0;
  }

  private static void OnWindowShown(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint threadId, uint eventTime) {
    if (objectId != 0 || childId != 0 || !IsWindowVisible(window) || File.Exists(WindowHandlePath)) return;
    var className = new StringBuilder(256);
    GetClassName(window, className, className.Capacity);
    if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return;
    Task.Run(() => InspectWindow(window));
  }

  private static void InspectWindow(IntPtr window) {
    for (var attempt = 0; attempt < 20 && IsWindow(window); attempt += 1) {
      if (File.Exists(WindowHandlePath)) return;
      if (string.Equals(ReadAppUserModelId(window), ExpectedAppId, StringComparison.OrdinalIgnoreCase)) {
        if (Interlocked.CompareExchange(ref handling, 1, 0) == 0) InterceptAndLaunch(window);
        return;
      }
      Thread.Sleep(50);
    }
  }

  private static void InterceptAndLaunch(IntPtr window) {
    try {
      PostMessage(window, WmClose, IntPtr.Zero, IntPtr.Zero);
      var deadline = DateTime.UtcNow.AddSeconds(3);
      while (IsWindow(window) && DateTime.UtcNow < deadline) Thread.Sleep(50);
      var startInfo = new ProcessStartInfo {
        FileName = LauncherPath,
        WorkingDirectory = Path.GetDirectoryName(LauncherPath),
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden,
      };
      using (var launcher = Process.Start(startInfo)) {
        if (launcher != null) launcher.WaitForExit();
      }
    } catch {
    } finally {
      Interlocked.Exchange(ref handling, 0);
    }
  }

  private static string ReadAppUserModelId(IntPtr window) {
    var interfaceId = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(window, ref interfaceId, out store) < 0 || store == null) return null;
    var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    PropVariant value;
    try {
      if (store.GetValue(ref key, out value) < 0) return null;
      try {
        if (value.pointerValue == IntPtr.Zero) return null;
        if (value.valueType == 31) return Marshal.PtrToStringUni(value.pointerValue);
        if (value.valueType == 8) return Marshal.PtrToStringBSTR(value.pointerValue);
        return null;
      } finally {
        PropVariantClear(ref value);
      }
    } finally {
      Marshal.FinalReleaseComObject(store);
    }
  }

  private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
}
`;
}

function stringifyForJScript(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function renderWindowsShortcutScript({ nativeLauncher = false } = {}) {
  const launchProperties = nativeLauncher
    ? `$Shortcut.TargetPath = $LauncherPath
$Shortcut.Arguments = ''`
    : `$Shortcut.TargetPath = (Get-Command wscript.exe).Source
$EscapedLauncher = $LauncherPath.Replace('"', '""')
$Shortcut.Arguments = '//B //NoLogo "' + $EscapedLauncher + '"'`;
  return `param(
  [Parameter(Mandatory=$true)][string]$ShortcutPath,
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$IconPath,
  [Parameter(Mandatory=$true)][string]$Description,
  [AllowEmptyString()][string]$AppUserModelId = ''
)

$Shell = New-Object -ComObject WScript.Shell
$ShortcutDirectory = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $ShortcutDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $ShortcutDirectory -Force | Out-Null
}
Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
${launchProperties}
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.IconLocation = "$IconPath,0"
$Shortcut.Description = $Description
$Shortcut.Save()

if (-not [string]::IsNullOrWhiteSpace($AppUserModelId)) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("00021401-0000-0000-C000-000000000046")]
internal class ShellLink {}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("0000010b-0000-0000-C000-000000000046")]
internal interface IPersistFile {
  [PreserveSig] int GetClassID(out Guid classId);
  [PreserveSig] int IsDirty();
  [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
  [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
  [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
  [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
}

[StructLayout(LayoutKind.Sequential)]
internal struct PropertyKey {
  internal Guid formatId;
  internal uint propertyId;
  internal PropertyKey(Guid formatId, uint propertyId) {
    this.formatId = formatId;
    this.propertyId = propertyId;
  }
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
internal struct PropVariant {
  [FieldOffset(0)] internal ushort valueType;
  [FieldOffset(8)] internal IntPtr pointerValue;

  internal static PropVariant FromString(string value) {
    return new PropVariant {
      valueType = 31,
      pointerValue = Marshal.StringToCoTaskMemUni(value)
    };
  }

  internal void Clear() { PropVariantClear(ref this); }

  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref PropVariant value);
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
internal interface IPropertyStore {
  [PreserveSig] int GetCount(out uint propertyCount);
  [PreserveSig] int GetAt(uint propertyIndex, out PropertyKey key);
  [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
  [PreserveSig] int Commit();
}

public static class ShortcutAppIdentity {
  private const uint ReadWrite = 2;
  private static readonly PropertyKey AppUserModelId = new PropertyKey(
    new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

  public static void Set(string shortcutPath, string appUserModelId) {
    object shellLink = new ShellLink();
    PropVariant value = PropVariant.FromString(appUserModelId);
    try {
      IPersistFile persistFile = (IPersistFile)shellLink;
      Marshal.ThrowExceptionForHR(persistFile.Load(shortcutPath, ReadWrite));
      IPropertyStore store = (IPropertyStore)shellLink;
      PropertyKey key = AppUserModelId;
      Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
      Marshal.ThrowExceptionForHR(store.Commit());
      Marshal.ThrowExceptionForHR(persistFile.Save(shortcutPath, true));
    } finally {
      value.Clear();
      Marshal.FinalReleaseComObject(shellLink);
    }
  }
}
'@
  [ShortcutAppIdentity]::Set($ShortcutPath, $AppUserModelId)
}
`;
}

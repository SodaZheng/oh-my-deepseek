export function renderWindowsHiddenLauncher({ programPath, programArguments, missingTitle, missingMessage }) {
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
WScript.Quit(shell.Run(command, 0, true));
`;
}

function stringifyForJScript(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function renderWindowsShortcutScript() {
  return `param(
  [Parameter(Mandatory=$true)][string]$ShortcutPath,
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$IconPath,
  [Parameter(Mandatory=$true)][string]$Description,
  [AllowEmptyString()][string]$AppUserModelId = ''
)

$Shell = New-Object -ComObject WScript.Shell
Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Get-Command wscript.exe).Source
$EscapedLauncher = $LauncherPath.Replace('"', '""')
$Shortcut.Arguments = '//B //NoLogo "' + $EscapedLauncher + '"'
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

[StructLayout(LayoutKind.Explicit, Size = 16)]
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
      Marshal.ThrowExceptionForHR(((IPersistFile)shellLink).Load(shortcutPath, ReadWrite));
      IPropertyStore store = (IPropertyStore)shellLink;
      PropertyKey key = AppUserModelId;
      Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
      Marshal.ThrowExceptionForHR(store.Commit());
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

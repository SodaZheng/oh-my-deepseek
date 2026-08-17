export function renderWindowsLauncher(config) {
  return `$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $Config.nodePath -PathType Leaf)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("创建 $($Config.name) 时使用的 Node.js 已被移动或删除：$($Config.nodePath)", '找不到 Node.js', 'OK', 'Error') | Out-Null
  exit 1
}

$NodePath = [string]$Config.nodePath
& $NodePath (Join-Path $Root 'supervisor.mjs')
exit $LASTEXITCODE
`;
}

export function renderWindowsShortcutScript() {
  return `param(
  [Parameter(Mandatory=$true)][string]$ShortcutPath,
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$IconPath,
  [Parameter(Mandatory=$true)][string]$Description
)

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Get-Command powershell.exe).Source
$EscapedLauncher = $LauncherPath.Replace('"', '""')
$Shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $EscapedLauncher + '"'
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.IconLocation = "$IconPath,0"
$Shortcut.Description = $Description
$Shortcut.Save()
`;
}

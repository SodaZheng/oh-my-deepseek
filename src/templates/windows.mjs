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
  [Parameter(Mandatory=$true)][string]$Description
)

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Get-Command wscript.exe).Source
$EscapedLauncher = $LauncherPath.Replace('"', '""')
$Shortcut.Arguments = '//B //NoLogo "' + $EscapedLauncher + '"'
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.IconLocation = "$IconPath,0"
$Shortcut.Description = $Description
$Shortcut.Save()
`;
}

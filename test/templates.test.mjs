import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { renderMacInfoPlist, renderMacLaunchAgent, renderMacLauncher, renderMacMonitor } from "../src/templates/macos.mjs";
import { renderMacNativeMonitorSource } from "../src/templates/macos-native-monitor.mjs";
import { renderSupervisor } from "../src/templates/supervisor.mjs";
import { renderWindowsHiddenLauncher, renderWindowsShortcutScript } from "../src/templates/windows.mjs";
import { renderWindowsHostBrowser } from "../src/templates/wsl.mjs";

const macConfig = normalizeCreateOptions(
  { name: "Agent & Tools", command: "npm run dev", url: "http://localhost:5173" },
  { platform: "darwin", cwd: "/tmp/project with spaces" },
);

test("macOS templates preserve config and escape plist values", () => {
  const plist = renderMacInfoPlist(macConfig);
  const launcher = renderMacLauncher(macConfig);
  const supervisor = renderSupervisor();
  assert.match(plist, /Agent &amp; Tools/);
  assert.match(plist, /OMDGeneratedBy/);
  assert.doesNotMatch(plist, /LSUIElement/);
  assert.match(launcher, /supervisor\.mjs/);
  assert.doesNotMatch(launcher, /Terminal/);
  assert.match(supervisor, /--user-data-dir=/);
  assert.match(supervisor, /DevToolsActivePort/);
  assert.match(supervisor, /stopProcessTree/);
  assert.match(supervisor, /window\.__DSH_BOOT__/);
  assert.match(supervisor, /<title>DeepSeek Harness<\/title>/);
});

test("macOS monitor and LaunchAgent templates stay invisible while supervising cold starts", () => {
  const monitor = renderMacMonitor();
  const nativeMonitor = renderMacNativeMonitorSource();
  const launchAgent = renderMacLaunchAgent({
    label: "dev.ohmydeepseek.monitor.test",
    programArguments: ["/opt/node & tools/bin/node", "/tmp/monitor.mjs"],
    logPath: "/tmp/monitor.log",
  });
  assert.match(monitor, /terminateAppProcesses/);
  assert.match(monitor, /runSupervisor/);
  assert.match(monitor, /serviceIsReady/);
  assert.match(nativeMonitor, /forKeyPath:@"runningApplications"/);
  assert.match(nativeMonitor, /runningApplicationsWithBundleIdentifier/);
  assert.match(nativeMonitor, /launchAndReturnError/);
  assert.match(launchAgent, /dev\.ohmydeepseek\.monitor\.test/);
  assert.match(launchAgent, /<string>Background<\/string>/);
  assert.match(launchAgent, /<string>Aqua<\/string>/);
  assert.match(launchAgent, /\/opt\/node &amp; tools\/bin\/node/);
});

test("Windows templates run a hidden lifecycle supervisor", () => {
  const hiddenLauncher = renderWindowsHiddenLauncher({
    programPath: "C:\\程序\\node.exe",
    programArguments: ["C:\\应用\\supervisor.mjs"],
    missingTitle: "找不到 Node",
    missingMessage: "Node 已移动",
  });
  const supervisor = renderSupervisor();
  const shortcut = renderWindowsShortcutScript();
  assert.match(hiddenLauncher, /WScript\.Shell/);
  assert.match(hiddenLauncher, /shell\.Run\(command, 0, false\)/);
  assert.doesNotMatch(hiddenLauncher, /powershell\.exe/i);
  assert.equal(hiddenLauncher.includes('replace(/(\\\\*)"/g'), true);
  assert.match(hiddenLauncher, /if \(!force && value\.length > 0/);
  assert.match(hiddenLauncher, /quoteArgument\(programPath, true\)/);
  assert.match(hiddenLauncher, /quoteArgument\(programArguments\[index\], false\)/);
  assert.equal(/[^\x00-\x7f]/.test(hiddenLauncher), false);
  assert.match(hiddenLauncher, /\\u7a0b\\u5e8f/);
  assert.match(supervisor, /powershell\.exe/);
  assert.match(supervisor, /taskkill\.exe/);
  assert.match(shortcut, /wscript\.exe/);
  assert.doesNotMatch(shortcut, /TargetPath = \(Get-Command powershell\.exe\)/);
  assert.match(shortcut, /CreateShortcut/);
  assert.match(shortcut, /AppUserModelId/);
  assert.match(shortcut, /9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3/);
  assert.match(shortcut, /ShortcutAppIdentity/);
});

test("WSL templates keep service ownership in Linux and browser ownership in Windows", () => {
  const launcher = renderWindowsHiddenLauncher({
    programPath: "C:\\Windows\\System32\\wsl.exe",
    programArguments: ["--distribution", "Ubuntu", "--exec", "/usr/bin/node", "/app/supervisor.mjs"],
    missingTitle: "Missing WSL",
    missingMessage: "WSL moved",
  });
  const browserHost = renderWindowsHostBrowser();
  const supervisor = renderSupervisor();
  assert.match(launcher, /wsl\.exe/);
  assert.match(launcher, /--distribution/);
  assert.match(launcher, /--exec/);
  assert.match(browserHost, /DevToolsActivePort/);
  assert.match(browserHost, /Get-TargetSnapshot/);
  assert.match(browserHost, /function Test-HttpService/);
  assert.match(browserHost, /window\.__DSH_BOOT__/);
  assert.match(browserHost, /ConsecutiveSuccesses/);
  assert.doesNotMatch(browserHost, /function Test-TcpPort/);
  assert.match(browserHost, /installed-pwa/);
  assert.match(browserHost, /class OmdChromeWindow/);
  assert.match(browserHost, /Start-PwaWindow/);
  assert.match(browserHost, /GetWindows\(string executablePath\)/);
  assert.match(browserHost, /SHGetPropertyStoreForWindow/);
  assert.match(browserHost, /SetAppUserModelId/);
  assert.match(browserHost, /function Set-TaskbarIdentity/);
  assert.match(browserHost, /Set-TaskbarIdentity \$WindowHandle/);
  assert.match(browserHost, /PostMessage\(hwnd, 0x0010/);
  assert.match(browserHost, /taskkill\.exe/);
  assert.match(browserHost, /\('--app=' \+ \[string\]\$Config\.url\)/);
  assert.match(browserHost, /--window-position=100,100/);
  assert.match(browserHost, /--window-size=1280,800/);
  assert.match(browserHost, /function Run-BrowserLifecycle \{[\s\S]*Wait-ForHostService \$ServiceDeadline[\s\S]*Start-HostChrome/);
  assert.doesNotMatch(browserHost, /Preparing%20Chrome%20Runtime|--window-position=-10000,-10000|function Open-AppWindow/);
  assert.match(supervisor, /windows-host-browser/);
  assert.match(supervisor, /config\.directService\?\.executable/);
  assert.match(supervisor, /直接执行服务入口/);
  assert.match(supervisor, /NODE_COMPILE_CACHE/);
  assert.match(supervisor, /serviceShell/);
  assert.match(supervisor, /function powerShellExecutable/);
  assert.match(supervisor, /const alert = spawn\(powerShellExecutable\(\)/);
  assert.doesNotMatch(supervisor, /spawn(?:Sync)?\("powershell\.exe"/);
});

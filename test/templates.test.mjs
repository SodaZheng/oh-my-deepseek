import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { renderMacInfoPlist, renderMacLaunchAgent, renderMacLauncher, renderMacMonitor } from "../src/templates/macos.mjs";
import { renderMacNativeMonitorSource } from "../src/templates/macos-native-monitor.mjs";
import { renderMacLoadingDocument, renderMacLoadingOverlayBody, renderMacLoadingOverlayHead } from "../src/templates/macos-loading.mjs";
import { renderMacOnDemandActivatorSource, renderMacOnDemandProxy } from "../src/templates/macos-on-demand.mjs";
import { renderMacManagedLaunchAgent, renderMacOnDemandLaunchAgent, renderMacServiceManagerInfo, renderMacServiceManagerSource } from "../src/templates/macos-service-manager.mjs";
import { renderSupervisor } from "../src/templates/supervisor.mjs";
import { renderWindowsHiddenLauncher, renderWindowsNativeLauncherSource, renderWindowsPwaMonitorSource, renderWindowsShortcutScript } from "../src/templates/windows.mjs";
import { renderWindowsLoadingLauncherSource } from "../src/templates/windows-loading-launcher.mjs";
import { renderWindowsWindowState } from "../src/templates/windows-window-state.mjs";
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
  assert.match(supervisor, /stopConfiguredPortListeners/);
  assert.match(supervisor, /requireConfiguredPortReleased/);
  assert.match(supervisor, /\/usr\/sbin\/lsof/);
  assert.match(supervisor, /Get-NetTCPConnection/);
  assert.match(supervisor, /netstat\.exe/);
  assert.match(supervisor, /\/proc\/net\/tcp6/);
  assert.equal(supervisor.includes("/proc/${pid}/fd"), true);
  assert.match(supervisor, /端口 \\?\$\{port\} 已释放/);
  assert.match(supervisor, /process\.kill\(pid, force \? "SIGKILL" : "SIGTERM"\)/);
  assert.match(supervisor, /if \(force\) argumentsList\.push\("\/f"\)/);
  assert.match(supervisor, /window\.__DSH_BOOT__/);
  assert.match(supervisor, /globalThis\["__DSH_BOOT__"\]/);
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
  assert.match(monitor, /globalThis\["__DSH_BOOT__"\]/);
  assert.match(nativeMonitor, /forKeyPath:@"runningApplications"/);
  assert.match(nativeMonitor, /runningApplicationsWithBundleIdentifier/);
  assert.match(nativeMonitor, /launchAndReturnError/);
  assert.match(launchAgent, /dev\.ohmydeepseek\.monitor\.test/);
  assert.match(launchAgent, /<string>Background<\/string>/);
  assert.match(launchAgent, /<string>Aqua<\/string>/);
  assert.match(launchAgent, /\/opt\/node &amp; tools\/bin\/node/);

  const managedLaunchAgent = renderMacManagedLaunchAgent({
    label: "dev.ohmydeepseek.monitor.test",
    monitorConfigPath: "/tmp/config & state.json",
    logPath: "/tmp/monitor.log",
  });
  const managerInfo = renderMacServiceManagerInfo({
    bundleIdentifier: "dev.ohmydeepseek.background-launcher.test",
    name: "Test Harness",
  });
  const managerSource = renderMacServiceManagerSource({ launchAgentPlistName: "dev.ohmydeepseek.monitor.test.plist" });
  assert.match(managedLaunchAgent, /<key>BundleProgram<\/key>/);
  assert.match(managedLaunchAgent, /Contents\/MacOS\/monitor/);
  assert.match(managedLaunchAgent, /config &amp; state\.json/);
  assert.match(managerInfo, /LSBackgroundOnly/);
  assert.match(managerInfo, /dev\.ohmydeepseek\.background-launcher\.test/);
  assert.match(managerSource, /SMAppService/);
  assert.match(managerSource, /agentServiceWithPlistName/);
  assert.match(managerSource, /requires-approval/);
});

test("macOS on-demand templates use socket activation without an idle process", () => {
  const activator = renderMacOnDemandActivatorSource();
  const proxy = renderMacOnDemandProxy();
  const launchAgent = renderMacOnDemandLaunchAgent({
    label: "dev.ohmydeepseek.ondemand.test",
    configPath: "/tmp/config & state.json",
    logPath: "/tmp/on-demand.log",
    host: "127.0.0.1",
    port: 3080,
  });
  const loadingDocument = renderMacLoadingDocument();
  const loadingOverlay = renderMacLoadingOverlayHead() + renderMacLoadingOverlayBody();
  assert.match(activator, /launch_activate_socket/);
  assert.match(activator, /first request buffered until DSH readiness/);
  assert.match(activator, /while \(revealed \|\| \[deadline timeIntervalSinceNow\] > 0\)/);
  assert.doesNotMatch(activator, /HideApplications|ActivateApplications|CGSSetWindowAlpha/);
  assert.match(proxy, /OMD_LISTEN_FD/);
  assert.match(proxy, /serviceKind !== "dsh-web"/);
  assert.match(proxy, /consecutiveSuccesses >= 2/);
  assert.match(proxy, /__omd_loading_icon/);
  assert.match(proxy, /__omd_handoff_complete/);
  assert.match(proxy, /__omd_handoff_ready/);
  assert.match(proxy, /browserLoadingServed/);
  assert.match(proxy, /injectLoadingOverlay/);
  assert.match(loadingDocument, /omd-whale-breathe/);
  assert.match(loadingDocument, /omd-whale-pearl/);
  assert.match(loadingDocument, /feColorMatrix/);
  assert.match(loadingDocument, /0\.770[\s\S]*amplitude="0\.62"/);
  assert.match(loadingDocument, /clip-path: inset\(19% 10% 18% 14%\)/);
  assert.doesNotMatch(loadingDocument, /omd-depth-breathe|omd-surface-light/);
  assert.match(loadingDocument, /#151517/);
  assert.match(loadingDocument, /__OMD_APP_NAME__ 正在启动/);
  assert.match(loadingOverlay, /omd-launch--leaving/);
  assert.match(loadingOverlay, /MutationObserver/);
  assert.match(loadingOverlay, /__omd_handoff_complete/);
  assert.match(loadingOverlay, /prefers-reduced-motion/);
  assert.match(launchAgent, /<key>Sockets<\/key>/);
  assert.match(launchAgent, /<key>BundleProgram<\/key>/);
  assert.doesNotMatch(launchAgent, /<key>RunAtLoad<\/key>|<key>KeepAlive<\/key>/);
  assert.match(launchAgent, /config &amp; state\.json/);
});

test("Windows templates run a hidden lifecycle supervisor", () => {
  const hiddenLauncher = renderWindowsHiddenLauncher({
    programPath: "C:\\程序\\node.exe",
    programArguments: ["C:\\应用\\supervisor.mjs"],
    missingTitle: "找不到 Node",
    missingMessage: "Node 已移动",
  });
  const supervisor = renderSupervisor();
  const windowState = renderWindowsWindowState();
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
  assert.match(supervisor, /if \(config\.platform === "win32"\)/);
  assert.match(supervisor, /chromeChild = startChrome\(true\);\s+await waitForChromeDevTools\(\);/);
  assert.match(supervisor, /windowStateChild = await startWindowsWindowState\(\)/);
  assert.match(supervisor, /config\.windowStateScriptPath/);
  assert.match(windowState, /GetWindowPlacement/);
  assert.match(windowState, /MonitorFromWindow/);
  assert.match(windowState, /SetWindowPos/);
  assert.match(windowState, /FindWindow\(int expectedProcessId\)/);
  assert.match(windowState, /Save-WindowSize \$Handle/);
  assert.match(shortcut, /wscript\.exe/);
  assert.doesNotMatch(shortcut, /TargetPath = \(Get-Command powershell\.exe\)/);
  assert.match(shortcut, /CreateShortcut/);
  assert.match(shortcut, /New-Item -ItemType Directory/);
  assert.match(shortcut, /AppUserModelId/);
  assert.match(shortcut, /9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3/);
  assert.match(shortcut, /ShortcutAppIdentity/);
  assert.match(shortcut, /persistFile\.Save\(shortcutPath, true\)/);
  assert.match(shortcut, /Size = 24/);
  assert.doesNotMatch(shortcut, /Size = 16/);
});

test("WSL templates keep service ownership in Linux and browser ownership in Windows", () => {
  const launcher = renderWindowsNativeLauncherSource({
    programPath: "C:\\Windows\\System32\\wsl.exe",
    programArguments: ["--distribution", "Ubuntu", "--exec", "/usr/bin/node", "/app/supervisor.mjs"],
    appUserModelId: "OpenAI.OhMyDeepSeek.test",
    missingTitle: "Missing WSL",
    missingMessage: "WSL moved",
  });
  const shortcut = renderWindowsShortcutScript({ nativeLauncher: true });
  const loadingLauncher = renderWindowsLoadingLauncherSource({
    programPath: "C:\\Windows\\System32\\wsl.exe",
    programArguments: ["--distribution", "Ubuntu", "--exec", "/usr/bin/node", "/app/supervisor.mjs"],
    appUserModelId: "OpenAI.OhMyDeepSeek.test",
    loadingName: "DeepSeek Harness",
    loadingMessage: "DeepSeek Harness 正在启动",
    loadingIconPath: "C:\\App\\loading-whale.png",
    windowIconPath: "C:\\App\\app.ico",
    windowBoundsPath: "C:\\State\\window-size.json",
    loadingBoundsPath: "C:\\State\\loading-window.json",
    handoffReadyPath: "C:\\State\\launcher-handoff.ready",
    activeWindowHandlePath: "C:\\App\\app-window.txt",
    missingTitle: "Missing WSL",
    missingMessage: "WSL moved",
  });
  const pwaMonitor = renderWindowsPwaMonitorSource({
    appUserModelId: "Chrome._crx_test",
    launcherPath: "C:\\App\\launcher.exe",
    windowHandlePath: "C:\\App\\app-window.txt",
    monitorId: "test",
  });
  const browserHost = renderWindowsHostBrowser();
  const supervisor = renderSupervisor();
  assert.match(launcher, /SetCurrentProcessExplicitAppUserModelID/);
  assert.match(launcher, /CreateNoWindow = true/);
  assert.match(launcher, /Process\.Start/);
  assert.match(launcher, /process\.WaitForExit\(\)/);
  assert.match(loadingLauncher, /OhMyDeepSeekLoadingLauncher/);
  assert.match(loadingLauncher, /Application\.Run\(form\)/);
  assert.match(loadingLauncher, /SystemParametersInfo\(0x1042/);
  assert.match(loadingLauncher, /DwmFlush\(\)/);
  assert.match(loadingLauncher, /private void RenderLoop\(\)/);
  assert.match(loadingLauncher, /CreateTransparentWhale/);
  assert.match(loadingLauncher, /ImageLockMode\.ReadWrite/);
  assert.match(loadingLauncher, /bytes\[offset\] = 186/);
  assert.match(loadingLauncher, /coverage \* 158\.0/);
  assert.match(loadingLauncher, /x < 38 \|\| x > 230 \|\| y < 50 \|\| y > 210/);
  assert.match(loadingLauncher, /DrawWaterline/);
  assert.doesNotMatch(loadingLauncher, /DrawDepthGlow|DrawSpecular/);
  assert.match(loadingLauncher, /Color\.FromArgb\(21, 21, 23\)/);
  assert.match(loadingLauncher, /Screen\.PrimaryScreen\.WorkingArea/);
  assert.match(loadingLauncher, /TopMost = true/);
  assert.match(loadingLauncher, /HandoffReadyPath/);
  assert.match(shortcut, /\$Shortcut\.TargetPath = \$LauncherPath/);
  assert.doesNotMatch(shortcut, /Get-Command wscript\.exe/);
  assert.match(pwaMonitor, /SetWinEventHook/);
  assert.match(pwaMonitor, /EventObjectCreate/);
  assert.match(pwaMonitor, /EventObjectShow/);
  assert.match(pwaMonitor, /DwmSetWindowAttribute/);
  assert.match(pwaMonitor, /DwmwaCloak = 13/);
  assert.match(pwaMonitor, /ConcurrentDictionary/);
  assert.match(pwaMonitor, /ShowWindow\(window, 0\)/);
  assert.match(pwaMonitor, /ReadAppUserModelId/);
  assert.match(pwaMonitor, /Size = 24/);
  assert.doesNotMatch(pwaMonitor, /Size = 16/);
  assert.match(pwaMonitor, /launcher\.WaitForExit/);
  const pwaMonitorCallback = pwaMonitor.slice(
    pwaMonitor.indexOf("private static void OnWindowEvent"),
    pwaMonitor.indexOf("private static void InspectWindow"),
  );
  assert.ok(pwaMonitorCallback.indexOf("SetWindowCloaked(window, true)") < pwaMonitorCallback.indexOf("Task.Run"));
  assert.match(browserHost, /DevToolsActivePort/);
  assert.match(browserHost, /Get-TargetSnapshot/);
  assert.match(browserHost, /function Test-HttpService/);
  assert.match(browserHost, /function Test-LaunchSurface/);
  assert.match(browserHost, /function Wait-ForPageHandoff/);
  assert.match(browserHost, /function Write-LauncherHandoff/);
  assert.match(browserHost, /PositionWithBounds/);
  assert.match(browserHost, /Track-ManagedChromeWindow/);
  assert.match(browserHost, /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(browserHost, /Windows Chrome 在初始化期间退出/);
  assert.doesNotMatch(browserHost, /Write-Error \$Message/);
  assert.match(browserHost, /id="omd-launch"/);
  assert.match(browserHost, /__DSH_BOOT__/);
  assert.match(browserHost, /ConvertFrom-Json/);
  assert.match(browserHost, /Entries\.Count -eq 0/);
  assert.match(browserHost, /ConsecutiveSuccesses/);
  assert.doesNotMatch(browserHost, /function Test-TcpPort/);
  assert.match(browserHost, /installed-pwa/);
  assert.match(browserHost, /class OmdChromeWindow/);
  assert.match(browserHost, /BeginWindowGate/);
  assert.match(browserHost, /WaitForGatedWindow/);
  assert.match(browserHost, /ReleaseWindowGate/);
  const pwaLaunch = browserHost.slice(
    browserHost.indexOf("function Start-PwaWindow"),
    browserHost.indexOf("function Test-HttpService"),
  );
  assert.ok(pwaLaunch.indexOf("Wait-ForPageHandoff") < pwaLaunch.indexOf("ReleaseWindowGate"));
  assert.ok(pwaLaunch.indexOf("ReleaseWindowGate") < pwaLaunch.indexOf("Write-LauncherHandoff"));
  assert.match(browserHost, /EventObjectCreate/);
  assert.match(browserHost, /DwmSetWindowAttribute/);
  assert.match(browserHost, /SetWindowCloaked\(hwnd, false\)/);
  assert.match(browserHost, /WaitForWindowReadyToReveal/);
  assert.match(browserHost, /SendMessageTimeout/);
  assert.match(browserHost, /DwmFlush/);
  assert.match(browserHost, /stableReadings >= 6/);
  assert.match(browserHost, /RedrawWindow/);
  assert.match(browserHost, /ShowWindow\(window, 0\)/);
  const windowGateCallback = browserHost.slice(
    browserHost.indexOf("private static void OnGateWindowEvent"),
    browserHost.indexOf("private static void InspectGateCandidate"),
  );
  assert.ok(windowGateCallback.indexOf("SetWindowCloaked(window, true)") < windowGateCallback.indexOf("Task.Run"));
  assert.match(browserHost, /Start-PwaWindow/);
  assert.match(browserHost, /GetWindows\(string executablePath\)/);
  assert.match(browserHost, /GetAllWindows\(string executablePath\)/);
  assert.match(browserHost, /SHGetPropertyStoreForWindow/);
  assert.match(browserHost, /SetTaskbarProperties/);
  assert.match(browserHost, /iconKey = new PropertyKey\(formatId, 3\)/);
  assert.match(browserHost, /taskbarIconResource/);
  assert.match(browserHost, /sourceAppUserModelId/);
  assert.match(browserHost, /GetAppUserModelId/);
  assert.match(browserHost, /GetTaskbarIconResource/);
  assert.match(browserHost, /GetWindowPlacement/);
  assert.match(browserHost, /MonitorFromWindow/);
  assert.match(browserHost, /SetWindowPos/);
  assert.match(browserHost, /function Restore-WindowSizeAndCenter/);
  assert.match(browserHost, /function Save-WindowSize/);
  assert.match(browserHost, /Wait-ForWindowToClose \$Handle/);
  assert.match(browserHost, /Restore-WindowSizeAndCenter \$WindowHandle/);
  assert.match(browserHost, /function Set-TaskbarIdentity/);
  assert.match(browserHost, /Set-TaskbarIdentity \$WindowHandle/);
  assert.match(browserHost, /ActualAppUserModelId/);
  assert.match(browserHost, /ActualTaskbarIconResource/);
  assert.match(browserHost, /managed-launch/);
  const pwaStart = browserHost.slice(
    browserHost.indexOf("function Start-PwaWindow"),
    browserHost.indexOf("function Test-HttpService"),
  );
  assert.ok(pwaStart.indexOf("Start-WindowGate") < pwaStart.indexOf("Start-Process"));
  assert.ok(pwaStart.indexOf("Set-TaskbarIdentity") < pwaStart.indexOf("ReleaseWindowGate"));
  assert.ok(pwaStart.indexOf("Restore-WindowSizeAndCenter") < pwaStart.indexOf("ReleaseWindowGate"));
  assert.ok(pwaStart.indexOf("WaitForWindowReadyToReveal") < pwaStart.indexOf("ReleaseWindowGate"));
  const centerWithSize = browserHost.slice(
    browserHost.indexOf("public static bool CenterWithSize"),
    browserHost.indexOf("public static bool Close"),
  );
  assert.doesNotMatch(centerWithSize, /ShowWindow/);
  const browserLifecycle = browserHost.slice(
    browserHost.indexOf("function Run-BrowserLifecycle"),
    browserHost.indexOf("if ($Mode -eq 'Activate')"),
  );
  assert.ok(browserLifecycle.indexOf("Start-WindowGate") < browserLifecycle.indexOf("Start-HostChrome"));
  assert.ok(browserLifecycle.lastIndexOf("Set-TaskbarIdentity") < browserLifecycle.lastIndexOf("ReleaseWindowGate"));
  assert.ok(browserLifecycle.lastIndexOf("Restore-WindowSizeAndCenter") < browserLifecycle.lastIndexOf("ReleaseWindowGate"));
  assert.ok(browserLifecycle.lastIndexOf("WaitForWindowReadyToReveal") < browserLifecycle.lastIndexOf("ReleaseWindowGate"));
  assert.match(browserHost, /Size = 24/);
  assert.doesNotMatch(browserHost, /Size = 16/);
  assert.match(browserHost, /PostMessage\(hwnd, 0x0010/);
  assert.match(browserHost, /taskkill\.exe/);
  assert.match(browserHost, /\('--app=' \+ \[string\]\$Config\.url\)/);
  assert.doesNotMatch(browserHost, /--window-position=/);
  assert.doesNotMatch(browserHost, /--window-size=/);
  assert.match(browserHost, /function Run-BrowserLifecycle \{[\s\S]*Wait-ForHostService \$ServiceDeadline[\s\S]*Start-HostChrome/);
  assert.match(browserHost, /Config\.loadingMode[\s\S]*Wait-ForLaunchSurface/);
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

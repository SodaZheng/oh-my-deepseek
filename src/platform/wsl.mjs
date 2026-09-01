import { copyFile, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { renderWindowsNativeLauncherSource, renderWindowsShortcutScript } from "../templates/windows.mjs";
import { renderWindowsHostBrowser } from "../templates/wsl.mjs";
import {
  parseSimpleServiceCommand,
  resolveDirectPosixService,
  warmDirectServiceCompileCache,
} from "../service-command.mjs";
import { ensureDirectory, pathExists, powershellSingleQuote, removeExactTarget, writeText } from "../utils.mjs";

export { parseSimpleServiceCommand, warmDirectServiceCompileCache } from "../service-command.mjs";

export async function createWslLauncher(config, chrome, interop = defaultInterop) {
  if (!config.wslDistro) throw new Error("无法确定当前 WSL 发行版；请在 WSL 终端中重新运行");
  if (!config.wslUser) throw new Error("无法确定当前 WSL 用户；请确认 USER 环境变量可用");

  const windowsEnvironment = interop.getWindowsEnvironment();
  const appKey = `${config.slug}-${config.instanceId.slice(0, 8)}`;
  const supportRoot = path.join(config.homeDirectory, ".local", "share", "oh-my-deepseek", "apps");
  const supportDirectory = path.join(supportRoot, appKey);
  const stateDirectory = path.join(config.homeDirectory, ".local", "state", "oh-my-deepseek", "apps", appKey);
  const logPath = path.join(config.homeDirectory, ".local", "state", "oh-my-deepseek", "logs", `${config.slug}.log`);

  const hostSupportRoot = path.win32.join(windowsEnvironment.localAppData, "Oh My DeepSeek", "wsl-apps");
  const hostSupportDirectory = path.win32.join(hostSupportRoot, appKey);
  const hostStateDirectory = path.win32.join(windowsEnvironment.localAppData, "Oh My DeepSeek", "state", appKey);
  const hostSupportRootWsl = interop.toWslPath(hostSupportRoot);
  const hostSupportDirectoryWsl = interop.toWslPath(hostSupportDirectory);
  const hostStateDirectoryWsl = interop.toWslPath(hostStateDirectory);
  const powerShellPathWsl = interop.toWslPath(windowsEnvironment.powerShell);
  const resolvedDirectService = await interop.resolveDirectService(config);
  const directService = resolvedDirectService
    ? { ...resolvedDirectService, nodeCompileCachePath: path.join(stateDirectory, "node-compile-cache") }
    : null;
  const installedWebApp = await findInstalledWindowsWebApp({ config, chrome, windowsEnvironment, interop });
  const officialPwaIdentity = installedWebApp
    ? interop.findPwaShortcutIdentity({ installedWebApp, windowsEnvironment })
    : null;
  if (installedWebApp && !officialPwaIdentity) {
    throw new Error("检测到 Chrome PWA，但找不到其官方 Windows 快捷方式或 AppUserModelID。请在 Chrome 中重新安装该页面为应用并保留开始菜单快捷方式后再运行 create");
  }
  const appUserModelId = `OpenAI.OhMyDeepSeek.${config.instanceId}`;
  const officialPwaAppUserModelId = officialPwaIdentity?.appUserModelId ?? null;
  const usesOfficialPwaEntry = Boolean(officialPwaIdentity);
  const pinnedPwaShortcutPath = officialPwaIdentity?.pinnedShortcutPath ?? null;
  const pinnedPwaShortcutPathWsl = pinnedPwaShortcutPath ? interop.toWslPath(pinnedPwaShortcutPath) : null;
  const pinnedPwaShortcutBackupPath = path.win32.join(hostStateDirectory, "original-pinned-pwa.lnk");
  const pinnedPwaShortcutBackupPathWsl = interop.toWslPath(pinnedPwaShortcutBackupPath);
  const chromeProfilePath = path.win32.join(windowsEnvironment.localAppData, "Oh My DeepSeek", "profiles", appKey);
  const chromeProfilePathWsl = interop.toWslPath(chromeProfilePath);
  const shortcutDirectory = config.output ? interop.toWindowsPath(config.output) : windowsEnvironment.desktop;
  const shortcutPath = path.win32.join(shortcutDirectory, `${config.name}.lnk`);
  const shortcutPathWsl = interop.toWslPath(shortcutPath);
  const startMenuShortcutPath = path.win32.join(windowsEnvironment.programs, "Oh My DeepSeek", `${config.name}.lnk`);
  const startMenuShortcutPathWsl = interop.toWslPath(startMenuShortcutPath);
  const monitorStartupShortcutPath = path.win32.join(windowsEnvironment.startup, `${config.name} Monitor.lnk`);
  const monitorStartupShortcutPathWsl = interop.toWslPath(monitorStartupShortcutPath);
  const lockPath = path.join(stateDirectory, "supervisor.lock");
  const legacyPrewarmLockPath = path.join(stateDirectory, "prewarm.lock");
  const legacyPrewarmReadyPath = path.join(stateDirectory, "prewarm-ready.json");
  const legacyPrewarmScriptPath = path.join(supportDirectory, "wsl-prewarm.mjs");
  const legacyStartupShortcutPathWsl = windowsEnvironment.startup
    ? interop.toWslPath(path.win32.join(windowsEnvironment.startup, `${config.name} (WSL Warm Start).lnk`))
    : null;
  const existingInstallPaths = [
    supportDirectory,
    hostSupportDirectoryWsl,
    shortcutPathWsl,
    startMenuShortcutPathWsl,
    monitorStartupShortcutPathWsl,
  ];
  const replacedExisting = (await Promise.all(existingInstallPaths.map(pathExists))).some(Boolean);

  const result = {
    platform: "wsl",
    shortcutPath,
    supportDirectory,
    hostSupportDirectory,
    chromePath: chrome.executable,
    powerShellPath: powerShellPathWsl,
    usesInstalledPwa: Boolean(installedWebApp),
    chromeAppId: installedWebApp?.appId ?? null,
    chromeProfileDirectory: installedWebApp?.profileDirectory ?? null,
    appUserModelId,
    officialPwaAppUserModelId,
    pinnedPwaShortcutPath,
    pinnedPwaShortcutBackupPath: pinnedPwaShortcutPath ? pinnedPwaShortcutBackupPath : null,
    pinnedShortcutMigration: pinnedPwaShortcutPath ? "planned" : "not-found",
    startMenuShortcutPath,
    taskbarIdentityMatched: true,
    usesOfficialPwaEntry,
    compileCachePrepared: false,
    serviceLaunchMode: directService ? "direct" : "login-shell",
    wslDistro: config.wslDistro,
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
    residentMonitor: false,
    restartPersistence: "shortcut-on-disk",
    replacedExisting,
  };
  if (config.dryRun) return { ...result, dryRun: true };

  await assertReplaceableWslInstall(supportDirectory, existingInstallPaths, config.force);
  await assertSupervisorNotRunning(lockPath);
  if (config.icon && !(await pathExists(config.icon))) throw new Error(`图标文件不存在：${config.icon}`);

  await ensureDirectory(supportRoot);
  await ensureDirectory(hostSupportRootWsl);
  await ensureDirectory(hostStateDirectoryWsl);
  await ensureDirectory(path.dirname(shortcutPathWsl));
  if (pinnedPwaShortcutPathWsl && !(await pathExists(pinnedPwaShortcutBackupPathWsl))) {
    await copyFile(pinnedPwaShortcutPathWsl, pinnedPwaShortcutBackupPathWsl);
  }
  if (directService?.warmupArguments) {
    await ensureDirectory(directService.nodeCompileCachePath);
    result.compileCachePrepared = warmDirectServiceCompileCache(directService, config);
  }
  const stagingDirectory = await mkdtemp(path.join(supportRoot, ".oh-my-deepseek-"));
  const hostStagingDirectory = await mkdtemp(path.join(hostSupportRootWsl, ".oh-my-deepseek-"));
  const installedIconPath = chrome.icon
    ? path.win32.join(hostSupportDirectory, "app.ico")
    : chrome.executable;
  try {
    const hostBrowserScriptPath = path.win32.join(hostSupportDirectory, "browser-host.ps1");
    const hostBrowserConfigPath = path.win32.join(hostSupportDirectory, "browser-config.json");
    const hostBrowserErrorPath = path.win32.join(hostSupportDirectory, "browser-error.txt");
    const hostBrowserErrorPathWsl = path.join(hostSupportDirectoryWsl, "browser-error.txt");
    const storedConfig = {
      generatedBy: GENERATED_BY,
      configVersion: CONFIG_VERSION,
      platform: "wsl",
      launchMode: "windows-host-browser",
      name: config.name,
      url: config.url,
      serviceCommand: config.serviceCommand,
      serviceShell: config.serviceShell,
      directService,
      workingDirectory: config.workingDirectory,
      readyHost: config.readyHost,
      readyPort: config.readyPort,
      timeoutSeconds: config.timeoutSeconds,
      chromePath: chrome.executable,
      powerShellPath: powerShellPathWsl,
      nodePath: config.nodePath,
      chromeProfilePath: chromeProfilePathWsl,
      hostBrowserScriptPath,
      hostBrowserConfigPath,
      hostBrowserErrorPath: hostBrowserErrorPathWsl,
      lockPath,
      logPath,
    };
    const browserConfig = {
      generatedBy: GENERATED_BY,
      configVersion: CONFIG_VERSION,
      name: config.name,
      url: config.url,
      readyHost: config.readyHost,
      readyPort: config.readyPort,
      timeoutSeconds: config.timeoutSeconds,
      chromePath: chrome.executable,
      chromeProfilePath,
      launchMode: installedWebApp ? "installed-pwa" : "url-app",
      pwaLauncherPath: installedWebApp?.launcherPath ?? null,
      pwaArguments: installedWebApp?.arguments ?? [],
      appUserModelId,
      sourceAppUserModelId: officialPwaAppUserModelId,
      taskbarIconResource: `${installedIconPath},0`,
      windowBoundsPath: path.win32.join(hostStateDirectory, "window-size.json"),
      windowHandlePath: path.win32.join(hostSupportDirectory, "app-window.txt"),
      browserPidPath: path.win32.join(hostSupportDirectory, "browser.pid"),
      lastErrorPath: hostBrowserErrorPath,
    };
    const launchConfig = {
      generatedBy: GENERATED_BY,
      configVersion: CONFIG_VERSION,
      distro: config.wslDistro,
      user: config.wslUser,
      wslPath: windowsEnvironment.wsl,
      nodePath: config.nodePath,
      supervisorPath: path.join(supportDirectory, "supervisor.mjs"),
    };

    await writeText(path.join(stagingDirectory, "config.json"), `${JSON.stringify(storedConfig, null, 2)}\n`);
    await writeText(path.join(stagingDirectory, "supervisor.mjs"), renderSupervisor());
    const wslArguments = ["--distribution", config.wslDistro];
    if (config.wslUser) wslArguments.push("--user", config.wslUser);
    wslArguments.push("--exec", config.nodePath, path.join(supportDirectory, "supervisor.mjs"));
    const nativeLauncherSourceWsl = path.join(hostStagingDirectory, "launcher.cs");
    const nativeLauncherExecutableWsl = path.join(hostStagingDirectory, "launcher.exe");
    await writeText(nativeLauncherSourceWsl, renderWindowsNativeLauncherSource({
      programPath: windowsEnvironment.wsl,
      programArguments: wslArguments,
      appUserModelId,
      missingTitle: "找不到 WSL",
      missingMessage: `找不到 Windows WSL 启动器：${windowsEnvironment.wsl}`,
    }));
    await writeText(path.join(hostStagingDirectory, "browser-host.ps1"), withUtf8Bom(renderWindowsHostBrowser()));
    await writeText(path.join(hostStagingDirectory, "create-shortcut.ps1"), withUtf8Bom(renderWindowsShortcutScript({ nativeLauncher: true })));
    await writeText(path.join(hostStagingDirectory, "wsl-launch.json"), `${JSON.stringify(launchConfig, null, 2)}\n`);
    await writeText(path.join(hostStagingDirectory, "browser-config.json"), `${JSON.stringify(browserConfig, null, 2)}\n`);
    if (chrome.icon) {
      await copyFile(chrome.icon, path.join(hostStagingDirectory, "app.ico"));
    }
    interop.compileNativeLauncher({
      sourcePath: interop.toWindowsPath(nativeLauncherSourceWsl),
      outputPath: interop.toWindowsPath(nativeLauncherExecutableWsl),
      sourcePathWsl: nativeLauncherSourceWsl,
      outputPathWsl: nativeLauncherExecutableWsl,
    });
    if (!(await pathExists(nativeLauncherExecutableWsl))) throw new Error("Windows 原生启动器编译完成但 launcher.exe 不存在");
    await stopLegacyWslPrewarm(legacyPrewarmLockPath, legacyPrewarmScriptPath);
    if (await pathExists(legacyPrewarmReadyPath)) await removeExactTarget(legacyPrewarmReadyPath);
    interop.stopPwaMonitor?.({ monitorPath: path.win32.join(hostSupportDirectory, "pwa-monitor.exe") });
    for (const existingShortcut of [
      shortcutPathWsl,
      startMenuShortcutPathWsl,
      monitorStartupShortcutPathWsl,
      legacyStartupShortcutPathWsl,
    ]) {
      if (existingShortcut && await pathExists(existingShortcut)) await removeExactTarget(existingShortcut);
    }
    if (await pathExists(supportDirectory)) await removeExactTarget(supportDirectory);
    await rename(stagingDirectory, supportDirectory);
    if (await pathExists(hostSupportDirectoryWsl)) await removeExactTarget(hostSupportDirectoryWsl);
    await rename(hostStagingDirectory, hostSupportDirectoryWsl);
  } finally {
    if (await pathExists(stagingDirectory)) await removeExactTarget(stagingDirectory);
    if (await pathExists(hostStagingDirectory)) await removeExactTarget(hostStagingDirectory);
  }

  const launcherPath = path.win32.join(hostSupportDirectory, "launcher.exe");
  const shortcutOptions = {
    launcherPath,
    supportDirectory: hostSupportDirectory,
    iconPath: installedIconPath,
    description: `${config.name} — 在 WSL 启动服务，再以 Windows Chrome App 模式打开`,
    appUserModelId,
    scriptPath: path.win32.join(hostSupportDirectory, "create-shortcut.ps1"),
  };
  interop.createShortcut({ ...shortcutOptions, shortcutPath });
  interop.createShortcut({ ...shortcutOptions, shortcutPath: startMenuShortcutPath });
  if (pinnedPwaShortcutPath) {
    interop.createShortcut({
      ...shortcutOptions,
      shortcutPath: pinnedPwaShortcutPath,
      description: `${config.name} — 任务栏直接启动 WSL 服务与 Chrome App`,
    });
    interop.refreshTaskbarShortcut?.({ shortcutPath: pinnedPwaShortcutPath });
    const migratedPinnedShortcut = interop.inspectShortcut?.({ shortcutPath: pinnedPwaShortcutPath });
    if (!migratedPinnedShortcut
        || !windowsPathsEqual(migratedPinnedShortcut.targetPath, launcherPath)
        || String(migratedPinnedShortcut.appUserModelId).toLowerCase() !== appUserModelId.toLowerCase()) {
      throw new Error(`旧任务栏固定入口迁移验证失败：${pinnedPwaShortcutPath}`);
    }
    result.pinnedShortcutMigration = "migrated";
  }

  const persistence = await inspectWslRestartPersistence(config, interop);
  if (!persistence.ok) throw new Error(`Windows/WSL 重启启动链验证失败：${persistence.detail}`);
  return result;
}

export async function inspectWslRestartPersistence(config, interop = defaultInterop) {
  let windowsEnvironment;
  try {
    windowsEnvironment = interop.getWindowsEnvironment();
  } catch (error) {
    return { name: "重启后桌面启动", ok: false, detail: `无法读取 Windows 登录目录：${error.message}` };
  }
  const appKey = `${config.slug}-${config.instanceId.slice(0, 8)}`;
  const supportDirectory = path.join(config.homeDirectory, ".local", "share", "oh-my-deepseek", "apps", appKey);
  const hostSupportDirectory = path.win32.join(windowsEnvironment.localAppData, "Oh My DeepSeek", "wsl-apps", appKey);
  const hostSupportDirectoryWsl = interop.toWslPath(hostSupportDirectory);
  const shortcutDirectory = config.output ? interop.toWindowsPath(config.output) : windowsEnvironment.desktop;
  const shortcutPath = path.win32.join(shortcutDirectory, `${config.name}.lnk`);
  const shortcutPathWsl = interop.toWslPath(shortcutPath);
  const startMenuShortcutPath = path.win32.join(windowsEnvironment.programs, "Oh My DeepSeek", `${config.name}.lnk`);
  const startMenuShortcutPathWsl = interop.toWslPath(startMenuShortcutPath);
  const requiredPaths = [
    path.join(supportDirectory, "config.json"),
    path.join(supportDirectory, "supervisor.mjs"),
    path.join(hostSupportDirectoryWsl, "launcher.exe"),
    path.join(hostSupportDirectoryWsl, "browser-host.ps1"),
    path.join(hostSupportDirectoryWsl, "browser-config.json"),
    shortcutPathWsl,
    startMenuShortcutPathWsl,
  ];
  const existence = await Promise.all(requiredPaths.map(pathExists));
  if (!existence.some(Boolean)) {
    return { name: "重启后桌面启动", ok: true, detail: "尚未创建此入口；create 后会把 Windows/WSL 冷启动链完整落盘" };
  }
  if (!existence.every(Boolean)) {
    const missing = requiredPaths.filter((_, index) => !existence[index]);
    return { name: "重启后桌面启动", ok: false, detail: `Windows/WSL 启动产物不完整：缺少 ${missing.join("、")}` };
  }

  let storedConfig;
  let browserConfig;
  let launchConfig;
  try {
    [storedConfig, browserConfig, launchConfig] = await Promise.all([
      readFile(path.join(supportDirectory, "config.json"), "utf8").then(JSON.parse),
      readFile(path.join(hostSupportDirectoryWsl, "browser-config.json"), "utf8").then(JSON.parse),
      readFile(path.join(hostSupportDirectoryWsl, "wsl-launch.json"), "utf8").then(JSON.parse),
    ]);
  } catch (error) {
    return { name: "重启后桌面启动", ok: false, detail: `无法读取 Windows/WSL 启动配置：${error.message}` };
  }
  if (!(await pathExists(storedConfig.nodePath))) {
    return { name: "重启后桌面启动", ok: false, detail: `WSL 启动器保存的 Node.js 已不存在：${storedConfig.nodePath}` };
  }
  const wslExecutablePath = interop.toWslPath(launchConfig.wslPath);
  if (!(await pathExists(wslExecutablePath))) {
    return { name: "重启后桌面启动", ok: false, detail: `Windows WSL 启动器已不存在：${launchConfig.wslPath}` };
  }

  if (interop.inspectShortcut) {
    const expectedLauncher = path.win32.join(hostSupportDirectory, "launcher.exe");
    for (const candidate of [shortcutPath, startMenuShortcutPath]) {
      const inspected = interop.inspectShortcut({ shortcutPath: candidate });
      if (!inspected || !windowsPathsEqual(inspected.targetPath, expectedLauncher)) {
        return { name: "重启后桌面启动", ok: false, detail: `Windows 快捷方式目标无效：${candidate}` };
      }
    }
  }

  return {
    name: "重启后桌面启动",
    ok: true,
    detail: `桌面/开始菜单入口可按需冷启动 WSL，未安装登录常驻监视器：${shortcutPath}`,
  };
}

const defaultInterop = {
  getWindowsEnvironment() {
    const script = String.raw`
$Value = @{
  localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  desktop = [Environment]::GetFolderPath('Desktop')
  startup = [Environment]::GetFolderPath('Startup')
  appData = [Environment]::GetFolderPath('ApplicationData')
  programs = [Environment]::GetFolderPath('Programs')
  powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write(($Value | ConvertTo-Json -Compress))
`;
    const result = runPowerShell(script);
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`无法读取 Windows 用户目录：${formatCommandError(result)}`);
    }
    try {
      const value = JSON.parse(result.stdout.trim());
      if (!value.localAppData || !value.desktop || !value.startup || !value.programs || !value.powerShell || !value.wsl) {
        throw new Error("目录、PowerShell 或 WSL 路径为空");
      }
      return value;
    } catch (error) {
      throw new Error(`无法解析 Windows 用户目录：${error.message}`);
    }
  },
  toWslPath(value) {
    return translatePath(["-u", value], "Windows 路径");
  },
  toWindowsPath(value) {
    return translatePath(["-w", value], "WSL 路径");
  },
  createShortcut(options) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", options.scriptPath,
        "-ShortcutPath", options.shortcutPath,
        "-LauncherPath", options.launcherPath,
        "-WorkingDirectory", options.supportDirectory,
        "-IconPath", options.iconPath,
        "-Description", options.description,
        "-AppUserModelId", options.appUserModelId || "",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`无法创建 Windows 启动快捷方式：${formatCommandError(result)}`);
    }
  },
  inspectShortcut({ shortcutPath }) {
    const script = `$ShortcutPath = ${powershellSingleQuote(shortcutPath)}; $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($ShortcutPath); $Folder = (New-Object -ComObject Shell.Application).Namespace([System.IO.Path]::GetDirectoryName($ShortcutPath)); $Item = if ($Folder) { $Folder.ParseName([System.IO.Path]::GetFileName($ShortcutPath)) } else { $null }; $AppUserModelId = if ($Item) { [string]$Item.ExtendedProperty('System.AppUserModel.ID') } else { '' }; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write((@{ targetPath = [string]$Shortcut.TargetPath; arguments = [string]$Shortcut.Arguments; appUserModelId = $AppUserModelId } | ConvertTo-Json -Compress))`;
    const result = runPowerShell(script);
    if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
    try {
      const value = JSON.parse(result.stdout.trim());
      return value.targetPath ? value : null;
    } catch {
      return null;
    }
  },
  compileNativeLauncher({ sourcePath, outputPath }) {
    const script = `Add-Type -Path ${powershellSingleQuote(sourcePath)} -OutputAssembly ${powershellSingleQuote(outputPath)} -OutputType WindowsApplication`;
    const result = runPowerShell(script);
    if (result.error || result.status !== 0) {
      throw new Error(`无法编译 Windows 原生启动器：${formatCommandError(result)}`);
    }
  },
  findPwaShortcutIdentity(options) {
    return findPwaShortcutIdentity(options);
  },
  stopPwaMonitor({ monitorPath }) {
    const script = `$Expected = ${powershellSingleQuote(monitorPath)}; Get-CimInstance Win32_Process -Filter "Name = 'pwa-monitor.exe'" -ErrorAction SilentlyContinue | Where-Object { [string]::Equals([string]$_.ExecutablePath, $Expected, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    runPowerShell(script);
  },
  refreshTaskbarShortcut({ shortcutPath }) {
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OhMyDeepSeekShellRefresh {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
  public static void Notify(string path) { SHChangeNotify(0x00002000, 0x0005, path, IntPtr.Zero); }
}
'@
[OhMyDeepSeekShellRefresh]::Notify(${powershellSingleQuote(shortcutPath)})
`;
    runPowerShell(script);
  },
  resolveDirectService(config) {
    return resolveDirectPosixService(config);
  },
};

function runPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true },
  );
}

function translatePath(args, label) {
  const result = spawnSync("wslpath", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`无法转换${label}：${formatCommandError(result)}`);
  }
  return result.stdout.trim();
}

function formatCommandError(result) {
  return (result.stderr || result.stdout || result.error?.message || "未知错误").trim();
}

function withUtf8Bom(contents) {
  return `\uFEFF${contents}`;
}

function windowsPathsEqual(left, right) {
  return String(left).replaceAll("/", "\\").toLowerCase() === String(right).replaceAll("/", "\\").toLowerCase();
}

export function findPwaShortcutIdentity({ installedWebApp, windowsEnvironment }) {
  const pinnedTaskbar = windowsEnvironment.appData
    ? path.win32.join(windowsEnvironment.appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar")
    : null;
  const roots = [windowsEnvironment.desktop, windowsEnvironment.programs, pinnedTaskbar]
    .filter(Boolean)
    .map(powershellSingleQuote)
    .join(", ");
  if (!roots) return null;
  const script = `
$Roots = @(${roots})
$PinnedRoot = ${powershellSingleQuote(pinnedTaskbar ?? "")}
$ExpectedTarget = ${powershellSingleQuote(installedWebApp.launcherPath)}
$AppArgument = ${powershellSingleQuote(`--app-id=${installedWebApp.appId}`)}
$ProfileArgument = ${powershellSingleQuote(`--profile-directory=${installedWebApp.profileDirectory}`)}
$WshShell = New-Object -ComObject WScript.Shell
$ShellApplication = New-Object -ComObject Shell.Application
$Files = @($Roots | ForEach-Object {
  if (Test-Path -LiteralPath $_ -PathType Container) {
    Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
  }
} | Sort-Object FullName -Unique)
$Identity = $null
$PinnedShortcutPath = $null
foreach ($File in $Files) {
  try {
    $Shortcut = $WshShell.CreateShortcut($File.FullName)
    if (-not [string]::Equals([string]$Shortcut.TargetPath, $ExpectedTarget, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $Arguments = [string]$Shortcut.Arguments
    if (-not $Arguments.Contains($AppArgument) -or -not $Arguments.Contains($ProfileArgument)) { continue }
    $Folder = $ShellApplication.Namespace($File.DirectoryName)
    $Item = if ($Folder) { $Folder.ParseName($File.Name) } else { $null }
    $AppUserModelId = if ($Item) { [string]$Item.ExtendedProperty('System.AppUserModel.ID') } else { '' }
    if ([string]::IsNullOrWhiteSpace($AppUserModelId)) { continue }
    if (-not $Identity) { $Identity = @{ shortcutPath = $File.FullName; appUserModelId = $AppUserModelId } }
    if (-not [string]::IsNullOrWhiteSpace($PinnedRoot) -and
        $File.FullName.StartsWith(($PinnedRoot.TrimEnd('\\') + '\\'), [StringComparison]::OrdinalIgnoreCase)) {
      $PinnedShortcutPath = $File.FullName
    }
  } catch {}
}
if (-not $Identity) { exit 3 }
$Identity['pinnedShortcutPath'] = $PinnedShortcutPath
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write(($Identity | ConvertTo-Json -Compress))
`;
  const result = runPowerShell(script);
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const value = JSON.parse(result.stdout.trim());
    if (!value.shortcutPath || !value.appUserModelId || value.appUserModelId.length >= 128 || /\s/.test(value.appUserModelId)) return null;
    if (value.pinnedShortcutPath) {
      const expectedPinnedRoot = `${String(pinnedTaskbar).replace(/[\\/]+$/, "")}\\`;
      if (!String(value.pinnedShortcutPath).replaceAll("/", "\\").toLowerCase().startsWith(expectedPinnedRoot.toLowerCase())) {
        return null;
      }
    }
    return value;
  } catch {
    return null;
  }
}

async function assertReplaceableWslInstall(supportDirectory, installPaths, force) {
  const installExists = (await Promise.all(installPaths.map(pathExists))).some(Boolean);
  if (!installExists) return;
  let owned = false;
  try {
    const config = JSON.parse(await readFile(path.join(supportDirectory, "config.json"), "utf8"));
    owned = config.generatedBy === GENERATED_BY;
  } catch {}
  if (!owned && !force) {
    throw new Error("目标已存在且无法确认由本工具生成。确认可覆盖后请加 --force");
  }
}

async function assertSupervisorNotRunning(lockPath) {
  if (!(await pathExists(lockPath))) return;
  try {
    const { pid } = JSON.parse(await readFile(lockPath, "utf8"));
    process.kill(Number(pid), 0);
    throw new Error("当前 App 仍在运行，请先关闭 Chrome App 再重新生成");
  } catch (error) {
    if (error?.message?.includes("当前 App")) throw error;
  }
}

async function stopLegacyWslPrewarm(lockPath, scriptPath) {
  if (!(await pathExists(lockPath))) return;
  let pid;
  try {
    pid = Number(JSON.parse(await readFile(lockPath, "utf8")).pid);
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (!Number.isInteger(pid) || pid <= 0 || !commandLine.split("\0").includes(scriptPath)) throw new Error("stale lock");
  } catch {
    await removeExactTarget(lockPath);
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("旧的 WSL 预热进程未能停止；请先运行 wsl --shutdown 后重试");
}

export const resolveDirectWslService = resolveDirectPosixService;

export async function findInstalledWindowsWebApp({ config, chrome, windowsEnvironment, interop }) {
  const userDataDirectory = path.win32.join(windowsEnvironment.localAppData, "Google", "Chrome", "User Data");
  const userDataDirectoryWsl = interop.toWslPath(userDataDirectory);
  let entries;
  try {
    entries = await readdir(userDataDirectoryWsl, { withFileTypes: true });
  } catch {
    return null;
  }
  const profileDirectories = entries
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
    .map((entry) => entry.name)
    .sort((left, right) => left === "Default" ? -1 : right === "Default" ? 1 : left.localeCompare(right));
  const preferredAppId = config.chromeAppId;
  if (preferredAppId && !/^[a-p]{32}$/.test(preferredAppId)) {
    throw new Error("--chrome-app-id 必须是 32 位 a-p 字符串");
  }

  for (const profileDirectory of profileDirectories) {
    const profileRoot = path.join(userDataDirectoryWsl, profileDirectory);
    const manifestRoot = path.join(profileRoot, "Web Applications", "Manifest Resources");
    let appIds;
    try {
      appIds = (await readdir(manifestRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-p]{32}$/.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    if (preferredAppId) {
      if (appIds.includes(preferredAppId)) return buildInstalledWindowsWebApp(chrome, interop, preferredAppId, profileDirectory);
      continue;
    }
    const databaseDirectory = path.join(profileRoot, "Sync Data", "LevelDB");
    let databaseFiles;
    try {
      databaseFiles = (await readdir(databaseDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(databaseDirectory, entry.name));
    } catch {
      continue;
    }
    const urlBytes = Buffer.from(config.url);
    for (const databaseFile of databaseFiles) {
      let data;
      try { data = await readFile(databaseFile); } catch { continue; }
      for (const appId of appIds) {
        const appIdBytes = Buffer.from(appId);
        let offset = data.indexOf(appIdBytes);
        while (offset !== -1) {
          const nearby = data.subarray(Math.max(0, offset - 4096), Math.min(data.length, offset + appIdBytes.length + 4096));
          if (nearby.indexOf(urlBytes) !== -1) return buildInstalledWindowsWebApp(chrome, interop, appId, profileDirectory);
          offset = data.indexOf(appIdBytes, offset + appIdBytes.length);
        }
      }
    }
  }
  return null;
}

function buildInstalledWindowsWebApp(chrome, interop, appId, profileDirectory) {
  const proxyPath = path.win32.join(path.win32.dirname(chrome.executable), "chrome_proxy.exe");
  const proxyPathWsl = interop.toWslPath(proxyPath);
  const launcherPath = existsSync(proxyPathWsl) ? proxyPath : chrome.executable;
  return {
    appId,
    profileDirectory,
    launcherPath,
    arguments: [`--profile-directory=${profileDirectory}`, `--app-id=${appId}`],
  };
}

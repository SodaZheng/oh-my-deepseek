import { copyFile, mkdtemp, readFile, readdir, realpath, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { renderWindowsNativeLauncherSource, renderWindowsPwaMonitorSource, renderWindowsShortcutScript } from "../templates/windows.mjs";
import { renderWindowsHostBrowser } from "../templates/wsl.mjs";
import { ensureDirectory, isExecutable, pathExists, powershellSingleQuote, removeExactTarget, shellQuote, writeText } from "../utils.mjs";

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
  const hostSupportRootWsl = interop.toWslPath(hostSupportRoot);
  const hostSupportDirectoryWsl = interop.toWslPath(hostSupportDirectory);
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
  const appUserModelId = officialPwaIdentity?.appUserModelId ?? `OpenAI.OhMyDeepSeek.${config.instanceId}`;
  const usesOfficialPwaEntry = Boolean(officialPwaIdentity);
  const chromeProfilePath = path.win32.join(windowsEnvironment.localAppData, "Oh My DeepSeek", "profiles", appKey);
  const chromeProfilePathWsl = interop.toWslPath(chromeProfilePath);
  const shortcutDirectory = config.output ? interop.toWindowsPath(config.output) : windowsEnvironment.desktop;
  const shortcutPath = path.win32.join(shortcutDirectory, `${config.name}.lnk`);
  const shortcutPathWsl = interop.toWslPath(shortcutPath);
  const monitorStartupShortcutPath = path.win32.join(windowsEnvironment.startup, `${config.name} Monitor.lnk`);
  const monitorStartupShortcutPathWsl = interop.toWslPath(monitorStartupShortcutPath);
  const lockPath = path.join(stateDirectory, "supervisor.lock");
  const legacyPrewarmLockPath = path.join(stateDirectory, "prewarm.lock");
  const legacyPrewarmReadyPath = path.join(stateDirectory, "prewarm-ready.json");
  const legacyPrewarmScriptPath = path.join(supportDirectory, "wsl-prewarm.mjs");
  const legacyStartupShortcutPathWsl = windowsEnvironment.startup
    ? interop.toWslPath(path.win32.join(windowsEnvironment.startup, `${config.name} (WSL Warm Start).lnk`))
    : null;

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
    taskbarIdentityMatched: true,
    usesOfficialPwaEntry,
    compileCachePrepared: false,
    serviceLaunchMode: directService ? "direct" : "login-shell",
    wslDistro: config.wslDistro,
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
  };
  if (config.dryRun) return { ...result, dryRun: true };

  await assertReplaceableWslInstall(supportDirectory, shortcutPathWsl, config.force);
  await assertSupervisorNotRunning(lockPath);
  if (config.icon && !(await pathExists(config.icon))) throw new Error(`图标文件不存在：${config.icon}`);

  await ensureDirectory(supportRoot);
  await ensureDirectory(hostSupportRootWsl);
  await ensureDirectory(path.dirname(shortcutPathWsl));
  if (directService?.warmupArguments) {
    await ensureDirectory(directService.nodeCompileCachePath);
    result.compileCachePrepared = warmDirectServiceCompileCache(directService, config);
  }
  const stagingDirectory = await mkdtemp(path.join(supportRoot, ".oh-my-deepseek-"));
  const hostStagingDirectory = await mkdtemp(path.join(hostSupportRootWsl, ".oh-my-deepseek-"));
  let installedIconPath = chrome.executable;
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
      preservePwaIdentity: usesOfficialPwaEntry,
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
      installedIconPath = path.win32.join(hostSupportDirectory, "app.ico");
    }
    interop.compileNativeLauncher({
      sourcePath: interop.toWindowsPath(nativeLauncherSourceWsl),
      outputPath: interop.toWindowsPath(nativeLauncherExecutableWsl),
      sourcePathWsl: nativeLauncherSourceWsl,
      outputPathWsl: nativeLauncherExecutableWsl,
    });
    if (!(await pathExists(nativeLauncherExecutableWsl))) throw new Error("Windows 原生启动器编译完成但 launcher.exe 不存在");
    if (usesOfficialPwaEntry) {
      const monitorSourceWsl = path.join(hostStagingDirectory, "pwa-monitor.cs");
      const monitorExecutableWsl = path.join(hostStagingDirectory, "pwa-monitor.exe");
      await writeText(monitorSourceWsl, renderWindowsPwaMonitorSource({
        appUserModelId,
        launcherPath: path.win32.join(hostSupportDirectory, "launcher.exe"),
        windowHandlePath: path.win32.join(hostSupportDirectory, "app-window.txt"),
        monitorId: config.instanceId,
      }));
      interop.compileNativeLauncher({
        sourcePath: interop.toWindowsPath(monitorSourceWsl),
        outputPath: interop.toWindowsPath(monitorExecutableWsl),
        sourcePathWsl: monitorSourceWsl,
        outputPathWsl: monitorExecutableWsl,
      });
      if (!(await pathExists(monitorExecutableWsl))) throw new Error("Windows PWA 监视器编译完成但 pwa-monitor.exe 不存在");
    }

    await stopLegacyWslPrewarm(legacyPrewarmLockPath, legacyPrewarmScriptPath);
    if (await pathExists(legacyPrewarmReadyPath)) await removeExactTarget(legacyPrewarmReadyPath);
    if (await pathExists(supportDirectory)) await removeExactTarget(supportDirectory);
    await rename(stagingDirectory, supportDirectory);
    interop.stopPwaMonitor?.({ monitorPath: path.win32.join(hostSupportDirectory, "pwa-monitor.exe") });
    if (await pathExists(hostSupportDirectoryWsl)) await removeExactTarget(hostSupportDirectoryWsl);
    await rename(hostStagingDirectory, hostSupportDirectoryWsl);
  } finally {
    if (await pathExists(stagingDirectory)) await removeExactTarget(stagingDirectory);
    if (await pathExists(hostStagingDirectory)) await removeExactTarget(hostStagingDirectory);
  }

  if (usesOfficialPwaEntry) {
    interop.copyShortcut({ sourcePath: officialPwaIdentity.shortcutPath, shortcutPath });
    interop.createStartupMonitor({
      monitorPath: path.win32.join(hostSupportDirectory, "pwa-monitor.exe"),
      shortcutPath: monitorStartupShortcutPath,
      scriptPath: path.win32.join(hostSupportDirectory, "create-shortcut.ps1"),
      supportDirectory: hostSupportDirectory,
      iconPath: installedIconPath,
    });
  } else {
    if (await pathExists(monitorStartupShortcutPathWsl)) await removeExactTarget(monitorStartupShortcutPathWsl);
    interop.createShortcut({
      shortcutPath,
      launcherPath: path.win32.join(hostSupportDirectory, "launcher.exe"),
      supportDirectory: hostSupportDirectory,
      iconPath: installedIconPath,
      description: `${config.name} — 在 WSL 启动服务，再以 Windows Chrome App 模式打开`,
      appUserModelId,
      scriptPath: path.win32.join(hostSupportDirectory, "create-shortcut.ps1"),
    });
  }
  if (legacyStartupShortcutPathWsl && await pathExists(legacyStartupShortcutPathWsl)) {
    await removeExactTarget(legacyStartupShortcutPathWsl);
  }
  return result;
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
      if (!value.localAppData || !value.desktop || !value.powerShell || !value.wsl) throw new Error("目录、PowerShell 或 WSL 路径为空");
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
      throw new Error(`无法创建 Windows 桌面快捷方式：${formatCommandError(result)}`);
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
  copyShortcut({ sourcePath, shortcutPath }) {
    if (path.win32.resolve(sourcePath).toLowerCase() === path.win32.resolve(shortcutPath).toLowerCase()) return;
    const result = runPowerShell(`Copy-Item -LiteralPath ${powershellSingleQuote(sourcePath)} -Destination ${powershellSingleQuote(shortcutPath)} -Force`);
    if (result.error || result.status !== 0) throw new Error(`无法复制 Chrome PWA 快捷方式：${formatCommandError(result)}`);
  },
  createStartupMonitor({ monitorPath, shortcutPath, scriptPath, supportDirectory, iconPath }) {
    this.createShortcut({
      shortcutPath,
      launcherPath: monitorPath,
      supportDirectory,
      iconPath,
      description: "Oh My DeepSeek PWA launch monitor",
      appUserModelId: "",
      scriptPath,
    });
    const started = runPowerShell(`Start-Process -FilePath ${powershellSingleQuote(monitorPath)} -WindowStyle Hidden`);
    if (started.error || started.status !== 0) throw new Error(`无法启动 Windows PWA 监视器：${formatCommandError(started)}`);
  },
  stopPwaMonitor({ monitorPath }) {
    const script = `$Expected = ${powershellSingleQuote(monitorPath)}; Get-CimInstance Win32_Process -Filter "Name = 'pwa-monitor.exe'" -ErrorAction SilentlyContinue | Where-Object { [string]::Equals([string]$_.ExecutablePath, $Expected, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    runPowerShell(script);
  },
  resolveDirectService(config) {
    return resolveDirectWslService(config);
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
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::Write((@{ shortcutPath = $File.FullName; appUserModelId = $AppUserModelId } | ConvertTo-Json -Compress))
    exit 0
  } catch {}
}
exit 3
`;
  const result = runPowerShell(script);
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const value = JSON.parse(result.stdout.trim());
    if (!value.shortcutPath || !value.appUserModelId || value.appUserModelId.length >= 128 || /\s/.test(value.appUserModelId)) return null;
    return value;
  } catch {
    return null;
  }
}

async function assertReplaceableWslInstall(supportDirectory, shortcutPath, force) {
  const supportExists = await pathExists(supportDirectory);
  const shortcutExists = await pathExists(shortcutPath);
  if (!supportExists && !shortcutExists) return;
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

export async function resolveDirectWslService(config) {
  const words = parseSimpleServiceCommand(config.serviceCommand);
  if (!words) return null;
  const [command, ...arguments_] = words;
  const result = spawnSync(
    config.serviceShell,
    ["-lic", `command -v ${shellQuote(command)}`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return null;
  const discoveredExecutable = result.stdout.trim();
  if (!path.isAbsolute(discoveredExecutable) || discoveredExecutable.includes("\n")) return null;
  let executable;
  try {
    executable = await realpath(discoveredExecutable);
  } catch {
    return null;
  }
  if (!(await isExecutable(executable))) return null;
  return {
    executable,
    arguments: arguments_,
    path: config.servicePath,
    warmupArguments: path.basename(command).toLowerCase() === "dsh" && arguments_[0] === "web"
      ? ["web", "--help"]
      : null,
  };
}

export function warmDirectServiceCompileCache(directService, config) {
  const result = spawnSync(directService.executable, directService.warmupArguments, {
    cwd: config.workingDirectory,
    env: {
      ...process.env,
      ...(directService.path ? { PATH: directService.path } : {}),
      NODE_COMPILE_CACHE: directService.nodeCompileCachePath,
    },
    stdio: "ignore",
    timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

export function parseSimpleServiceCommand(command) {
  const words = [];
  let current = "";
  let state = "unquoted";
  let started = false;
  const finishWord = () => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (state === "single") {
      if (character === "'") state = "unquoted";
      else current += character;
      continue;
    }
    if (state === "double") {
      if (character === '"') {
        state = "unquoted";
      } else if (character === "\\") {
        index += 1;
        if (index >= command.length) return null;
        if (command[index] === '"' || command[index] === "\\") current += command[index];
        else current += `\\${command[index]}`;
      } else if (character === "$" || character === "`") {
        return null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\n" || character === "\r") {
      return null;
    } else if (/\s/.test(character)) {
      finishWord();
    } else if (character === "'") {
      state = "single";
      started = true;
    } else if (character === '"') {
      state = "double";
      started = true;
    } else if (character === "\\") {
      index += 1;
      if (index >= command.length) return null;
      current += command[index];
      started = true;
    } else if ("|&;<>()$`*?[]{}~#".includes(character)) {
      return null;
    } else {
      current += character;
      started = true;
    }
  }
  if (state !== "unquoted") return null;
  finishWord();
  if (words.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return null;
  return words;
}

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

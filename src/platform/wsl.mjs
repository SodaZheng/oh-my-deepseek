import { copyFile, mkdtemp, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { renderWindowsShortcutScript } from "../templates/windows.mjs";
import { renderWindowsHostBrowser, renderWslWindowsLauncher } from "../templates/wsl.mjs";
import { ensureDirectory, pathExists, removeExactTarget, writeText } from "../utils.mjs";

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
  const chromeProfilePath = path.win32.join(windowsEnvironment.localAppData, "Oh My DeepSeek", "profiles", appKey);
  const chromeProfilePathWsl = interop.toWslPath(chromeProfilePath);
  const shortcutDirectory = config.output ? interop.toWindowsPath(config.output) : windowsEnvironment.desktop;
  const shortcutPath = path.win32.join(shortcutDirectory, `${config.name}.lnk`);
  const shortcutPathWsl = interop.toWslPath(shortcutPath);
  const lockPath = path.join(stateDirectory, "supervisor.lock");

  const result = {
    platform: "wsl",
    shortcutPath,
    supportDirectory,
    hostSupportDirectory,
    chromePath: chrome.executable,
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
      workingDirectory: config.workingDirectory,
      readyHost: config.readyHost,
      readyPort: config.readyPort,
      timeoutSeconds: config.timeoutSeconds,
      chromePath: chrome.executable,
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
      browserPidPath: path.win32.join(hostSupportDirectory, "browser.pid"),
      lastErrorPath: hostBrowserErrorPath,
    };
    const launchConfig = {
      generatedBy: GENERATED_BY,
      configVersion: CONFIG_VERSION,
      distro: config.wslDistro,
      user: config.wslUser,
      nodePath: config.nodePath,
      supervisorPath: path.join(supportDirectory, "supervisor.mjs"),
    };

    await writeText(path.join(stagingDirectory, "config.json"), `${JSON.stringify(storedConfig, null, 2)}\n`);
    await writeText(path.join(stagingDirectory, "supervisor.mjs"), renderSupervisor());
    await writeText(path.join(hostStagingDirectory, "launcher.ps1"), withUtf8Bom(renderWslWindowsLauncher()));
    await writeText(path.join(hostStagingDirectory, "browser-host.ps1"), withUtf8Bom(renderWindowsHostBrowser()));
    await writeText(path.join(hostStagingDirectory, "create-shortcut.ps1"), withUtf8Bom(renderWindowsShortcutScript()));
    await writeText(path.join(hostStagingDirectory, "wsl-launch.json"), `${JSON.stringify(launchConfig, null, 2)}\n`);
    await writeText(path.join(hostStagingDirectory, "browser-config.json"), `${JSON.stringify(browserConfig, null, 2)}\n`);
    if (chrome.icon) {
      await copyFile(chrome.icon, path.join(hostStagingDirectory, "app.ico"));
      installedIconPath = path.win32.join(hostSupportDirectory, "app.ico");
    }

    if (await pathExists(supportDirectory)) await removeExactTarget(supportDirectory);
    await rename(stagingDirectory, supportDirectory);
    if (await pathExists(hostSupportDirectoryWsl)) await removeExactTarget(hostSupportDirectoryWsl);
    await rename(hostStagingDirectory, hostSupportDirectoryWsl);
  } finally {
    if (await pathExists(stagingDirectory)) await removeExactTarget(stagingDirectory);
    if (await pathExists(hostStagingDirectory)) await removeExactTarget(hostStagingDirectory);
  }

  interop.createShortcut({
    shortcutPath,
    launcherPath: path.win32.join(hostSupportDirectory, "launcher.ps1"),
    supportDirectory: hostSupportDirectory,
    iconPath: installedIconPath,
    description: `${config.name} — 在 WSL 启动服务，再以 Windows Chrome App 模式打开`,
    scriptPath: path.win32.join(hostSupportDirectory, "create-shortcut.ps1"),
  });
  return result;
}

const defaultInterop = {
  getWindowsEnvironment() {
    const script = String.raw`
$Value = @{
  localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  desktop = [Environment]::GetFolderPath('Desktop')
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
      if (!value.localAppData || !value.desktop) throw new Error("目录为空");
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
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`无法创建 Windows 桌面快捷方式：${formatCommandError(result)}`);
    }
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

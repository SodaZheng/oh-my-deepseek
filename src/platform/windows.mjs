import { copyFile, mkdtemp, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import {
  renderWindowsHiddenLauncher,
  renderWindowsShortcutScript,
} from "../templates/windows.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { renderWindowsWindowState } from "../templates/windows-window-state.mjs";
import { ensureDirectory, pathExists, removeExactTarget, writeText } from "../utils.mjs";

export async function createWindowsLauncher(config, chrome, env = process.env) {
  const localAppData = env.LOCALAPPDATA ?? path.join(config.homeDirectory || os.homedir(), "AppData", "Local");
  const supportRoot = path.join(localAppData, "Oh My DeepSeek", "apps");
  const supportDirectory = path.join(supportRoot, `${config.slug}-${config.instanceId.slice(0, 8)}`);
  const stateDirectory = path.join(localAppData, "Oh My DeepSeek", "state", `${config.slug}-${config.instanceId.slice(0, 8)}`);
  const profileDirectory = path.join(localAppData, "Oh My DeepSeek", "profiles", `${config.slug}-${config.instanceId.slice(0, 8)}`);
  const logPath = path.join(localAppData, "Oh My DeepSeek", "logs", `${config.slug}.log`);
  const shortcutDirectory = config.output ?? getWindowsDesktopDirectory(env);
  const shortcutPath = path.join(shortcutDirectory, `${config.name}.lnk`);
  const supportExists = await pathExists(supportDirectory);
  const shortcutExists = await pathExists(shortcutPath);
  const result = {
    platform: "win32",
    shortcutPath,
    supportDirectory,
    chromePath: chrome.executable,
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
    restartPersistence: "shortcut-on-disk",
    replacedExisting: supportExists || shortcutExists,
  };

  if (config.dryRun) return { ...result, dryRun: true };
  await assertReplaceableWindowsInstall(supportDirectory, shortcutPath, config.force);
  await assertSupervisorNotRunning(path.join(stateDirectory, "supervisor.lock"));
  if (config.icon && !(await pathExists(config.icon))) {
    throw new Error(`图标文件不存在：${config.icon}`);
  }

  await ensureDirectory(supportRoot);
  await ensureDirectory(shortcutDirectory);
  const stagingDirectory = await mkdtemp(path.join(supportRoot, ".oh-my-deepseek-"));
  let installedIconPath = chrome.icon ?? chrome.executable;
  try {
    const storedConfig = {
      generatedBy: GENERATED_BY,
      configVersion: CONFIG_VERSION,
      platform: "win32",
      name: config.name,
      url: config.url,
      serviceCommand: config.serviceCommand,
      workingDirectory: config.workingDirectory,
      readyHost: config.readyHost,
      readyPort: config.readyPort,
      timeoutSeconds: config.timeoutSeconds,
      chromePath: chrome.executable,
      nodePath: config.nodePath,
      chromeProfilePath: profileDirectory,
      windowBoundsPath: path.join(stateDirectory, "window-size.json"),
      windowStateReadyPath: path.join(stateDirectory, "window-state.ready"),
      windowStateScriptPath: path.join(supportDirectory, "window-state.ps1"),
      lockPath: path.join(stateDirectory, "supervisor.lock"),
      logPath,
    };
    await writeText(path.join(stagingDirectory, "config.json"), `${JSON.stringify(storedConfig, null, 2)}\n`);
    await writeText(
      path.join(stagingDirectory, "launcher.js"),
      renderWindowsHiddenLauncher({
        programPath: config.nodePath,
        programArguments: [path.join(supportDirectory, "supervisor.mjs")],
        missingTitle: "找不到 Node.js",
        missingMessage: `创建 ${config.name} 时使用的 Node.js 已被移动或删除：${config.nodePath}`,
      }),
    );
    await writeText(path.join(stagingDirectory, "supervisor.mjs"), renderSupervisor());
    await writeText(path.join(stagingDirectory, "window-state.ps1"), withUtf8Bom(renderWindowsWindowState()));
    await writeText(path.join(stagingDirectory, "create-shortcut.ps1"), withUtf8Bom(renderWindowsShortcutScript()));
    if (chrome.icon && path.extname(chrome.icon).toLowerCase() === ".ico") {
      await copyFile(chrome.icon, path.join(stagingDirectory, "app.ico"));
      installedIconPath = path.join(supportDirectory, "app.ico");
    }

    if (await pathExists(shortcutPath)) await removeExactTarget(shortcutPath);
    if (await pathExists(supportDirectory)) await removeExactTarget(supportDirectory);
    await rename(stagingDirectory, supportDirectory);
  } finally {
    if (await pathExists(stagingDirectory)) await removeExactTarget(stagingDirectory);
  }

  createWindowsShortcut({
    shortcutPath,
    launcherPath: path.join(supportDirectory, "launcher.js"),
    supportDirectory,
    iconPath: installedIconPath,
    description: `${config.name} — 先启动服务，再以 Chrome App 模式打开`,
    scriptPath: path.join(supportDirectory, "create-shortcut.ps1"),
  });

  const persistence = await inspectWindowsRestartPersistence(config, env);
  if (!persistence.ok) throw new Error(`Windows 重启启动链验证失败：${persistence.detail}`);

  return result;
}

export async function inspectWindowsRestartPersistence(config, env = process.env) {
  const localAppData = env.LOCALAPPDATA ?? path.join(config.homeDirectory || os.homedir(), "AppData", "Local");
  const appKey = `${config.slug}-${config.instanceId.slice(0, 8)}`;
  const supportDirectory = path.join(localAppData, "Oh My DeepSeek", "apps", appKey);
  const shortcutDirectory = config.output ?? getWindowsDesktopDirectory(env);
  const shortcutPath = path.join(shortcutDirectory, `${config.name}.lnk`);
  const launcherPath = path.join(supportDirectory, "launcher.js");
  const requiredPaths = [
    shortcutPath,
    launcherPath,
    path.join(supportDirectory, "supervisor.mjs"),
    path.join(supportDirectory, "config.json"),
  ];
  const existence = await Promise.all(requiredPaths.map(pathExists));
  if (!existence.some(Boolean)) {
    return { name: "重启后桌面启动", ok: true, detail: "尚未创建此入口；Windows 桌面快捷方式创建后不依赖登录前的进程" };
  }
  if (!existence.every(Boolean)) {
    const missing = requiredPaths.filter((_, index) => !existence[index]);
    return { name: "重启后桌面启动", ok: false, detail: `启动产物不完整：缺少 ${missing.join("、")}` };
  }

  let storedConfig;
  try {
    storedConfig = JSON.parse(await readFile(path.join(supportDirectory, "config.json"), "utf8"));
  } catch (error) {
    return { name: "重启后桌面启动", ok: false, detail: `无法读取启动配置：${error.message}` };
  }
  if (!(await pathExists(storedConfig.nodePath))) {
    return { name: "重启后桌面启动", ok: false, detail: `快捷方式保存的 Node.js 已不存在：${storedConfig.nodePath}` };
  }

  const escapedShortcut = shortcutPath.replaceAll("'", "''");
  const inspected = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$S=(New-Object -ComObject WScript.Shell).CreateShortcut('${escapedShortcut}'); [Console]::Write(($S.TargetPath + [Environment]::NewLine + $S.Arguments))`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const lines = String(inspected.stdout).split(/\r?\n/);
  const targetPath = lines[0]?.trim() ?? "";
  const argumentsValue = lines.slice(1).join("\n");
  const ok = !inspected.error
    && inspected.status === 0
    && path.basename(targetPath).toLowerCase() === "wscript.exe"
    && argumentsValue.toLowerCase().includes(launcherPath.toLowerCase());
  return {
    name: "重启后桌面启动",
    ok,
    detail: ok
      ? `快捷方式和全部本地启动依赖均已落盘：${shortcutPath}`
      : `桌面快捷方式目标无效：${targetPath || inspected.stderr || inspected.error?.message || "无法读取"}`,
  };
}

function withUtf8Bom(contents) {
  return `\uFEFF${contents}`;
}

function getWindowsDesktopDirectory(env) {
  const command = "[Environment]::GetFolderPath('Desktop')";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (!result.error && result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  if (env.USERPROFILE) return path.join(env.USERPROFILE, "Desktop");
  throw new Error("无法确定 Windows 桌面目录；请用 --output 指定快捷方式目录");
}

async function assertReplaceableWindowsInstall(supportDirectory, shortcutPath, force) {
  const supportExists = await pathExists(supportDirectory);
  const shortcutExists = await pathExists(shortcutPath);
  if (!supportExists && !shortcutExists) return;

  let owned = false;
  try {
    const config = JSON.parse(await readFile(path.join(supportDirectory, "config.json"), "utf8"));
    owned = config.generatedBy === GENERATED_BY;
  } catch {
    owned = false;
  }
  if (!owned && !force) {
    throw new Error(`目标已存在且无法确认由本工具生成：${shortcutPath}。确认可覆盖后请加 --force`);
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

function createWindowsShortcut({ shortcutPath, launcherPath, supportDirectory, iconPath, description, scriptPath }) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ShortcutPath",
      shortcutPath,
      "-LauncherPath",
      launcherPath,
      "-WorkingDirectory",
      supportDirectory,
      "-IconPath",
      iconPath,
      "-Description",
      description,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw new Error(`无法创建 Windows 快捷方式：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`无法创建 Windows 快捷方式：${(result.stderr || result.stdout).trim()}`);
  }
}

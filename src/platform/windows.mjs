import { copyFile, mkdtemp, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import {
  renderWindowsLauncher,
  renderWindowsShortcutScript,
} from "../templates/windows.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
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
  const result = {
    platform: "win32",
    shortcutPath,
    supportDirectory,
    chromePath: chrome.executable,
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
  };

  if (config.dryRun) return { ...result, dryRun: true };
  await assertReplaceableWindowsInstall(supportDirectory, shortcutPath, config.force);
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
      lockPath: path.join(stateDirectory, "supervisor.lock"),
      logPath,
    };
    await writeText(path.join(stagingDirectory, "config.json"), `${JSON.stringify(storedConfig, null, 2)}\n`);
    await writeText(path.join(stagingDirectory, "launcher.ps1"), withUtf8Bom(renderWindowsLauncher(config)));
    await writeText(path.join(stagingDirectory, "supervisor.mjs"), renderSupervisor());
    await writeText(path.join(stagingDirectory, "create-shortcut.ps1"), withUtf8Bom(renderWindowsShortcutScript()));
    if (chrome.icon && path.extname(chrome.icon).toLowerCase() === ".ico") {
      await copyFile(chrome.icon, path.join(stagingDirectory, "app.ico"));
      installedIconPath = path.join(supportDirectory, "app.ico");
    }

    if (await pathExists(supportDirectory)) await removeExactTarget(supportDirectory);
    await rename(stagingDirectory, supportDirectory);
  } finally {
    if (await pathExists(stagingDirectory)) await removeExactTarget(stagingDirectory);
  }

  createWindowsShortcut({
    shortcutPath,
    launcherPath: path.join(supportDirectory, "launcher.ps1"),
    supportDirectory,
    iconPath: installedIconPath,
    description: `${config.name} — 先启动服务，再以 Chrome App 模式打开`,
    scriptPath: path.join(supportDirectory, "create-shortcut.ps1"),
  });

  return result;
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

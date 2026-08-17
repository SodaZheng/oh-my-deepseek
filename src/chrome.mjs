import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExecutable, pathExists } from "./utils.mjs";

const bundledMacIcon = fileURLToPath(new URL("../icon.icns", import.meta.url));
const bundledWindowsIcon = fileURLToPath(new URL("../icon.ico", import.meta.url));

export async function findChrome(config, env = process.env) {
  if (config.platform === "darwin") return findChromeOnMac(config);
  return findChromeOnWindows(config, env);
}

async function findChromeOnMac(config) {
  if (config.chrome) {
    return resolveMacChrome(config.chrome, config.icon ?? (await existingBundledIcon(bundledMacIcon)));
  }

  const home = config.homeDirectory || os.homedir();
  const appNames = ["Google Chrome", "Google Chrome Beta", "Google Chrome Canary"];
  for (const appName of appNames) {
    for (const root of ["/Applications", path.join(home, "Applications")]) {
      const appBundle = path.join(root, `${appName}.app`);
      const executable = path.join(appBundle, "Contents", "MacOS", appName);
      if (await isExecutable(executable)) {
        return {
          executable,
          appBundle,
          icon: config.icon ?? (await existingBundledIcon(bundledMacIcon)) ?? (await findMacIcon(appBundle)),
        };
      }
    }
  }
  throw new Error("未找到 Google Chrome。请先安装 Chrome，或用 --chrome 指定 Chrome.app/可执行文件");
}

async function resolveMacChrome(input, customIcon) {
  let executable = input;
  let appBundle = null;
  if (input.endsWith(".app")) {
    appBundle = input;
    const executableName = path.basename(input, ".app");
    executable = path.join(input, "Contents", "MacOS", executableName);
  } else {
    const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
    const markerIndex = input.indexOf(marker);
    if (markerIndex !== -1) appBundle = input.slice(0, markerIndex);
  }
  if (!(await isExecutable(executable))) throw new Error(`Chrome 可执行文件不存在或不可执行：${executable}`);
  return {
    executable,
    appBundle,
    icon: customIcon ?? (appBundle ? await findMacIcon(appBundle) : null),
  };
}

async function findMacIcon(appBundle) {
  for (const iconName of ["app.icns", "document.icns"]) {
    const candidate = path.join(appBundle, "Contents", "Resources", iconName);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function findChromeOnWindows(config, env) {
  const defaultIcon = config.icon ?? (await existingBundledIcon(bundledWindowsIcon));
  if (config.chrome) {
    if (!(await pathExists(config.chrome))) throw new Error(`Chrome 可执行文件不存在：${config.chrome}`);
    return { executable: config.chrome, appBundle: null, icon: defaultIcon ?? config.chrome };
  }

  const candidates = [
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);

  for (const executable of candidates) {
    if (await pathExists(executable)) {
      return { executable, appBundle: null, icon: defaultIcon ?? executable };
    }
  }
  throw new Error("未找到 Google Chrome。请先安装 Chrome，或用 --chrome 指定 chrome.exe");
}

async function existingBundledIcon(iconPath) {
  return (await pathExists(iconPath)) ? iconPath : null;
}

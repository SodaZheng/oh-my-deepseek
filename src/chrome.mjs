import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isExecutable, pathExists } from "./utils.mjs";

const bundledMacIcon = fileURLToPath(new URL("../icon.icns", import.meta.url));
const bundledWindowsIcon = fileURLToPath(new URL("../icon.ico", import.meta.url));

export async function findChrome(config, env = process.env, wslInterop = defaultWslInterop) {
  if (config.platform === "darwin") return findChromeOnMac(config);
  if (config.platform === "wsl") return findChromeOnWsl(config, wslInterop);
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

async function findChromeOnWsl(config, interop) {
  const defaultIcon = config.icon ?? (await existingBundledIcon(bundledWindowsIcon));
  if (config.chrome) {
    const windowsPath = isWindowsPath(config.chrome) ? config.chrome : interop.toWindowsPath(config.chrome);
    if (!windowsPath || !interop.windowsFileExists(windowsPath)) {
      throw new Error(`Windows Chrome 可执行文件不存在：${config.chrome}`);
    }
    return { executable: windowsPath, appBundle: null, icon: defaultIcon };
  }

  const script = String.raw`
$Candidates = @(
  @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    $(if ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) { Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Google\Chrome\Application\chrome.exe' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
)
if ($Candidates.Count -eq 0) { exit 1 }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write($Candidates[0])
`;
  const result = interop.runWindowsPowerShell(script);
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`未在 Windows 宿主机找到 Google Chrome。请先安装 Chrome，或用 --chrome 指定 chrome.exe${detail ? `：${detail}` : ""}`);
  }
  const executable = result.stdout.trim();
  if (!isWindowsPath(executable) || !interop.windowsFileExists(executable)) {
    throw new Error(`Windows Chrome 自动探测结果无效：${executable}。请重新运行，或用 --chrome 指定 chrome.exe`);
  }
  return { executable, appBundle: null, icon: defaultIcon };
}

function isWindowsPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function toWindowsPath(value) {
  const result = spawnSync("wslpath", ["-w", value], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function windowsFileExists(value) {
  const script = `if (Test-Path -LiteralPath ${powershellQuote(value)} -PathType Leaf) { exit 0 } else { exit 1 }`;
  const result = runWindowsPowerShell(script);
  return !result.error && result.status === 0;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runWindowsPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true },
  );
}

const defaultWslInterop = {
  toWindowsPath,
  windowsFileExists,
  runWindowsPowerShell,
};

async function existingBundledIcon(iconPath) {
  return (await pathExists(iconPath)) ? iconPath : null;
}

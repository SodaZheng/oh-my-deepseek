import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, readlink, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import { renderMacChromeShimInfo, renderMacInfoPlist, renderMacLauncher } from "../templates/macos.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { ensureDirectory, pathExists, removeExactTarget, writeText } from "../utils.mjs";

export async function createMacLauncher(config, chrome) {
  const homeDirectory = config.homeDirectory || os.homedir();
  const installDirectory = config.output ?? path.join(homeDirectory, "Applications");
  const appPath = path.join(installDirectory, `${config.name}.app`);
  const desktopPath = path.join(homeDirectory, "Desktop", `${config.name}.app`);
  const stateDirectory = path.join(homeDirectory, "Library", "Application Support", "Oh My DeepSeek", "apps", `${config.slug}-${config.instanceId.slice(0, 8)}`);
  const logPath = path.join(homeDirectory, "Library", "Logs", "Oh My DeepSeek", `${config.slug}.log`);
  const chromeAppId = chrome.appBundle ? await findInstalledChromeAppId(config, homeDirectory) : null;
  const chromeShimPath = chromeAppId ? path.join(stateDirectory, "chrome-shim", `${config.name}.app`) : null;
  const chromeShimBundleId = chromeAppId ? `com.google.Chrome.app.${chromeAppId}` : null;
  const result = {
    platform: "darwin",
    appPath,
    desktopShortcut: config.desktop && desktopPath !== appPath ? desktopPath : null,
    chromePath: chrome.executable,
    chromeShimPath,
    chromeAppId,
    usesChromeShim: Boolean(chromeAppId),
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
  };

  if (config.dryRun) return { ...result, dryRun: true };
  await assertReplaceableMacApp(appPath, config.force);
  await assertSupervisorNotRunning(path.join(stateDirectory, "supervisor.lock"));
  if (chrome.icon && !(await pathExists(chrome.icon))) throw new Error(`图标文件不存在：${chrome.icon}`);

  if (chromeAppId) {
    await updateInstalledChromeWebAppIcons({ homeDirectory, appId: chromeAppId, iconPath: chrome.icon });
    await createChromeAppShim({ config, chrome, appId: chromeAppId, shimPath: chromeShimPath, homeDirectory });
  }

  await ensureDirectory(installDirectory);
  const stagingRoot = await mkdtemp(path.join(installDirectory, ".oh-my-deepseek-"));
  const stagedApp = path.join(stagingRoot, `${config.name}.app`);
  const contents = path.join(stagedApp, "Contents");
  const resourcesDirectory = path.join(contents, "Resources");
  try {
    await writeText(path.join(contents, "Info.plist"), renderMacInfoPlist(config, Boolean(chrome.icon)));
    await writeText(path.join(contents, "MacOS", "launcher"), renderMacLauncher(config), 0o755);
    await writeText(path.join(resourcesDirectory, "supervisor.mjs"), renderSupervisor());
    await writeText(
      path.join(resourcesDirectory, "config.json"),
      `${JSON.stringify({
        generatedBy: GENERATED_BY,
        configVersion: CONFIG_VERSION,
        platform: "darwin",
        launchMode: chromeAppId ? "chrome-app-shim" : "direct-chrome",
        name: config.name,
        url: config.url,
        serviceCommand: config.serviceCommand,
        workingDirectory: config.workingDirectory,
        readyHost: config.readyHost,
        readyPort: config.readyPort,
        timeoutSeconds: config.timeoutSeconds,
        chromePath: chrome.executable,
        nodePath: config.nodePath,
        chromeProfilePath: path.join(stateDirectory, "chrome-profile-direct"),
        chromeExtraArgs: [],
        chromeShimPath,
        chromeShimExecutablePath: chromeShimPath ? path.join(chromeShimPath, "Contents", "MacOS", "app_mode_loader") : null,
        chromeShimBundleId,
        lockPath: path.join(stateDirectory, "supervisor.lock"),
        logPath,
      }, null, 2)}\n`,
    );
    if (chrome.icon) await copyFile(chrome.icon, path.join(resourcesDirectory, "app.icns"));
    signMacApp(stagedApp);
    if (await pathExists(appPath)) await removeExactTarget(appPath);
    await rename(stagedApp, appPath);
  } finally {
    if (await pathExists(stagingRoot)) await removeExactTarget(stagingRoot);
  }

  if (result.desktopShortcut) await createDesktopSymlink(result.desktopShortcut, appPath, config.force);
  return result;
}

async function findInstalledChromeAppId(config, homeDirectory) {
  if (config.chromeAppId) {
    if (!/^[a-p]{32}$/.test(config.chromeAppId)) throw new Error("--chrome-app-id 必须是 32 位 a-p 字符串");
    return config.chromeAppId;
  }
  const profileDirectory = path.join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "Default");
  const preferencesPath = path.join(profileDirectory, "Preferences");
  const manifestRoot = path.join(profileDirectory, "Web Applications", "Manifest Resources");
  let candidates = [];
  try {
    const preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
    candidates = Object.keys(preferences.web_app_install_metrics ?? {}).filter((id) => /^[a-p]{32}$/.test(id));
  } catch {
    return null;
  }
  const databaseDirectory = path.join(profileDirectory, "Sync Data", "LevelDB");
  let databaseFiles = [];
  try {
    databaseFiles = (await readdir(databaseDirectory)).map((name) => path.join(databaseDirectory, name));
  } catch {
    return null;
  }
  const urlBytes = Buffer.from(config.url);
  for (const appId of candidates) {
    if (!(await pathExists(path.join(manifestRoot, appId)))) continue;
    const idBytes = Buffer.from(appId);
    for (const databaseFile of databaseFiles) {
      let data;
      try { data = await readFile(databaseFile); } catch { continue; }
      let offset = data.indexOf(idBytes);
      while (offset !== -1) {
        const nearby = data.subarray(Math.max(0, offset - 512), Math.min(data.length, offset + idBytes.length + 512));
        if (nearby.indexOf(urlBytes) !== -1) return appId;
        offset = data.indexOf(idBytes, offset + idBytes.length);
      }
    }
  }
  return null;
}

async function createChromeAppShim({ config, chrome, appId, shimPath, homeDirectory }) {
  if (await chromeShimIsCanonical(shimPath, appId, config.url)) {
    return;
  }
  const chromeInfoPath = path.join(chrome.appBundle, "Contents", "Info.plist");
  const chromeVersion = readPlistValue(chromeInfoPath, "CFBundleShortVersionString");
  const chromeBundleVersion = readPlistValue(chromeInfoPath, "CFBundleVersion");
  const loaderPath = path.join(chrome.appBundle, "Contents", "Frameworks", "Google Chrome Framework.framework", "Versions", "Current", "Helpers", "app_mode_loader");
  const appDataPath = path.join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "-", "Web Applications", `_crx_${appId}`);
  const shimRoot = path.dirname(shimPath);
  await ensureDirectory(shimRoot);
  const stagingRoot = await mkdtemp(path.join(shimRoot, ".shim-"));
  const stagedShim = path.join(stagingRoot, path.basename(shimPath));
  try {
    await writeText(path.join(stagedShim, "Contents", "Info.plist"), renderMacChromeShimInfo({ config, appId, chromeVersion, chromeBundleVersion, appDataPath }));
    await ensureDirectory(path.join(stagedShim, "Contents", "MacOS"));
    await ensureDirectory(path.join(stagedShim, "Contents", "Resources"));
    await copyFile(loaderPath, path.join(stagedShim, "Contents", "MacOS", "app_mode_loader"));
    await copyFile(chrome.icon, path.join(stagedShim, "Contents", "Resources", "app.icns"));
    await chmod(path.join(stagedShim, "Contents", "MacOS", "app_mode_loader"), 0o755);
    signMacApp(stagedShim);
    if (await pathExists(shimPath)) await removeExactTarget(shimPath);
    await rename(stagedShim, shimPath);
  } finally {
    if (await pathExists(stagingRoot)) await removeExactTarget(stagingRoot);
  }
}

async function updateInstalledChromeWebAppIcons({ homeDirectory, appId, iconPath }) {
  if (!iconPath) return;
  const manifestRoot = path.join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "Default", "Web Applications", "Manifest Resources", appId);
  const iconDirectories = [path.join(manifestRoot, "Icons"), path.join(manifestRoot, "Trusted Icons", "Icons")];
  if (!(await pathExists(manifestRoot))) return;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), ".oh-my-deepseek-web-app-icons-"));
  try {
    for (const size of [32, 48, 64, 96, 128, 256]) {
      const generatedIcon = path.join(temporaryDirectory, `${size}.png`);
      const conversion = spawnSync("/usr/bin/sips", ["-z", String(size), String(size), "-s", "format", "png", iconPath, "--out", generatedIcon], { encoding: "utf8" });
      if (conversion.error || conversion.status !== 0) throw new Error(`无法生成 Chrome Web App ${size}px 图标`);
      for (const directory of iconDirectories) {
        await ensureDirectory(directory);
        await copyFileIfChanged(generatedIcon, path.join(directory, `${size}.png`));
      }
    }
  } finally {
    if (await pathExists(temporaryDirectory)) await removeExactTarget(temporaryDirectory);
  }
}

async function copyFileIfChanged(source, target) {
  if (await pathExists(target)) {
    const [sourceData, targetData] = await Promise.all([readFile(source), readFile(target)]);
    if (sourceData.equals(targetData)) return false;
  }
  await copyFile(source, target);
  return true;
}

async function chromeShimIsCanonical(shimPath, appId, url) {
  const plistPath = path.join(shimPath, "Contents", "Info.plist");
  if (!(await pathExists(plistPath))) return false;
  try {
    return readPlistValue(plistPath, "CrAppModeShortcutID") === appId
      && readPlistValue(plistPath, "CrAppModeShortcutURL") === url
      && readPlistValue(plistPath, "CFBundleExecutable") === "app_mode_loader";
  } catch {
    return false;
  }
}

async function assertReplaceableMacApp(appPath, force) {
  if (!(await pathExists(appPath))) return;
  let owned = false;
  try { owned = (await readFile(path.join(appPath, "Contents", "Info.plist"), "utf8")).includes(`<string>${GENERATED_BY}</string>`); } catch {}
  if (!owned && !force) throw new Error(`目标已存在且不是本工具生成：${appPath}。确认可覆盖后请加 --force`);
}

async function createDesktopSymlink(shortcutPath, appPath, force) {
  await ensureDirectory(path.dirname(shortcutPath));
  let stat = null;
  try { stat = await lstat(shortcutPath); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  if (stat) {
    if (stat.isSymbolicLink() && path.resolve(path.dirname(shortcutPath), await readlink(shortcutPath)) === appPath) return;
    if (!force) throw new Error(`桌面入口已存在：${shortcutPath}。确认可覆盖后请加 --force`);
    await removeExactTarget(shortcutPath);
  }
  await symlink(appPath, shortcutPath);
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

function readPlistValue(plistPath, key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`无法读取 Chrome 信息 ${key}`);
  return result.stdout.trim();
}

function signMacApp(appPath) {
  const result = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`无法签名 macOS App：${result.error?.message || result.stderr || result.stdout}`);
}

import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, readlink, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import { renderMacChromeShimInfo, renderMacInfoPlist, renderMacLaunchAgent, renderMacLauncher, renderMacMonitor } from "../templates/macos.mjs";
import { renderMacNativeMonitorSource } from "../templates/macos-native-monitor.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { ensureDirectory, pathExists, removeExactTarget, writeText } from "../utils.mjs";

export async function createMacLauncher(config, chrome, runtime = {}) {
  const homeDirectory = config.homeDirectory || os.homedir();
  const installDirectory = config.output ?? path.join(homeDirectory, "Applications");
  const appPath = path.join(installDirectory, `${config.name}.app`);
  const desktopPath = path.join(homeDirectory, "Desktop", `${config.name}.app`);
  const stateDirectory = path.join(homeDirectory, "Library", "Application Support", "Oh My DeepSeek", "apps", `${config.slug}-${config.instanceId.slice(0, 8)}`);
  const logPath = path.join(homeDirectory, "Library", "Logs", "Oh My DeepSeek", `${config.slug}.log`);
  const chromeAppId = chrome.appBundle ? await findInstalledChromeAppId(config, homeDirectory) : null;
  const chromeShimPath = chromeAppId ? appPath : null;
  const legacyChromeShimPath = chromeAppId ? path.join(stateDirectory, "chrome-shim", `${config.name}.app`) : null;
  const chromeShimBundleId = chromeAppId ? `com.google.Chrome.app.${chromeAppId}` : null;
  const supervisorPath = path.join(stateDirectory, "supervisor.mjs");
  const nodeMonitorPath = path.join(stateDirectory, "monitor.mjs");
  const nativeMonitorSourcePath = path.join(stateDirectory, "monitor.m");
  const nativeMonitorPath = path.join(stateDirectory, "monitor");
  const monitorConfigPath = path.join(stateDirectory, "monitor-config.json");
  const ownershipPath = path.join(stateDirectory, "ownership.json");
  const launchAgentLabel = `dev.ohmydeepseek.monitor.${config.instanceId}`;
  const launchAgentPath = path.join(homeDirectory, "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
  const result = {
    platform: "darwin",
    appPath,
    desktopShortcut: config.desktop && desktopPath !== appPath ? desktopPath : null,
    chromePath: chrome.executable,
    chromeShimPath,
    chromeAppId,
    usesChromeShim: Boolean(chromeAppId),
    usesLaunchMonitor: Boolean(chromeAppId),
    monitorPath: chromeAppId ? nativeMonitorPath : null,
    monitorMode: chromeAppId ? "native-preferred" : null,
    launchAgentPath: chromeAppId ? launchAgentPath : null,
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
  };

  if (config.dryRun) return { ...result, dryRun: true };
  await assertReplaceableMacApp(appPath, config.force, { ownershipPath, chromeAppId });
  await assertSupervisorNotRunning(path.join(stateDirectory, "supervisor.lock"));
  if (chrome.icon && !(await pathExists(chrome.icon))) throw new Error(`图标文件不存在：${chrome.icon}`);

  if (chromeAppId) {
    if (runtime.manageLaunchAgent !== false) stopMacMonitor(launchAgentLabel);
    await updateInstalledChromeWebAppIcons({ homeDirectory, appId: chromeAppId, iconPath: chrome.icon });
    await ensureDirectory(stateDirectory);
    await writeText(supervisorPath, renderSupervisor());
    await writeText(
      path.join(stateDirectory, "config.json"),
      `${JSON.stringify({
        generatedBy: GENERATED_BY,
        configVersion: CONFIG_VERSION,
        platform: "darwin",
        launchMode: "chrome-app-shim",
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
        chromeShimPath: appPath,
        chromeShimExecutablePath: path.join(appPath, "Contents", "MacOS", "app_mode_loader"),
        chromeShimBundleId,
        lockPath: path.join(stateDirectory, "supervisor.lock"),
        logPath,
      }, null, 2)}\n`,
    );
    await writeText(nodeMonitorPath, renderMacMonitor());
    await writeText(nativeMonitorSourcePath, renderMacNativeMonitorSource());
    await writeText(
      monitorConfigPath,
      `${JSON.stringify({
        generatedBy: GENERATED_BY,
        configVersion: CONFIG_VERSION,
        appPath,
        appBundleIdentifier: chromeShimBundleId,
        appExecutablePath: path.join(appPath, "Contents", "MacOS", "app_mode_loader"),
        nodePath: config.nodePath,
        supervisorPath,
        url: config.url,
        readyHost: config.readyHost,
        readyPort: config.readyPort,
        logPath,
      }, null, 2)}\n`,
    );
    const nativeMonitorReady = runtime.compileNativeMonitor !== false
      && compileMacMonitor(nativeMonitorSourcePath, nativeMonitorPath);
    const monitorProgramArguments = nativeMonitorReady
      ? [nativeMonitorPath, monitorConfigPath]
      : [config.nodePath, nodeMonitorPath];
    result.monitorPath = nativeMonitorReady ? nativeMonitorPath : nodeMonitorPath;
    result.monitorMode = nativeMonitorReady ? "native-events" : "node-polling-fallback";
    await writeText(
      launchAgentPath,
      renderMacLaunchAgent({ label: launchAgentLabel, programArguments: monitorProgramArguments, logPath }),
    );
    await createChromeAppShim({ config, chrome, appId: chromeAppId, shimPath: appPath, homeDirectory });
    await writeText(
      ownershipPath,
      `${JSON.stringify({ generatedBy: GENERATED_BY, configVersion: CONFIG_VERSION, appPath, chromeAppId }, null, 2)}\n`,
    );
    await removeLegacyChromeShim(legacyChromeShimPath);
    registerMacApp(appPath);
    result.dockItemRefreshed = await refreshExistingDockItem(appPath, chromeShimBundleId);
    if (result.desktopShortcut) await createDesktopSymlink(result.desktopShortcut, appPath, config.force);
    if (runtime.manageLaunchAgent !== false) startMacMonitor(launchAgentLabel, launchAgentPath);
    return result;
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
    if (await pathExists(shimPath)) {
      unregisterMacApp(shimPath);
      await removeExactTarget(shimPath);
    }
    await rename(stagedShim, shimPath);
  } finally {
    if (await pathExists(stagingRoot)) await removeExactTarget(stagingRoot);
  }
}

async function removeLegacyChromeShim(legacyChromeShimPath) {
  if (!legacyChromeShimPath || !(await pathExists(legacyChromeShimPath))) return;
  unregisterMacApp(legacyChromeShimPath);
  await removeExactTarget(legacyChromeShimPath);
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

async function assertReplaceableMacApp(appPath, force, { ownershipPath, chromeAppId }) {
  if (!(await pathExists(appPath))) return;
  let owned = false;
  try { owned = (await readFile(path.join(appPath, "Contents", "Info.plist"), "utf8")).includes(`<string>${GENERATED_BY}</string>`); } catch {}
  if (!owned && chromeAppId && await pathExists(ownershipPath)) {
    try {
      const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
      owned = ownership.generatedBy === GENERATED_BY
        && ownership.appPath === appPath
        && ownership.chromeAppId === chromeAppId
        && readPlistValue(path.join(appPath, "Contents", "Info.plist"), "CrAppModeShortcutID") === chromeAppId;
    } catch {}
  }
  if (!owned && !force) throw new Error(`目标已存在且不是本工具生成：${appPath}。确认可覆盖后请加 --force`);
}

function stopMacMonitor(label) {
  if (typeof process.getuid !== "function") return;
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
}

function startMacMonitor(label, launchAgentPath) {
  if (typeof process.getuid !== "function") throw new Error("无法确定当前 macOS 用户 ID");
  const domain = `gui/${process.getuid()}`;
  const bootstrap = spawnSync("/bin/launchctl", ["bootstrap", domain, launchAgentPath], { encoding: "utf8" });
  if (bootstrap.error || bootstrap.status !== 0) {
    throw new Error(`无法安装 macOS App 监视器：${bootstrap.error?.message || bootstrap.stderr || bootstrap.stdout}`);
  }
  const kickstart = spawnSync("/bin/launchctl", ["kickstart", `${domain}/${label}`], { encoding: "utf8" });
  if (kickstart.error || kickstart.status !== 0) {
    throw new Error(`无法启动 macOS App 监视器：${kickstart.error?.message || kickstart.stderr || kickstart.stdout}`);
  }
}

function compileMacMonitor(sourcePath, binaryPath) {
  const located = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" });
  if (located.error || located.status !== 0 || !located.stdout.trim()) return false;
  const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  if (sdk.error || sdk.status !== 0 || !sdk.stdout.trim()) return false;
  const clangPath = located.stdout.trim();
  const commonArguments = ["-isysroot", sdk.stdout.trim(), "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", binaryPath, sourcePath];
  const architectures = process.arch === "arm64"
    ? [["-arch", "arm64", "-arch", "x86_64"], ["-arch", "arm64"]]
    : [["-arch", "x86_64", "-arch", "arm64"], ["-arch", "x86_64"]];
  for (const architectureArguments of architectures) {
    const compiled = spawnSync(clangPath, [...architectureArguments, ...commonArguments], { encoding: "utf8" });
    if (!compiled.error && compiled.status === 0) {
      const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", binaryPath], { encoding: "utf8" });
      return !signed.error && signed.status === 0;
    }
  }
  return false;
}

function registerMacApp(appPath) {
  spawnSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appPath],
    { stdio: "ignore" },
  );
}

function unregisterMacApp(appPath) {
  spawnSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-u", appPath],
    { stdio: "ignore" },
  );
}

async function refreshExistingDockItem(appPath, bundleId) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), ".oh-my-deepseek-dock-"));
  const dockPlistPath = path.join(temporaryDirectory, "dock.plist");
  try {
    const exported = spawnSync("/usr/bin/defaults", ["export", "com.apple.dock", dockPlistPath], { stdio: "ignore" });
    if (exported.error || exported.status !== 0) return false;
    const expectedUrl = pathToFileURL(`${appPath}${path.sep}`).href;
    for (let index = 0; index < 200; index += 1) {
      const url = readDockPlistValue(dockPlistPath, `:persistent-apps:${index}:tile-data:file-data:_CFURLString`);
      if (url === null) break;
      if (url !== expectedUrl) continue;
      const currentBundleId = readDockPlistValue(dockPlistPath, `:persistent-apps:${index}:tile-data:bundle-identifier`);
      if (currentBundleId === bundleId) return false;
      const updated = spawnSync(
        "/usr/libexec/PlistBuddy",
        ["-c", `Set :persistent-apps:${index}:tile-data:bundle-identifier ${bundleId}`, dockPlistPath],
        { stdio: "ignore" },
      );
      if (updated.error || updated.status !== 0) return false;
      const imported = spawnSync("/usr/bin/defaults", ["import", "com.apple.dock", dockPlistPath], { stdio: "ignore" });
      if (imported.error || imported.status !== 0) return false;
      spawnSync("/usr/bin/killall", ["Dock"], { stdio: "ignore" });
      return true;
    }
    return false;
  } finally {
    if (await pathExists(temporaryDirectory)) await removeExactTarget(temporaryDirectory);
  }
}

function readDockPlistValue(plistPath, key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, plistPath], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
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

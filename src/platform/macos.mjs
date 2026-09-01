import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, readlink, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { CONFIG_VERSION, GENERATED_BY } from "../constants.mjs";
import { renderMacChromeShimInfo, renderMacInfoPlist, renderMacLauncher } from "../templates/macos.mjs";
import { renderMacNativeMonitorSource } from "../templates/macos-native-monitor.mjs";
import {
  renderMacManagedLaunchAgent,
  renderMacServiceManagerInfo,
  renderMacServiceManagerSource,
} from "../templates/macos-service-manager.mjs";
import { renderSupervisor } from "../templates/supervisor.mjs";
import { ensureDirectory, pathExists, removeExactTarget, writeText } from "../utils.mjs";

export async function createMacLauncher(config, chrome, runtime = {}) {
  const homeDirectory = config.homeDirectory || os.homedir();
  const installDirectory = config.output ?? path.join(homeDirectory, "Applications");
  const appPath = path.join(installDirectory, `${config.name}.app`);
  const desktopPath = path.join(homeDirectory, "Desktop", `${config.name}.app`);
  const stateDirectory = path.join(homeDirectory, "Library", "Application Support", "Oh My DeepSeek", "apps", `${config.slug}-${config.instanceId.slice(0, 8)}`);
  const logPath = path.join(homeDirectory, "Library", "Logs", "Oh My DeepSeek", `${config.slug}.log`);
  const ownershipPath = path.join(stateDirectory, "ownership.json");
  const stateConfigPath = path.join(stateDirectory, "config.json");
  const chromeAppId = chrome.appBundle
    ? await findInstalledChromeAppId(config, homeDirectory, { appPath, ownershipPath, stateConfigPath })
    : null;
  const chromeShimPath = chromeAppId ? appPath : null;
  const legacyChromeShimPath = chromeAppId ? path.join(stateDirectory, "chrome-shim", `${config.name}.app`) : null;
  const chromeShimBundleId = chromeAppId ? `com.google.Chrome.app.${chromeAppId}` : null;
  const supervisorPath = path.join(stateDirectory, "supervisor.mjs");
  const nativeMonitorSourcePath = path.join(stateDirectory, "monitor.m");
  const nativeMonitorPath = path.join(stateDirectory, "monitor");
  const monitorConfigPath = path.join(stateDirectory, "monitor-config.json");
  const launchAgentLabel = `dev.ohmydeepseek.monitor.${config.instanceId}`;
  const launchAgentPlistName = `${launchAgentLabel}.plist`;
  const legacyLaunchAgentPath = path.join(homeDirectory, "Library", "LaunchAgents", launchAgentPlistName);
  const serviceBundlePath = path.join(stateDirectory, "Oh My DeepSeek Background Launcher.app");
  const serviceManagerPath = path.join(serviceBundlePath, "Contents", "MacOS", "service-manager");
  const managedMonitorPath = path.join(serviceBundlePath, "Contents", "MacOS", "monitor");
  const managedLaunchAgentPath = path.join(serviceBundlePath, "Contents", "Library", "LaunchAgents", launchAgentPlistName);
  const appExists = await pathExists(appPath);
  const desktopShortcutExists = config.desktop && desktopPath !== appPath
    ? await pathEntryExists(desktopPath)
    : false;
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
    launchAgentPath: chromeAppId ? managedLaunchAgentPath : null,
    serviceBundlePath: chromeAppId ? serviceBundlePath : null,
    restartPersistence: chromeAppId ? "pending" : "not-required",
    requiresUserApproval: false,
    url: config.url,
    serviceCommand: config.serviceCommand,
    workingDirectory: config.workingDirectory,
    logPath,
    replacedExisting: appExists || desktopShortcutExists,
  };

  if (config.dryRun) return { ...result, dryRun: true };
  await assertReplaceableMacApp(appPath, config.force, { ownershipPath, chromeAppId });
  if (result.desktopShortcut) {
    await assertReplaceableMacDesktopShortcut(result.desktopShortcut, appPath, config.force);
  }
  await assertSupervisorNotRunning(path.join(stateDirectory, "supervisor.lock"));
  if (chrome.icon && !(await pathExists(chrome.icon))) throw new Error(`图标文件不存在：${chrome.icon}`);

  if (chromeAppId) {
    if (runtime.manageLaunchAgent !== false && await pathExists(legacyLaunchAgentPath)) {
      stopMacMonitor(launchAgentLabel);
    }
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
    const serviceManagerSourcePath = path.join(stateDirectory, "service-manager.m");
    const serviceManagerBinaryPath = path.join(stateDirectory, "service-manager");
    await writeText(
      serviceManagerSourcePath,
      renderMacServiceManagerSource({ launchAgentPlistName }),
    );
    const managedServiceReady = nativeMonitorReady && compileMacServiceManager(
      serviceManagerSourcePath,
      serviceManagerBinaryPath,
    );
    const reusableManagedService = await pathExists(serviceManagerPath)
      && await pathExists(managedMonitorPath)
      && await pathExists(managedLaunchAgentPath);
    if (managedServiceReady || reusableManagedService) {
      if (managedServiceReady) {
        unregisterMacManagedMonitor(serviceManagerPath);
        await createMacManagedMonitorService({
          config,
          serviceBundlePath,
          serviceManagerBinaryPath,
          nativeMonitorPath,
          monitorConfigPath,
          launchAgentLabel,
          launchAgentPlistName,
          logPath,
        });
      }
      result.monitorPath = managedMonitorPath;
      result.monitorMode = "native-events-smappservice";
      result.launchAgentPath = managedLaunchAgentPath;
      if (runtime.manageLaunchAgent !== false) {
        if (await pathExists(legacyLaunchAgentPath)) await removeExactTarget(legacyLaunchAgentPath);
        const registration = startMacManagedMonitor({
          label: launchAgentLabel,
          managerPath: serviceManagerPath,
        });
        result.restartPersistence = registration.status;
        result.requiresUserApproval = registration.status === "requires-approval";
      } else {
        result.restartPersistence = "not-registered-test-mode";
      }
    } else {
      throw new Error("无法构建 macOS 重启启动服务。为保证重启后仍然生效，本工具不会再回退到只对当前登录会话有效的旧式 LaunchAgent；请先安装 Apple Command Line Tools（xcode-select --install）后重新运行 create");
    }
    await destroyMacVisibleLauncher({ appPath, desktopShortcut: result.desktopShortcut });
    await createChromeAppShim({ config, chrome, appId: chromeAppId, shimPath: appPath, homeDirectory });
    await writeText(
      ownershipPath,
      `${JSON.stringify({ generatedBy: GENERATED_BY, configVersion: CONFIG_VERSION, appPath, chromeAppId }, null, 2)}\n`,
    );
    await removeLegacyChromeShim(legacyChromeShimPath);
    registerMacApp(appPath);
    result.dockItemRefreshed = await refreshExistingDockItem(appPath, chromeShimBundleId);
    if (result.desktopShortcut) await createDesktopSymlink(result.desktopShortcut, appPath, config.force);
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
    await destroyMacVisibleLauncher({ appPath, desktopShortcut: result.desktopShortcut });
    await rename(stagedApp, appPath);
  } finally {
    if (await pathExists(stagingRoot)) await removeExactTarget(stagingRoot);
  }

  if (result.desktopShortcut) await createDesktopSymlink(result.desktopShortcut, appPath, config.force);
  return result;
}

export async function inspectMacRestartPersistence(config) {
  const homeDirectory = config.homeDirectory || os.homedir();
  const appKey = `${config.slug}-${config.instanceId.slice(0, 8)}`;
  const stateDirectory = path.join(homeDirectory, "Library", "Application Support", "Oh My DeepSeek", "apps", appKey);
  const label = `dev.ohmydeepseek.monitor.${config.instanceId}`;
  const plistName = `${label}.plist`;
  const serviceBundlePath = path.join(stateDirectory, "Oh My DeepSeek Background Launcher.app");
  const managerPath = path.join(serviceBundlePath, "Contents", "MacOS", "service-manager");
  const managedPlistPath = path.join(serviceBundlePath, "Contents", "Library", "LaunchAgents", plistName);
  const legacyPlistPath = path.join(homeDirectory, "Library", "LaunchAgents", plistName);
  const hasManagedService = await pathExists(managerPath) && await pathExists(managedPlistPath);
  const hasLegacyService = await pathExists(legacyPlistPath);
  if (!hasManagedService && !hasLegacyService) {
    return { name: "重启后桌面启动", ok: true, detail: "尚未创建此入口；运行 create 后会安装并验证登录启动服务" };
  }

  const status = hasManagedService
    ? readMacServiceStatus(managerPath)
    : readLegacyMacServiceStatus(legacyPlistPath);
  const launchService = readMacLaunchServiceState(label);
  const loaded = launchService.loaded;
  const ok = status === "enabled" && launchService.state === "running";
  let detail;
  if (ok) {
    detail = `已启用并运行；macOS 会在后续登录时自动启动监视器（${label}）`;
  } else if (status === "requires-approval") {
    detail = "需要在 系统设置 → 通用 → 登录项与扩展 中允许 Oh My DeepSeek 后台运行";
  } else if (status === "enabled") {
    detail = `登录启动服务已授权但当前未正常运行：${label}（${launchService.state}）`;
  } else {
    detail = `登录启动服务状态异常：${status}`;
  }
  return { name: "重启后桌面启动", ok, detail, status, loaded, launchState: launchService.state };
}

async function findInstalledChromeAppId(config, homeDirectory, { appPath, ownershipPath, stateConfigPath }) {
  if (config.chromeAppId) {
    if (!/^[a-p]{32}$/.test(config.chromeAppId)) throw new Error("--chrome-app-id 必须是 32 位 a-p 字符串");
    return config.chromeAppId;
  }
  const profileDirectory = path.join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "Default");
  const preferencesPath = path.join(profileDirectory, "Preferences");
  const manifestRoot = path.join(profileDirectory, "Web Applications", "Manifest Resources");
  const recoveredAppId = await recoverInstalledChromeAppId({
    config,
    appPath,
    ownershipPath,
    stateConfigPath,
    preferencesPath,
    manifestRoot,
  });
  if (recoveredAppId) return recoveredAppId;
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

async function recoverInstalledChromeAppId({ config, appPath, ownershipPath, stateConfigPath, preferencesPath, manifestRoot }) {
  const existingPlistPath = path.join(appPath, "Contents", "Info.plist");
  if (await pathExists(existingPlistPath)) {
    try {
      const appId = readPlistValue(existingPlistPath, "CrAppModeShortcutID");
      const url = readPlistValue(existingPlistPath, "CrAppModeShortcutURL");
      if (url === config.url) {
        if (await chromeAppIdIsStillInstalled(appId, preferencesPath, manifestRoot)) return appId;
        refuseChromeShimDowngrade(`之前关联的 Chrome Web App ${appId} 当前无法验证；为避免破坏 Dock App，已停止覆盖。请在 Chrome 中重新安装该页面后再运行 create`);
      }
    } catch (error) {
      if (error?.code === "OMD_CHROME_APP_UNVERIFIED") throw error;
    }
  }

  try {
    const [ownership, previousConfig] = await Promise.all([
      readFile(ownershipPath, "utf8").then(JSON.parse),
      readFile(stateConfigPath, "utf8").then(JSON.parse),
    ]);
    const appId = ownership.chromeAppId;
    const matchesSavedShim = ownership.generatedBy === GENERATED_BY
      && ownership.appPath === appPath
      && previousConfig.generatedBy === GENERATED_BY
      && previousConfig.platform === "darwin"
      && previousConfig.launchMode === "chrome-app-shim"
      && previousConfig.url === config.url
      && previousConfig.chromeShimPath === appPath
      && previousConfig.chromeShimBundleId === `com.google.Chrome.app.${appId}`;
    if (matchesSavedShim) {
      if (await chromeAppIdIsStillInstalled(appId, preferencesPath, manifestRoot)) return appId;
      refuseChromeShimDowngrade(`已保存的 Chrome Web App ${appId} 当前无法验证；为避免再次降级成 Chrome 图标，已停止覆盖。请在 Chrome 中重新安装该页面后再运行 create`);
    }
  } catch (error) {
    if (error?.code === "OMD_CHROME_APP_UNVERIFIED") throw error;
  }
  return null;
}

function refuseChromeShimDowngrade(message) {
  const error = new Error(message);
  error.code = "OMD_CHROME_APP_UNVERIFIED";
  throw error;
}

async function chromeAppIdIsStillInstalled(appId, preferencesPath, manifestRoot) {
  if (!/^[a-p]{32}$/.test(appId) || !(await pathExists(path.join(manifestRoot, appId)))) return false;
  try {
    const preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
    return Object.hasOwn(preferences.web_app_install_metrics ?? {}, appId);
  } catch {
    return false;
  }
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

async function assertReplaceableMacDesktopShortcut(shortcutPath, appPath, force) {
  let stat = null;
  try { stat = await lstat(shortcutPath); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  if (!stat) return;
  let owned = false;
  if (stat.isSymbolicLink()) {
    try {
      owned = path.resolve(path.dirname(shortcutPath), await readlink(shortcutPath)) === appPath;
    } catch {}
  }
  if (!owned && !force) {
    throw new Error(`桌面入口已存在且不是本工具生成：${shortcutPath}。确认可覆盖后请加 --force`);
  }
}

async function destroyMacVisibleLauncher({ appPath, desktopShortcut }) {
  if (desktopShortcut && await pathEntryExists(desktopShortcut)) {
    await removeExactTarget(desktopShortcut);
  }
  if (await pathExists(appPath)) {
    unregisterMacApp(appPath);
    await removeExactTarget(appPath);
  }
}

async function pathEntryExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
  const commonArguments = ["-isysroot", sdk.stdout.trim(), "-mmacosx-version-min=13.0", "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", binaryPath, sourcePath];
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

function compileMacServiceManager(sourcePath, binaryPath) {
  const located = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" });
  if (located.error || located.status !== 0 || !located.stdout.trim()) return false;
  const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  if (sdk.error || sdk.status !== 0 || !sdk.stdout.trim()) return false;
  const clangPath = located.stdout.trim();
  const commonArguments = [
    "-isysroot", sdk.stdout.trim(),
    "-mmacosx-version-min=13.0",
    "-fobjc-arc",
    "-framework", "Foundation",
    "-framework", "ServiceManagement",
    "-o", binaryPath,
    sourcePath,
  ];
  const architectures = process.arch === "arm64"
    ? [["-arch", "arm64", "-arch", "x86_64"], ["-arch", "arm64"]]
    : [["-arch", "x86_64", "-arch", "arm64"], ["-arch", "x86_64"]];
  for (const architectureArguments of architectures) {
    const compiled = spawnSync(clangPath, [...architectureArguments, ...commonArguments], { encoding: "utf8" });
    if (!compiled.error && compiled.status === 0) return true;
  }
  return false;
}

async function createMacManagedMonitorService({
  config,
  serviceBundlePath,
  serviceManagerBinaryPath,
  nativeMonitorPath,
  monitorConfigPath,
  launchAgentLabel,
  launchAgentPlistName,
  logPath,
}) {
  const stagingRoot = await mkdtemp(path.join(path.dirname(serviceBundlePath), ".background-launcher-"));
  const stagedBundlePath = path.join(stagingRoot, path.basename(serviceBundlePath));
  const managerPath = path.join(stagedBundlePath, "Contents", "MacOS", "service-manager");
  const monitorPath = path.join(stagedBundlePath, "Contents", "MacOS", "monitor");
  const launchAgentPath = path.join(stagedBundlePath, "Contents", "Library", "LaunchAgents", launchAgentPlistName);
  const bundleIdentifier = `dev.ohmydeepseek.background-launcher.${config.instanceId}`;
  try {
    await writeText(
      path.join(stagedBundlePath, "Contents", "Info.plist"),
      renderMacServiceManagerInfo({ bundleIdentifier, name: config.name }),
    );
    await ensureDirectory(path.dirname(managerPath));
    await copyFile(serviceManagerBinaryPath, managerPath);
    await copyFile(nativeMonitorPath, monitorPath);
    await chmod(managerPath, 0o755);
    await chmod(monitorPath, 0o755);
    await writeText(
      launchAgentPath,
      renderMacManagedLaunchAgent({ label: launchAgentLabel, monitorConfigPath, logPath }),
    );
    signMacApp(stagedBundlePath);
    if (await pathExists(serviceBundlePath)) await removeExactTarget(serviceBundlePath);
    await rename(stagedBundlePath, serviceBundlePath);
  } finally {
    if (await pathExists(stagingRoot)) await removeExactTarget(stagingRoot);
  }
}

function unregisterMacManagedMonitor(managerPath) {
  const status = readMacServiceStatus(managerPath);
  if (status !== "enabled" && status !== "requires-approval") return;
  const result = spawnSync(managerPath, ["unregister"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`无法更新 macOS 重启启动服务：${result.error?.message || result.stderr || result.stdout}`);
  }
}

function startMacManagedMonitor({ label, managerPath }) {
  let status = readMacServiceStatus(managerPath);
  for (let attempt = 0; status !== "enabled" && attempt < 3; attempt += 1) {
    const registered = spawnSync(managerPath, ["register"], { encoding: "utf8" });
    status = parseMacServiceStatus(registered.stdout) ?? readMacServiceStatus(managerPath);
    if (status !== "requires-approval" && (registered.error || registered.status !== 0)) {
      throw new Error(`无法注册 macOS 重启启动服务：${registered.error?.message || registered.stderr || registered.stdout}`);
    }
    if (status === "requires-approval" && attempt < 2) {
      spawnSync("/bin/sleep", ["0.25"], { stdio: "ignore" });
      status = readMacServiceStatus(managerPath);
    }
  }
  if (status !== "enabled" && status !== "requires-approval") {
    throw new Error(`macOS 重启启动服务注册后状态异常：${status}`);
  }
  if (status === "enabled") {
    const domain = `gui/${process.getuid()}`;
    let kicked;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      kicked = spawnSync("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`], { encoding: "utf8" });
      if (!kicked.error && kicked.status === 0) break;
      spawnSync("/bin/sleep", ["0.1"], { stdio: "ignore" });
    }
    if (kicked.error || kicked.status !== 0) {
      throw new Error(`macOS 重启启动服务已注册，但无法启动：${kicked.error?.message || kicked.stderr || kicked.stdout}`);
    }
    let launchState = readMacLaunchServiceState(label);
    for (let attempt = 0; launchState.state !== "running" && attempt < 20; attempt += 1) {
      spawnSync("/bin/sleep", ["0.1"], { stdio: "ignore" });
      launchState = readMacLaunchServiceState(label);
    }
    if (launchState.state !== "running") {
      throw new Error(`macOS 重启启动服务未能进入运行状态：${launchState.state}`);
    }
  } else if (status === "requires-approval") {
    spawnSync(managerPath, ["open-settings"], { stdio: "ignore" });
  }
  return { status };
}

function readMacServiceStatus(managerPath) {
  if (!managerPath) return "not-found";
  const result = spawnSync(managerPath, ["status"], { encoding: "utf8" });
  if (result.error) return "not-found";
  return parseMacServiceStatus(result.stdout) ?? "unknown";
}

function parseMacServiceStatus(output) {
  const statuses = new Set(["enabled", "requires-approval", "not-registered", "not-found"]);
  return String(output).split(/\r?\n/).map((value) => value.trim()).find((value) => statuses.has(value)) ?? null;
}

function readMacLaunchServiceState(label) {
  if (typeof process.getuid !== "function") return { loaded: false, state: "unsupported" };
  const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8" });
  if (result.error || result.status !== 0) return { loaded: false, state: "not-loaded" };
  const stateLine = String(result.stdout).split(/\r?\n/).find((line) => /^\s*state = /.test(line));
  const state = stateLine?.match(/^\s*state = (.+?)\s*$/)?.[1] ?? "unknown";
  const exitLine = String(result.stdout).split(/\r?\n/).find((line) => /^\s*last exit code = /.test(line));
  return { loaded: true, state, lastExitCode: exitLine?.replace(/^\s*last exit code = /, "") ?? null };
}

function readLegacyMacServiceStatus(launchAgentPath) {
  const source = `import Foundation; import ServiceManagement; let value = SMAppService.statusForLegacyPlist(at: URL(fileURLWithPath: ${JSON.stringify(launchAgentPath)})); switch value { case .enabled: print("enabled"); case .requiresApproval: print("requires-approval"); case .notRegistered: print("not-registered"); case .notFound: print("not-found"); @unknown default: print("unknown") }`;
  const result = spawnSync("/usr/bin/xcrun", ["swift", "-e", source], { encoding: "utf8" });
  return parseMacServiceStatus(result.stdout) ?? "legacy-session-only";
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

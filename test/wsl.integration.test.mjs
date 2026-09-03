import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWslLauncher, findInstalledWindowsWebApp, inspectWslRestartPersistence, parseSimpleServiceCommand, resolveDirectWslService, warmDirectServiceCompileCache } from "../src/platform/wsl.mjs";
import { pathExists } from "../src/utils.mjs";

test("creates a Windows shortcut payload while keeping the supervisor in WSL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-wsl-test-"));
  const home = path.join(root, "home");
  const project = path.join(home, "project");
  const icon = path.join(root, "icon.ico");
  const chromeExecutable = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
  const installedAppId = "b".repeat(32);
  await mkdir(project, { recursive: true });
  await writeFile(icon, "icon");

  const config = normalizeCreateOptions(
    { name: "WSL Harness", cwd: project },
    {
      platform: "linux",
      cwd: project,
      env: { WSL_DISTRO_NAME: "Ubuntu-Test", USER: "tester", SHELL: "/bin/bash" },
    },
  );
  const officialPwaAppUserModelId = `Chrome._crx_${installedAppId}`;
  const appUserModelId = `OpenAI.OhMyDeepSeek.${config.instanceId}`;
  const shortcutExistenceAtCreation = [];
  const refreshedTaskbarShortcuts = [];
  const pinnedPwaShortcutPath = String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\WSL Harness.lnk`;
  config.homeDirectory = home;
  const toLocalPath = (windowsPath) => {
    assert.match(windowsPath, /^[A-Z]:\\/i);
    return path.join(root, "windows", windowsPath[0].toLowerCase(), ...windowsPath.slice(3).split("\\"));
  };
  const interop = {
    getWindowsEnvironment() {
      return {
        localAppData: String.raw`C:\Users\tester\AppData\Local`,
        desktop: String.raw`C:\Users\tester\Desktop`,
        startup: String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`,
        appData: String.raw`C:\Users\tester\AppData\Roaming`,
        programs: String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs`,
        powerShell: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
        wsl: String.raw`C:\Windows\System32\wsl.exe`,
      };
    },
    toWslPath: toLocalPath,
    toWindowsPath(value) {
      return String.raw`C:\Output` + value.replaceAll("/", "-");
    },
    createShortcut(options) {
      const target = toLocalPath(options.shortcutPath);
      shortcutExistenceAtCreation.push({ shortcutPath: options.shortcutPath, existed: existsSync(target) });
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(options));
    },
    inspectShortcut({ shortcutPath }) {
      try {
        const value = JSON.parse(requireShortcut(shortcutPath));
        return { targetPath: value.launcherPath, arguments: "", appUserModelId: value.appUserModelId };
      } catch {
        return null;
      }
    },
    compileNativeLauncher({ outputPathWsl }) {
      writeFileSync(outputPathWsl, "native launcher placeholder");
    },
    findPwaShortcutIdentity() {
      return {
        shortcutPath: String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Chrome Apps\WSL Harness.lnk`,
        appUserModelId: officialPwaAppUserModelId,
        pinnedShortcutPath: pinnedPwaShortcutPath,
      };
    },
    createStartupMonitor({ monitorPath, shortcutPath }) {
      const target = toLocalPath(shortcutPath);
      shortcutExistenceAtCreation.push({ shortcutPath, existed: existsSync(target) });
      writeFileSync(target, JSON.stringify({ launcherPath: monitorPath }));
    },
    refreshTaskbarShortcut({ shortcutPath }) {
      refreshedTaskbarShortcuts.push(shortcutPath);
    },
    resolveDirectService() {
      return {
        executable: "/opt/dsh/bin/dsh",
        arguments: ["web"],
        path: "/opt/dsh/bin:/usr/bin:/bin",
        serviceKind: "dsh-web",
        dshWebLaunch: { kind: "argv", prefixArguments: [], arguments: ["web"] },
      };
    },
  };
  function requireShortcut(shortcutPath) {
    return readFileSync(toLocalPath(shortcutPath), "utf8");
  }
  const profileRoot = toLocalPath(String.raw`C:\Users\tester\AppData\Local\Google\Chrome\User Data\Default`);
  await mkdir(path.join(profileRoot, "Web Applications", "Manifest Resources", installedAppId), { recursive: true });
  await mkdir(path.join(profileRoot, "Sync Data", "LevelDB"), { recursive: true });
  await writeFile(path.join(profileRoot, "Sync Data", "LevelDB", "000001.log"), `prefix-${installedAppId}-${config.url}-suffix`);
  const proxyPath = path.win32.join(path.win32.dirname(chromeExecutable), "chrome_proxy.exe");
  await mkdir(path.dirname(toLocalPath(proxyPath)), { recursive: true });
  await writeFile(toLocalPath(proxyPath), "proxy");
  const legacyWarmStartShortcut = toLocalPath(String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\WSL Harness (WSL Warm Start).lnk`);
  await mkdir(path.dirname(legacyWarmStartShortcut), { recursive: true });
  await writeFile(legacyWarmStartShortcut, "legacy warm start");
  const pinnedPwaShortcut = toLocalPath(pinnedPwaShortcutPath);
  const originalPinnedShortcut = JSON.stringify({
    launcherPath: proxyPath,
    appUserModelId: officialPwaAppUserModelId,
  });
  await mkdir(path.dirname(pinnedPwaShortcut), { recursive: true });
  await writeFile(pinnedPwaShortcut, originalPinnedShortcut);
  const windowsWslExecutable = toLocalPath(String.raw`C:\Windows\System32\wsl.exe`);
  await mkdir(path.dirname(windowsWslExecutable), { recursive: true });
  await writeFile(windowsWslExecutable, "wsl executable placeholder");

  const result = await createWslLauncher(
    config,
    { executable: chromeExecutable, icon },
    interop,
  );
  assert.equal(result.replacedExisting, false);
  const hostSupport = toLocalPath(result.hostSupportDirectory);
  const shortcut = toLocalPath(result.shortcutPath);
  assert.equal(await pathExists(shortcut), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "supervisor.mjs")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "loading-proxy.mjs")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "loading-config.json")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "loading-whale.png")), true);
  assert.equal(await pathExists(path.join(hostSupport, "browser-host.ps1")), true);
  assert.equal(await pathExists(path.join(hostSupport, "launcher.ps1")), false);
  assert.equal(await pathExists(path.join(hostSupport, "launcher.js")), false);
  assert.equal(await pathExists(path.join(hostSupport, "launcher.exe")), true);
  assert.equal(await pathExists(path.join(hostSupport, "loading-whale.png")), true);
  assert.equal(await pathExists(path.join(hostSupport, "pwa-monitor.exe")), false);
  const nativeLauncherSource = await readFile(path.join(hostSupport, "launcher.cs"), "utf8");
  assert.match(nativeLauncherSource, /SetCurrentProcessExplicitAppUserModelID/);
  assert.match(nativeLauncherSource, new RegExp(Buffer.from(appUserModelId, "utf8").toString("base64")));
  assert.match(nativeLauncherSource, /CreateNoWindow = true/);
  assert.match(nativeLauncherSource, /Process\.Start/);
  assert.match(nativeLauncherSource, /process\.WaitForExit\(\)/);
  assert.match(nativeLauncherSource, /Application\.Run\(form\)/);
  assert.match(nativeLauncherSource, /HandoffReadyPath/);
  assert.match(nativeLauncherSource, /TopMost = true/);
  assert.match(nativeLauncherSource, /DwmFlush\(\)/);
  assert.match(nativeLauncherSource, /CreateTransparentWhale/);
  assert.doesNotMatch(nativeLauncherSource, /DrawDepthGlow|DrawSpecular/);
  assert.match(nativeLauncherSource, /Color\.FromArgb\(21, 21, 23\)/);
  const browserHostSource = await readFile(path.join(hostSupport, "browser-host.ps1"), "utf8");
  assert.match(browserHostSource, /BeginWindowGate/);
  assert.match(browserHostSource, /DwmSetWindowAttribute/);
  assert.match(browserHostSource, /WaitForWindowReadyToReveal/);
  assert.match(browserHostSource, /DwmFlush/);
  assert.match(browserHostSource, /ReleaseWindowGate/);
  assert.match(browserHostSource, /Track-ManagedChromeWindow/);
  assert.doesNotMatch(browserHostSource, /Windows Chrome 在初始化期间退出/);
  const shortcutOptions = JSON.parse(await readFile(shortcut, "utf8"));
  assert.match(shortcutOptions.launcherPath, /launcher\.exe$/i);
  assert.equal(shortcutOptions.appUserModelId, appUserModelId);
  assert.equal(shortcutOptions.iconPath, path.win32.join(result.hostSupportDirectory, "app.ico"));
  const startMenuShortcut = toLocalPath(result.startMenuShortcutPath);
  const startMenuShortcutOptions = JSON.parse(await readFile(startMenuShortcut, "utf8"));
  assert.match(startMenuShortcutOptions.launcherPath, /launcher\.exe$/i);
  assert.equal(startMenuShortcutOptions.appUserModelId, appUserModelId);
  assert.equal(startMenuShortcutOptions.iconPath, path.win32.join(result.hostSupportDirectory, "app.ico"));
  const storedConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "config.json"), "utf8"));
  assert.equal(storedConfig.platform, "wsl");
  assert.equal(storedConfig.launchMode, "windows-host-browser");
  assert.equal(storedConfig.serviceShell, "/bin/bash");
  assert.equal(storedConfig.directService.executable, config.nodePath);
  assert.deepEqual(storedConfig.directService.arguments, [
    path.join(result.supportDirectory, "loading-proxy.mjs"),
    path.join(result.supportDirectory, "loading-config.json"),
  ]);
  assert.equal(storedConfig.directService.serviceKind, "loading-proxy");
  const loadingConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "loading-config.json"), "utf8"));
  assert.equal(loadingConfig.platform, "wsl");
  assert.equal(loadingConfig.directService.executable, "/opt/dsh/bin/dsh");
  assert.equal(loadingConfig.directService.serviceKind, "dsh-web");
  assert.equal(loadingConfig.minimumLoadingMilliseconds, 900);
  assert.match(storedConfig.powerShellPath, /Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/i);
  const launchConfig = JSON.parse(await readFile(path.join(hostSupport, "wsl-launch.json"), "utf8"));
  assert.equal(launchConfig.distro, "Ubuntu-Test");
  assert.equal(launchConfig.user, "tester");
  assert.match(launchConfig.wslPath, /wsl\.exe$/i);
  const browserConfig = JSON.parse(await readFile(path.join(hostSupport, "browser-config.json"), "utf8"));
  assert.equal(browserConfig.launchMode, "installed-pwa");
  assert.equal(browserConfig.loadingMode, true);
  assert.match(browserConfig.loadingBoundsPath, /loading-window\.json$/);
  assert.match(browserConfig.launcherHandoffPath, /launcher-handoff\.ready$/);
  assert.equal(browserConfig.appUserModelId, appUserModelId);
  assert.equal(browserConfig.sourceAppUserModelId, officialPwaAppUserModelId);
  assert.equal(browserConfig.taskbarIconResource, `${path.win32.join(result.hostSupportDirectory, "app.ico")},0`);
  assert.equal(
    browserConfig.windowBoundsPath,
    path.win32.join(String.raw`C:\Users\tester\AppData\Local`, "Oh My DeepSeek", "state", `${config.slug}-${config.instanceId.slice(0, 8)}`, "window-size.json"),
  );
  assert.equal(result.serviceLaunchMode, "direct");
  assert.equal(result.instantLoading, true);
  assert.equal(result.usesLoadingScreen, true);
  assert.equal(result.taskbarIdentityMatched, true);
  assert.equal(result.usesOfficialPwaEntry, true);
  assert.equal(result.officialPwaAppUserModelId, officialPwaAppUserModelId);
  assert.equal(result.pinnedShortcutMigration, "migrated");
  assert.equal(result.pinnedPwaShortcutPath, pinnedPwaShortcutPath);
  assert.equal(result.appUserModelId, appUserModelId);
  assert.equal(result.restartPersistence, "shortcut-on-disk");
  assert.equal(result.residentMonitor, false);
  const monitorStartupShortcut = toLocalPath(String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\WSL Harness Monitor.lnk`);
  assert.equal(await pathExists(monitorStartupShortcut), false);
  assert.equal(await pathExists(legacyWarmStartShortcut), false);
  const migratedPinnedShortcut = JSON.parse(await readFile(pinnedPwaShortcut, "utf8"));
  assert.match(migratedPinnedShortcut.launcherPath, /launcher\.exe$/i);
  assert.equal(migratedPinnedShortcut.appUserModelId, appUserModelId);
  assert.deepEqual(refreshedTaskbarShortcuts, [pinnedPwaShortcutPath]);
  assert.equal(
    await readFile(toLocalPath(result.pinnedPwaShortcutBackupPath), "utf8"),
    originalPinnedShortcut,
    "the original Chrome PWA taskbar shortcut must remain recoverable",
  );

  const persistence = await inspectWslRestartPersistence(config, interop);
  assert.equal(persistence.ok, true, persistence.detail);
  assert.match(persistence.detail, /未安装登录常驻监视器/);

  const staleWslSupportFile = path.join(result.supportDirectory, "stale-generated-file.txt");
  const staleHostSupportFile = path.join(hostSupport, "stale-generated-file.txt");
  const persistedWindowBounds = toLocalPath(browserConfig.windowBoundsPath);
  await writeFile(staleWslSupportFile, "old WSL support payload");
  await writeFile(staleHostSupportFile, "old Windows support payload");
  await mkdir(path.dirname(persistedWindowBounds), { recursive: true });
  await writeFile(persistedWindowBounds, "saved window size");
  const secondCreationStart = shortcutExistenceAtCreation.length;

  const recreated = await createWslLauncher(
    config,
    { executable: chromeExecutable, icon },
    interop,
  );

  assert.equal(recreated.replacedExisting, true);
  assert.equal(await pathExists(staleWslSupportFile), false);
  assert.equal(await pathExists(staleHostSupportFile), false);
  assert.equal(await pathExists(persistedWindowBounds), true, "saved window state must survive launcher replacement");
  const secondShortcutCreations = shortcutExistenceAtCreation.slice(secondCreationStart);
  assert.equal(secondShortcutCreations.length, 3);
  assert.equal(
    secondShortcutCreations
      .filter(({ shortcutPath }) => shortcutPath !== pinnedPwaShortcutPath)
      .every(({ existed }) => existed === false),
    true,
    "old shortcuts must be deleted before their replacements are created",
  );
  assert.equal(secondShortcutCreations.find(({ shortcutPath }) => shortcutPath === pinnedPwaShortcutPath)?.existed, true);
  assert.equal(await readFile(toLocalPath(recreated.pinnedPwaShortcutBackupPath), "utf8"), originalPinnedShortcut);
});

test("parses only service commands that are safe to execute without a shell", () => {
  assert.deepEqual(parseSimpleServiceCommand('dsh web --host "127.0.0.1"'), ["dsh", "web", "--host", "127.0.0.1"]);
  assert.deepEqual(parseSimpleServiceCommand("npm run dev"), ["npm", "run", "dev"]);
  assert.deepEqual(parseSimpleServiceCommand("tool 'argument with spaces'"), ["tool", "argument with spaces"]);
  assert.deepEqual(parseSimpleServiceCommand('tool "literal\\q"'), ["tool", "literal\\q"]);
  assert.equal(parseSimpleServiceCommand("FOO=bar dsh web"), null);
  assert.equal(parseSimpleServiceCommand("dsh web && echo done"), null);
  assert.equal(parseSimpleServiceCommand("dsh $(prepare)"), null);
  assert.equal(parseSimpleServiceCommand("dsh web\necho done"), null);
  assert.equal(parseSimpleServiceCommand("dsh 'unterminated"), null);
});

test("prepares the default DSH compile cache during create without keeping a process alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-wsl-cache-"));
  const fakeDsh = path.join(root, "dsh");
  const marker = path.join(root, "warmup.txt");
  const cachePath = path.join(root, "compile-cache");
  await writeFile(fakeDsh, `#!/bin/sh\nprintf '%s\\n' "$NODE_COMPILE_CACHE" "$@" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  await chmod(fakeDsh, 0o755);
  const config = {
    serviceCommand: `'${fakeDsh}' web`,
    serviceShell: "/bin/bash",
    servicePath: process.env.PATH,
    workingDirectory: root,
  };
  const directService = await resolveDirectWslService(config);
  directService.nodeCompileCachePath = cachePath;
  assert.deepEqual(directService.warmupArguments, ["web", "--help"]);
  assert.equal(warmDirectServiceCompileCache(directService, config), true);
  assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [cachePath, "web", "--help"]);
});

test("detects a Windows Chrome installed PWA for the configured WSL URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-wsl-pwa-test-"));
  const toLocalPath = (windowsPath) => path.join(root, "windows", windowsPath[0].toLowerCase(), ...windowsPath.slice(3).split("\\"));
  const localAppData = String.raw`C:\Users\tester\AppData\Local`;
  const chromeExecutable = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
  const appId = "a".repeat(32);
  const profileRoot = toLocalPath(path.win32.join(localAppData, "Google", "Chrome", "User Data", "Default"));
  await mkdir(path.join(profileRoot, "Web Applications", "Manifest Resources", appId), { recursive: true });
  await mkdir(path.join(profileRoot, "Sync Data", "LevelDB"), { recursive: true });
  await writeFile(path.join(profileRoot, "Sync Data", "LevelDB", "000001.log"), `prefix-${appId}-http://127.0.0.1:3080/-suffix`);
  const proxyPath = path.win32.join(path.win32.dirname(chromeExecutable), "chrome_proxy.exe");
  await mkdir(path.dirname(toLocalPath(proxyPath)), { recursive: true });
  await writeFile(toLocalPath(proxyPath), "proxy");

  const detected = await findInstalledWindowsWebApp({
    config: { url: "http://127.0.0.1:3080/", chromeAppId: null },
    chrome: { executable: chromeExecutable },
    windowsEnvironment: { localAppData },
    interop: { toWslPath: toLocalPath },
  });

  assert.deepEqual(detected, {
    appId,
    profileDirectory: "Default",
    launcherPath: proxyPath,
    arguments: ["--profile-directory=Default", `--app-id=${appId}`],
  });
});

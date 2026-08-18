import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWslLauncher, findInstalledWindowsWebApp, parseSimpleServiceCommand } from "../src/platform/wsl.mjs";
import { pathExists } from "../src/utils.mjs";

test("creates a Windows shortcut payload while keeping the supervisor in WSL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-wsl-test-"));
  const home = path.join(root, "home");
  const project = path.join(home, "project");
  const icon = path.join(root, "icon.ico");
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
      writeFileSync(target, JSON.stringify(options));
    },
    resolveDirectService() {
      return {
        executable: "/opt/dsh/bin/dsh",
        arguments: ["web"],
        path: "/opt/dsh/bin:/usr/bin:/bin",
      };
    },
  };
  const legacyWarmStartShortcut = toLocalPath(String.raw`C:\Users\tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\WSL Harness (WSL Warm Start).lnk`);
  await mkdir(path.dirname(legacyWarmStartShortcut), { recursive: true });
  await writeFile(legacyWarmStartShortcut, "legacy warm start");

  const result = await createWslLauncher(
    config,
    { executable: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, icon },
    interop,
  );
  const hostSupport = toLocalPath(result.hostSupportDirectory);
  const shortcut = toLocalPath(result.shortcutPath);
  assert.equal(await pathExists(shortcut), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "supervisor.mjs")), true);
  assert.equal(await pathExists(path.join(hostSupport, "browser-host.ps1")), true);
  assert.equal(await pathExists(path.join(hostSupport, "launcher.ps1")), false);
  assert.equal(await pathExists(path.join(hostSupport, "launcher.js")), true);
  const hiddenLauncher = await readFile(path.join(hostSupport, "launcher.js"), "utf8");
  assert.notEqual(hiddenLauncher.charCodeAt(0), 0xfeff);
  assert.equal(/[^\x00-\x7f]/.test(hiddenLauncher), false);
  assert.match(hiddenLauncher, /C:\\\\Windows\\\\System32\\\\wsl\.exe/);
  assert.match(hiddenLauncher, /--distribution/);
  assert.match(hiddenLauncher, /--exec/);
  assert.doesNotMatch(hiddenLauncher, /powershell\.exe/i);
  const shortcutOptions = JSON.parse(await readFile(shortcut, "utf8"));
  assert.match(shortcutOptions.launcherPath, /launcher\.js$/i);
  const storedConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "config.json"), "utf8"));
  assert.equal(storedConfig.platform, "wsl");
  assert.equal(storedConfig.launchMode, "windows-host-browser");
  assert.equal(storedConfig.serviceShell, "/bin/bash");
  assert.deepEqual(storedConfig.directService, {
    executable: "/opt/dsh/bin/dsh",
    arguments: ["web"],
    path: "/opt/dsh/bin:/usr/bin:/bin",
    nodeCompileCachePath: path.join(home, ".local", "state", "oh-my-deepseek", "apps", `${config.slug}-${config.instanceId.slice(0, 8)}`, "node-compile-cache"),
  });
  assert.match(storedConfig.powerShellPath, /Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/i);
  const launchConfig = JSON.parse(await readFile(path.join(hostSupport, "wsl-launch.json"), "utf8"));
  assert.equal(launchConfig.distro, "Ubuntu-Test");
  assert.equal(launchConfig.user, "tester");
  assert.match(launchConfig.wslPath, /wsl\.exe$/i);
  const browserConfig = JSON.parse(await readFile(path.join(hostSupport, "browser-config.json"), "utf8"));
  assert.equal(browserConfig.launchMode, "url-app");
  assert.equal(result.serviceLaunchMode, "direct");
  assert.equal(await pathExists(legacyWarmStartShortcut), false);
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

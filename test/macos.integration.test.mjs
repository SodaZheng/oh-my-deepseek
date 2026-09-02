import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createMacLauncher } from "../src/platform/macos.mjs";
import { pathExists } from "../src/utils.mjs";

test("creates a signed self-contained macOS app and desktop shortcut", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-test-"));
  const fakeChrome = path.join(root, "chrome");
  const fakeIcon = path.join(root, "app.icns");
  const fakeDsh = path.join(root, "dsh");
  await writeFile(fakeChrome, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(fakeChrome, 0o755);
  await writeFile(fakeDsh, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  await chmod(fakeDsh, 0o755);
  await writeFile(fakeIcon, "fake icon for codesign test");

  const config = normalizeCreateOptions(
    {
      name: "Test Harness",
      output: path.join(root, "Applications"),
      cwd: root,
    },
    { platform: "darwin", cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SHELL: "/bin/sh" } },
  );
  config.homeDirectory = root;
  const result = await createMacLauncher(config, { executable: fakeChrome, icon: fakeIcon });

  const plist = await readFile(path.join(result.appPath, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /OMDGeneratedBy/);
  assert.doesNotMatch(plist, /LSUIElement/);
  assert.equal(await readlink(result.desktopShortcut), result.appPath);
  const storedConfig = JSON.parse(await readFile(path.join(result.appPath, "Contents", "Resources", "config.json"), "utf8"));
  assert.equal(storedConfig.generatedBy, "oh-my-deepseek");
  assert.equal(result.serviceLaunchMode, "direct");
  assert.equal(storedConfig.directService.executable, process.execPath);
  assert.equal(storedConfig.directService.arguments[0], await realpath(fakeDsh));
  assert.match(storedConfig.directService.nodeCompileCachePath, /node-compile-cache$/);
  assert.equal(await readFile(path.join(result.appPath, "Contents", "Resources", "supervisor.mjs"), "utf8").then(Boolean), true);
});

test("installs one canonical Chrome App with a zero-resident on-demand socket launcher", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-monitor-test-"));
  const chromeBundle = path.join(root, "Google Chrome.app");
  const chromeExecutable = path.join(chromeBundle, "Contents", "MacOS", "Google Chrome");
  const loader = path.join(chromeBundle, "Contents", "Frameworks", "Google Chrome Framework.framework", "Versions", "Current", "Helpers", "app_mode_loader");
  const fakeIcon = path.resolve("icon.icns");
  const fakeDsh = path.join(root, "dsh");
  await mkdir(path.dirname(chromeExecutable), { recursive: true });
  await mkdir(path.dirname(loader), { recursive: true });
  await writeFile(chromeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(loader, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(fakeDsh, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  await chmod(fakeDsh, 0o755);
  await writeFile(path.join(chromeBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>140.0.0.0</string>
<key>CFBundleVersion</key><string>1400000000</string>
</dict></plist>\n`);
  const appId = "a".repeat(32);
  const chromeProfile = path.join(root, "Library", "Application Support", "Google", "Chrome", "Default");
  await mkdir(path.join(chromeProfile, "Web Applications", "Manifest Resources", appId), { recursive: true });
  await writeFile(path.join(chromeProfile, "Preferences"), JSON.stringify({ web_app_install_metrics: { [appId]: { install_source: 15 } } }));
  const config = normalizeCreateOptions(
    { name: "Monitor Test", output: path.join(root, "Applications"), cwd: root, "chrome-app-id": appId },
    { platform: "darwin", cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SHELL: "/bin/sh" } },
  );
  config.homeDirectory = root;
  const result = await createMacLauncher(
    config,
    { executable: chromeExecutable, appBundle: chromeBundle, icon: fakeIcon },
    { manageLaunchAgent: false },
  );

  assert.equal(result.replacedExisting, false);
  assert.equal(result.appPath, result.chromeShimPath);
  assert.equal(result.usesLaunchMonitor, false);
  assert.equal(result.usesOnDemandLauncher, true);
  assert.equal(result.residentMonitor, false);
  assert.match(await readFile(path.join(result.appPath, "Contents", "Info.plist"), "utf8"), /CrAppModeShortcutID/);
  assert.equal(result.monitorMode, null);
  assert.equal(result.monitorPath, null);
  const launchAgent = await readFile(result.launchAgentPath, "utf8");
  assert.match(launchAgent, /<key>Sockets<\/key>/);
  assert.doesNotMatch(launchAgent, /<key>KeepAlive<\/key>|<key>RunAtLoad<\/key>/);
  assert.match(result.launchAgentPath, /Oh My DeepSeek Background Launcher\.app\/Contents\/Library\/LaunchAgents/);
  assert.match(result.launchAgentPath, /dev\.ohmydeepseek\.ondemand\.v3\./);
  assert.equal(await pathExists(path.join(result.serviceBundlePath, "Contents", "MacOS", "service-manager")), true);
  assert.equal(result.restartPersistence, "not-registered-test-mode");
  const onDemandConfig = JSON.parse(await readFile(path.join(root, "Library", "Application Support", "Oh My DeepSeek", "apps", `${config.slug}-${config.instanceId.slice(0, 8)}`, "on-demand-config.json"), "utf8"));
  assert.match(onDemandConfig.loadingIconPath, /loading-whale\.png$/);
  assert.equal(await pathExists(onDemandConfig.loadingIconPath), true);
  for (const executable of [result.onDemandLauncherPath, path.join(result.serviceBundlePath, "Contents", "MacOS", "service-manager")]) {
    const buildVersion = spawnSync("/usr/bin/vtool", ["-show-build", executable], { encoding: "utf8" });
    assert.equal(buildVersion.status, 0, buildVersion.stderr || buildVersion.stdout);
    assert.match(buildVersion.stdout, /minos 13\.0/);
  }
  const helperInfo = await readFile(path.join(result.serviceBundlePath, "Contents", "Info.plist"), "utf8");
  assert.match(helperInfo, /<key>CFBundleVersion<\/key>\s*<string>3<\/string>/);
  const ownership = JSON.parse(await readFile(path.join(root, "Library", "Application Support", "Oh My DeepSeek", "apps", `${config.slug}-${config.instanceId.slice(0, 8)}`, "ownership.json"), "utf8"));
  assert.equal(ownership.appPath, result.appPath);
  assert.equal(ownership.chromeAppId, appId);
  const staleAppFile = path.join(result.appPath, "stale-generated-file.txt");
  await writeFile(staleAppFile, "old app payload");

  const recreated = await createMacLauncher(
    config,
    { executable: chromeExecutable, appBundle: chromeBundle, icon: fakeIcon },
    { manageLaunchAgent: false },
  );
  assert.equal(recreated.appPath, result.appPath);
  assert.equal(recreated.replacedExisting, true);
  assert.equal(await pathExists(staleAppFile), true, "a canonical Chrome-rebuilt Shim must be preserved instead of replaced before first launch");

  await writeFile(path.join(result.appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundleIdentifier</key><string>dev.ohmydeepseek.broken</string>
<key>OMDGeneratedBy</key><string>oh-my-deepseek</string>
</dict></plist>\n`);
  const recoveredConfig = normalizeCreateOptions(
    { name: "Monitor Test", output: path.join(root, "Applications"), cwd: root },
    { platform: "darwin", cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SHELL: "/bin/sh" } },
  );
  recoveredConfig.homeDirectory = root;
  const recovered = await createMacLauncher(
    recoveredConfig,
    { executable: chromeExecutable, appBundle: chromeBundle, icon: fakeIcon },
    { manageLaunchAgent: false },
  );
  assert.equal(recovered.chromeAppId, appId);
  assert.equal(recovered.usesChromeShim, true);
  assert.match(await readFile(path.join(recovered.appPath, "Contents", "Info.plist"), "utf8"), new RegExp(appId));

  await rm(path.join(chromeProfile, "Web Applications", "Manifest Resources", appId), { recursive: true, force: true });
  await assert.rejects(
    createMacLauncher(
      recoveredConfig,
      { executable: chromeExecutable, appBundle: chromeBundle, icon: fakeIcon },
      { manageLaunchAgent: false },
    ),
    /已停止覆盖/,
  );
  assert.match(await readFile(path.join(recovered.appPath, "Contents", "Info.plist"), "utf8"), new RegExp(appId));
});

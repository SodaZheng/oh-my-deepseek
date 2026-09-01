import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { renderMacMonitor } from "../src/templates/macos.mjs";
import { renderMacNativeMonitorSource } from "../src/templates/macos-native-monitor.mjs";
import { pathExists } from "../src/utils.mjs";

test("macOS monitor intercepts a cold App launch and delegates to the supervisor", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-monitor-runtime-test-"));
  const fakeApp = path.join(root, "app_mode_loader");
  const monitorPath = path.join(root, "monitor.mjs");
  const supervisorPath = path.join(root, "supervisor.mjs");
  const markerPath = path.join(root, "supervisor-started");
  const logPath = path.join(root, "monitor.log");
  const readyPort = await reserveUnusedPort();
  await copyFile("/bin/sleep", fakeApp);
  await chmod(fakeApp, 0o755);
  await writeFile(monitorPath, renderMacMonitor());
  await writeFile(supervisorPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "started");\n`);
  await writeFile(
    path.join(root, "monitor-config.json"),
    JSON.stringify({
      appExecutablePath: fakeApp,
      nodePath: process.execPath,
      supervisorPath,
      url: `http://127.0.0.1:${readyPort}/`,
      readyHost: "127.0.0.1",
      readyPort,
      logPath,
    }),
  );

  const monitor = spawn(process.execPath, [monitorPath], { stdio: "ignore" });
  const fakeAppProcess = spawn(fakeApp, ["30"], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 7000;
    while (!(await pathExists(markerPath)) && Date.now() < deadline) await delay(50);
    assert.equal(await pathExists(markerPath), true, "monitor did not launch the supervisor");
    if (fakeAppProcess.exitCode === null && fakeAppProcess.signalCode === null) {
      await Promise.race([once(fakeAppProcess, "exit"), delay(2000)]);
    }
    assert.equal(
      fakeAppProcess.exitCode !== null || fakeAppProcess.signalCode !== null,
      true,
      "monitor did not terminate the initial App process",
    );
  } finally {
    if (fakeAppProcess.exitCode === null) fakeAppProcess.kill("SIGKILL");
    if (monitor.exitCode === null) monitor.kill("SIGTERM");
    await Promise.race([once(monitor, "exit"), delay(2000)]);
  }
});

test("native macOS monitor reacts to NSWorkspace launch events without polling", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-native-monitor-test-"));
  const sourcePath = path.join(root, "monitor.m");
  const binaryPath = path.join(root, "monitor");
  const configPath = path.join(root, "monitor-config.json");
  const supervisorPath = path.join(root, "supervisor.mjs");
  const markerPath = path.join(root, "supervisor-started");
  const logPath = path.join(root, "monitor.log");
  const appBundle = path.join(root, "Monitor Target.app");
  const appExecutable = path.join(appBundle, "Contents", "MacOS", "monitor-target");
  const appSource = path.join(root, "monitor-target.m");
  const bundleIdentifier = `dev.ohmydeepseek.monitor-test.${Date.now()}`;
  await writeFile(sourcePath, renderMacNativeMonitorSource());
  const located = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" });
  assert.equal(located.status, 0, located.stderr || located.stdout);
  const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  assert.equal(sdk.status, 0, sdk.stderr || sdk.stdout);
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const compiled = spawnSync(
    located.stdout.trim(),
    ["-arch", architecture, "-isysroot", sdk.stdout.trim(), "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", binaryPath, sourcePath],
    { encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

  await mkdir(path.dirname(appExecutable), { recursive: true });
  await writeFile(appSource, `#import <AppKit/AppKit.h>\nint main(void) { @autoreleasepool { [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]; [NSApp run]; } return 0; }\n`);
  const appCompiled = spawnSync(
    located.stdout.trim(),
    ["-arch", architecture, "-isysroot", sdk.stdout.trim(), "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", appExecutable, appSource],
    { encoding: "utf8" },
  );
  assert.equal(appCompiled.status, 0, appCompiled.stderr || appCompiled.stdout);
  await writeFile(path.join(appBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>monitor-target</string>
<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
<key>CFBundleName</key><string>Monitor Target</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
  const signed = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appBundle], { encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr || signed.stdout);
  await writeFile(supervisorPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "started");\n`);
  await writeFile(configPath, JSON.stringify({ appBundleIdentifier: bundleIdentifier, nodePath: process.execPath, supervisorPath, logPath }));

  const monitor = spawn(binaryPath, [configPath], { stdio: "ignore" });
  try {
    const readyDeadline = Date.now() + 7000;
    while (!(await pathExists(logPath)) && Date.now() < readyDeadline) await delay(50);
    assert.equal(await pathExists(logPath), true, "native monitor did not start");
    const opened = spawnSync("/usr/bin/open", [appBundle], { encoding: "utf8" });
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    const deadline = Date.now() + 7000;
    while (!(await pathExists(markerPath)) && Date.now() < deadline) await delay(50);
    assert.equal(await pathExists(markerPath), true, await readFile(logPath, "utf8"));
    assert.match(await readFile(logPath, "utf8"), /捕获 App 启动 PID/);
  } finally {
    if (monitor.exitCode === null) monitor.kill("SIGTERM");
    await Promise.race([once(monitor, "exit"), delay(2000)]);
    spawnSync("/usr/bin/pkill", ["-f", `^${appExecutable}`], { stdio: "ignore" });
  }
});

async function reserveUnusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

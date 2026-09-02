import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { renderMacOnDemandActivatorSource, renderMacOnDemandProxy } from "../src/templates/macos-on-demand.mjs";
import { renderMacOnDemandLaunchAgent } from "../src/templates/macos-service-manager.mjs";
import { pathExists } from "../src/utils.mjs";

test("loading proxy starts DSH only after activation and releases it on exit", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-on-demand-"));
  const proxyPath = path.join(root, "on-demand-proxy.mjs");
  const servicePath = path.join(root, "fake-dsh.mjs");
  const configPath = path.join(root, "config.json");
  const readyPath = path.join(root, "ready");
  const errorPath = path.join(root, "error.txt");
  const stoppedPath = path.join(root, "stopped");
  const logPath = path.join(root, "on-demand.log");
  const port = await reservePort();
  await writeFile(proxyPath, renderMacOnDemandProxy());
  await writeFakeDsh(servicePath, stoppedPath);
  await writeFile(configPath, JSON.stringify(proxyConfig({ root, servicePath, readyPath, errorPath, stoppedPath, logPath, url: `http://127.0.0.1:${port}/` })));

  const proxyEnvironment = { ...process.env };
  delete proxyEnvironment.OMD_LISTEN_FD;
  const proxy = spawn(process.execPath, [proxyPath, configPath], {
    stdio: "ignore",
    env: proxyEnvironment,
  });

  try {
    const publicUrl = `http://127.0.0.1:${port}/`;
    const loading = await waitForHttp(publicUrl, 3000);
    assert.match(loading, /id="omd-launch"/);
    assert.match(loading, /\/__omd_loading_icon/);
    const iconResponse = await fetch(`${publicUrl}__omd_loading_icon`);
    assert.equal(iconResponse.headers.get("content-type"), "image/png");
    await waitForReady(publicUrl, 10_000);
    const response = await fetch(`${publicUrl}?__omd_launch=1`, { headers: { accept: "text/html" } }).then((value) => value.text());
    assert.match(response, /__DSH_BOOT__/);
    assert.match(response, /id="omd-launch"/);
    assert.match(response, /omd-launch--leaving/);
    await waitForPath(readyPath, 3000);
    assert.equal(await pathExists(readyPath), true, await readText(logPath));
    proxy.kill("SIGTERM");
    await waitForChildExit(proxy, 5000);
    assert.equal(await pathExists(stoppedPath), true, await readText(logPath));
  } finally {
    if (proxy.exitCode === null) proxy.kill("SIGKILL");
    spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${process.execPath} ${servicePath}`], { stdio: "ignore" });
  }
});

test("launchd socket activation has no idle process and starts the macOS launcher on demand", { skip: process.platform !== "darwin", timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-launchd-on-demand-")));
  const label = `dev.ohmydeepseek.ondemand-test.${process.pid}.${Date.now()}`;
  const domain = `gui/${process.getuid()}`;
  const activatorSource = path.join(root, "on-demand-launcher.m");
  const activatorPath = path.join(root, "on-demand-launcher");
  const proxyPath = path.join(root, "on-demand-proxy.mjs");
  const servicePath = path.join(root, "fake-dsh.mjs");
  const configPath = path.join(root, "config.json");
  const plistPath = path.join(root, `${label}.plist`);
  const readyPath = path.join(root, "ready");
  const errorPath = path.join(root, "error.txt");
  const stoppedPath = path.join(root, "stopped");
  const logPath = path.join(root, "on-demand.log");
  const appBundle = path.join(root, "On Demand Target.app");
  const appExecutable = path.join(appBundle, "Contents", "MacOS", "target");
  const appSource = path.join(root, "target.m");
  const hiddenPath = path.join(root, "app-hidden");
  const unhiddenPath = path.join(root, "app-unhidden");
  const bundleIdentifier = `${label}.target`;
  const port = await reservePort();

  await writeFile(activatorSource, renderMacOnDemandActivatorSource());
  await writeFile(proxyPath, renderMacOnDemandProxy());
  await writeFakeDsh(servicePath, stoppedPath, 400);
  await writeFile(configPath, JSON.stringify({
    ...proxyConfig({ root, servicePath, readyPath, errorPath, stoppedPath, logPath, url: `http://127.0.0.1:${port}/` }),
    timeoutSeconds: 2,
    appBundleIdentifier: bundleIdentifier,
    nodePath: process.execPath,
    proxyPath,
  }));

  const clang = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" }).stdout.trim();
  const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).stdout.trim();
  const compiled = spawnSync(clang, ["-isysroot", sdk, "-mmacosx-version-min=13.0", "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", activatorPath, activatorSource], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

  await mkdir(path.dirname(appExecutable), { recursive: true });
  await writeFile(appSource, `#import <AppKit/AppKit.h>
@interface TargetDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSString *hiddenPath;
@property(nonatomic, strong) NSString *unhiddenPath;
@end
@implementation TargetDelegate
- (void)applicationDidHide:(NSNotification *)notification { [@"hidden" writeToFile:self.hiddenPath atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
- (void)applicationDidUnhide:(NSNotification *)notification { [@"unhidden" writeToFile:self.unhiddenPath atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
@end
int main(int argc, const char *argv[]) { @autoreleasepool {
  [NSApplication sharedApplication];
  TargetDelegate *delegate = [[TargetDelegate alloc] init];
  delegate.hiddenPath = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"/tmp/missing-hidden";
  delegate.unhiddenPath = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"/tmp/missing-unhidden";
  NSApp.delegate = delegate;
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-10000, 100, 400, 300) styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable) backing:NSBackingStoreBuffered defer:NO];
  window.title = @"On Demand Stable Target";
  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [NSApp run];
} return 0; }
`);
  const appCompiled = spawnSync(clang, ["-isysroot", sdk, "-mmacosx-version-min=13.0", "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", appExecutable, appSource], { encoding: "utf8" });
  assert.equal(appCompiled.status, 0, appCompiled.stderr || appCompiled.stdout);
  await writeFile(path.join(appBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>target</string>
<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
<key>CFBundleName</key><string>On Demand Target</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
  const signed = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appBundle], { encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr || signed.stdout);

  const launchAgent = renderMacOnDemandLaunchAgent({ label, configPath, logPath, host: "127.0.0.1", port })
    .replace("<key>BundleProgram</key>\n  <string>Contents/MacOS/on-demand-launcher</string>", `<key>Program</key>\n  <string>${activatorPath}</string>`);
  await writeFile(plistPath, launchAgent);
  const bootstrapped = spawnSync("/bin/launchctl", ["bootstrap", domain, plistPath], { encoding: "utf8" });
  assert.equal(bootstrapped.status, 0, bootstrapped.stderr || bootstrapped.stdout);

  try {
    assert.notEqual(readLaunchState(domain, label), "running", "on-demand launcher became resident before a connection");
    assert.equal(processMatching(activatorPath), false, "on-demand launcher has an idle process");
    const opened = spawnSync("/usr/bin/open", [appBundle, "--args", hiddenPath, unhiddenPath], { encoding: "utf8" });
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    await waitFor(() => processMatching(appExecutable), 3000);
    const initialAppPid = processIdMatching(appExecutable);

    const publicUrl = `http://127.0.0.1:${port}/`;
    const loadingHtml = await waitForHttp(publicUrl, 10_000);
    assert.match(loadingHtml, /id="omd-launch"/);
    await delay(300);
    assert.equal(await pathExists(hiddenPath), false, "on-demand launcher hid the whole App and destabilized its Dock identity");
    assert.equal(await pathExists(unhiddenPath), false, "on-demand launcher toggled App visibility before readiness");
    await waitForReady(publicUrl, 10_000);
    const html = await fetch(`${publicUrl}?__omd_launch=1`, { headers: { accept: "text/html" } }).then((value) => value.text());
    assert.match(html, /__DSH_BOOT__/);
    assert.match(html, /id="omd-launch"/);
    await waitForPath(readyPath, 3000);
    assert.equal(processIdMatching(appExecutable), initialAppPid, "App process changed during readiness handoff");
    assert.equal(await pathExists(hiddenPath), false, "App received a hide event during startup");
    assert.equal(await pathExists(unhiddenPath), false, "App received an unhide event during startup");
    assert.equal(await pathExists(errorPath), false, await readText(errorPath));
    await delay(2500);
    assert.equal(readLaunchState(domain, label), "running", "ready App was stopped by the startup timeout");
    assert.match(await fetch(`${publicUrl}?__omd_launch=1`, { headers: { accept: "text/html" } }).then((value) => value.text()), /__DSH_BOOT__/);

    spawnSync("/usr/bin/pkill", ["-TERM", "-f", `^${appExecutable}`], { stdio: "ignore" });
    await waitFor(() => !processMatching(activatorPath), 7000);
    await waitForPath(stoppedPath, 3000);
    await waitFor(() => readLaunchState(domain, label) === "not running", 5000);
    assert.equal(readLaunchState(domain, label), "not running");
    await waitFor(() => !processMatching(proxyPath) && !processMatching(servicePath), 5000);
  } finally {
    spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
    spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${appExecutable}`], { stdio: "ignore" });
    spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${activatorPath}`], { stdio: "ignore" });
    spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${process.execPath} ${proxyPath}`], { stdio: "ignore" });
    spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${process.execPath} ${servicePath}`], { stdio: "ignore" });
  }
});

function proxyConfig({ root, servicePath, readyPath, errorPath, logPath, url }) {
  const publicUrl = new URL(url);
  return {
    name: "On Demand Test",
    url,
    readyHost: publicUrl.hostname,
    readyPort: Number(publicUrl.port),
    serviceCommand: "dsh web --no-open",
    directService: {
      executable: process.execPath,
      arguments: [servicePath, "web", "--no-open"],
      path: process.env.PATH,
      serviceKind: "dsh-web",
      nodeCompileCachePath: path.join(root, "compile-cache"),
    },
    workingDirectory: root,
    timeoutSeconds: 10,
    minimumLoadingMilliseconds: 100,
    readyPath,
    errorPath,
    loadingIconPath: path.resolve("assets/windows-icon-master-v2.png"),
    logPath,
  };
}

async function writeFakeDsh(servicePath, stoppedPath, startupDelay = 0) {
  await writeFile(servicePath, `import { writeFileSync } from "node:fs";
import http from "node:http";
const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><title>DeepSeek Harness</title><script>globalThis["__DSH_BOOT__"]={"entries":[{"id":"ready","url":"/plugins/ready/client.js"}]}</script>');
});
setTimeout(() => server.listen(port, "127.0.0.1"), ${startupDelay});
process.on("SIGTERM", () => server.close(() => { writeFileSync(${JSON.stringify(stoppedPath)}, "stopped"); process.exit(0); }));
`);
}

async function waitForHttp(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(500) });
      if (response.ok) return response.text();
    } catch {}
    await delay(50);
  }
  assert.fail(`proxy did not respond: ${url}`);
}

async function waitForReady(publicUrl, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${publicUrl}__omd_ready`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  assert.fail(`proxy did not become ready: ${publicUrl}`);
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function readLaunchState(domain, label) {
  const result = spawnSync("/bin/launchctl", ["print", `${domain}/${label}`], { encoding: "utf8" });
  if (result.status !== 0) return "not loaded";
  return result.stdout.match(/^\s*state = (.+?)\s*$/m)?.[1] ?? "not running";
}

function processMatching(executablePath) {
  const result = spawnSync("/usr/bin/pgrep", ["-f", `^${executablePath}`], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function processIdMatching(executablePath) {
  const result = spawnSync("/usr/bin/pgrep", ["-f", `^${executablePath}`], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return Number(result.stdout.trim().split(/\s+/, 1)[0]) || null;
}

async function waitFor(check, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await check()) && Date.now() < deadline) await delay(50);
  assert.equal(await check(), true, "condition did not become true before timeout");
}

async function readText(filePath) {
  try { return await readFile(filePath, "utf8"); } catch { return ""; }
}

async function waitForPath(filePath, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await pathExists(filePath)) && Date.now() < deadline) await delay(25);
}

async function waitForChildExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), timeoutMilliseconds);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

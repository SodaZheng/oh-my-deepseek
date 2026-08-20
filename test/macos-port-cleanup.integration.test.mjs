import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { renderSupervisor } from "../src/templates/supervisor.mjs";

test("macOS App exit kills an external listener on the configured port", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-port-cleanup-test-"));
  const port = await reserveUnusedPort();
  const servicePath = path.join(root, "external-service.mjs");
  const supervisorPath = path.join(root, "supervisor.mjs");
  const appBundle = path.join(root, "Port Cleanup Target.app");
  const appExecutable = path.join(appBundle, "Contents", "MacOS", "port-cleanup-target");
  const appSource = path.join(root, "port-cleanup-target.m");
  const logPath = path.join(root, "supervisor.log");
  let service = null;
  let supervisor = null;
  let appProcess = null;

  try {
    await writeFile(servicePath, `
import http from "node:http";
process.on("SIGTERM", () => {});
http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ready");
}).listen(${port}, "127.0.0.1");
`);
    service = spawn(process.execPath, [servicePath], { stdio: "ignore" });
    await waitFor(() => portIsListening(port), 5000, "external service did not start");

    await mkdir(path.dirname(appExecutable), { recursive: true });
    await writeFile(appSource, `#import <AppKit/AppKit.h>
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp run];
  }
  return 0;
}
`);
    const located = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" });
    assert.equal(located.status, 0, located.stderr || located.stdout);
    const sdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" });
    assert.equal(sdk.status, 0, sdk.stderr || sdk.stdout);
    const compiled = spawnSync(
      located.stdout.trim(),
      ["-isysroot", sdk.stdout.trim(), "-fobjc-arc", "-framework", "AppKit", "-framework", "Foundation", "-o", appExecutable, appSource],
      { encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    await chmod(appExecutable, 0o755);
    await writeFile(path.join(appBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>port-cleanup-target</string>
<key>CFBundleIdentifier</key><string>dev.ohmydeepseek.port-cleanup-test.${Date.now()}</string>
<key>CFBundleName</key><string>Port Cleanup Target</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
    const signed = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appBundle], { encoding: "utf8" });
    assert.equal(signed.status, 0, signed.stderr || signed.stdout);
    appProcess = spawn(appExecutable, [], { stdio: "ignore" });
    await waitFor(() => processMatching(appExecutable), 3000, "test App process did not start");
    const appCommand = spawnSync("/bin/ps", ["-p", String(appProcess.pid), "-o", "command="], { encoding: "utf8" });
    assert.equal(appCommand.stdout.trim().startsWith(appExecutable), true, appCommand.stdout || appCommand.stderr);

    const supervisorSource = renderSupervisor();
    const testSupervisorSource = supervisorSource.replace(
      '  const opened = spawnSync("/usr/bin/open", [config.chromeShimPath], { encoding: "utf8" });',
      '  const opened = { error: null, status: 0, stderr: "", stdout: "" };',
    );
    assert.notEqual(testSupervisorSource, supervisorSource, "test supervisor did not replace the LaunchServices call");
    await writeFile(supervisorPath, testSupervisorSource);
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      platform: "darwin",
      launchMode: "chrome-app-shim",
      name: "Port Cleanup Test",
      url: `http://127.0.0.1:${port}/`,
      serviceCommand: "unused",
      workingDirectory: root,
      readyHost: "127.0.0.1",
      readyPort: port,
      timeoutSeconds: 10,
      nodePath: process.execPath,
      chromeProfilePath: path.join(root, "chrome-profile"),
      chromeShimPath: appBundle,
      chromeShimExecutablePath: appExecutable,
      lockPath: path.join(root, "supervisor.lock"),
      logPath,
    }));

    supervisor = spawn(process.execPath, [supervisorPath], { stdio: "ignore" });
    await waitFor(async () => (await readText(logPath)).includes("App 退出时仍会强制清理对应端口"), 7000, "supervisor did not adopt external service cleanup");
    try {
      await waitFor(() => processMatching(appExecutable), 7000, "test App did not launch");
    } catch (error) {
      assert.fail(`${error.message}\n${await readText(logPath)}`);
    }
    await delay(1000);
    await terminateMatchingProcessesUntilStable(appExecutable, 3000);

    try {
      await waitForChildExit(supervisor, 10000);
    } catch (error) {
      assert.fail(`${error.message}\n${await readText(logPath)}`);
    }
    try {
      await waitFor(async () => !(await portIsListening(port)), 3000, "configured port remained occupied");
    } catch (error) {
      assert.fail(`${error.message}\n${await readText(logPath)}`);
    }
    assert.equal(service.exitCode !== null || service.signalCode !== null, true, "external service process survived App exit");
    const log = await readFile(logPath, "utf8");
    assert.match(log, new RegExp(`正在停止端口 ${port} 的监听进程`));
    assert.match(log, new RegExp(`端口 ${port} 已强制释放`));
  } finally {
    spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${appExecutable}`], { stdio: "ignore" });
    if (supervisor?.exitCode === null) supervisor.kill("SIGKILL");
    if (service?.exitCode === null) service.kill("SIGKILL");
    if (appProcess?.exitCode === null) appProcess.kill("SIGKILL");
    if (supervisor) await waitForChildExit(supervisor, 2000).catch(() => {});
    if (service) await waitForChildExit(service, 2000).catch(() => {});
    if (appProcess) await waitForChildExit(appProcess, 2000).catch(() => {});
    await rm(root, { recursive: true, force: true });
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

async function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function processMatching(executablePath) {
  const result = spawnSync("/usr/bin/pgrep", ["-f", `^${executablePath}`], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function terminateMatchingProcessesUntilStable(executablePath, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let emptySince = null;
  while (Date.now() < deadline) {
    if (processMatching(executablePath)) {
      emptySince = null;
      spawnSync("/usr/bin/pkill", ["-KILL", "-f", `^${executablePath}`], { stdio: "ignore" });
    } else {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= 500) return;
    }
    await delay(50);
  }
  assert.fail("test App did not remain closed");
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function waitFor(check, timeoutMilliseconds, failureMessage) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(failureMessage);
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

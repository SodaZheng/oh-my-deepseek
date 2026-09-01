import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSupervisor } from "../src/templates/supervisor.mjs";
import { pathExists, shellQuote } from "../src/utils.mjs";

test("rendered supervisor is valid JavaScript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-supervisor-syntax-"));
  const supervisorPath = path.join(root, "supervisor.mjs");
  await writeFile(supervisorPath, renderSupervisor());
  const result = spawnSync(process.execPath, ["--check", supervisorPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test(
  "supervisor waits for a complete DSH boot manifest and owns the service until the Chrome target closes",
  { skip: process.platform === "win32", timeout: 20_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-supervisor-"));
    const profilePath = path.join(root, "profile");
    const servicePath = path.join(root, "fake-service.mjs");
    const chromePath = path.join(root, "fake-chrome");
    const supervisorPath = path.join(root, "supervisor.mjs");
    const stoppedMarker = path.join(root, "service-stopped");
    const readyMarker = path.join(root, "service-ready");
    const appOpenedMarker = path.join(root, "app-opened");
    const servicePort = await reservePort();

    await writeFile(
      servicePath,
      `import { existsSync, writeFileSync } from "node:fs";\nimport http from "node:http";\nconst readyAt = Date.now() + 600;\nconst server = http.createServer((request, response) => { const ready = Date.now() >= readyAt; if (ready && !existsSync(${JSON.stringify(readyMarker)})) writeFileSync(${JSON.stringify(readyMarker)}, String(Date.now())); response.setHeader("content-type", "text/html"); response.end(ready ? '<!doctype html><title>DeepSeek Harness</title><script>globalThis["__DSH_BOOT__"] = {"entries":[{"id":"ready","url":"/plugins/ready/client.js"}]}</script>' : '<!doctype html><title>DeepSeek Harness</title>'); });\nserver.listen(${servicePort}, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => { writeFileSync(${JSON.stringify(stoppedMarker)}, "stopped"); process.exit(0); }));\n`,
    );
    await writeFile(
      chromePath,
      `#!/usr/bin/env node\nimport { existsSync, mkdirSync, writeFileSync } from "node:fs";\nimport http from "node:http";\nimport path from "node:path";\nconst profileArg = process.argv.find((arg) => arg.startsWith("--user-data-dir="));\nconst profile = profileArg.slice("--user-data-dir=".length);\nmkdirSync(profile, { recursive: true });\nif (existsSync(path.join(profile, "DevToolsActivePort"))) { writeFileSync(${JSON.stringify(appOpenedMarker)}, String(Date.now())); process.exit(0); }\nlet appOpenedAt = null;\nconst server = http.createServer((request, response) => { if (existsSync(${JSON.stringify(appOpenedMarker)})) appOpenedAt ??= Date.now(); const targets = appOpenedAt === null ? [{ id: "prewarm-target", type: "page", url: "data:text/html,Preparing%20Chrome%20Runtime" }] : (Date.now() - appOpenedAt < 1200 ? [{ id: "fake-target", type: "page", url: "http://127.0.0.1:${servicePort}/" }] : []); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(request.url === "/json/version" ? { Browser: "Fake Chrome" } : targets)); });\nserver.listen(0, "127.0.0.1", () => { writeFileSync(path.join(profile, "DevToolsActivePort"), String(server.address().port) + "\\n"); });\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`,
      { mode: 0o755 },
    );
    await chmod(chromePath, 0o755);
    await writeFile(supervisorPath, renderSupervisor());
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({
        platform: "darwin",
        name: "Lifecycle Test",
        url: `http://127.0.0.1:${servicePort}/`,
        serviceCommand: `${shellQuote(process.execPath)} ${shellQuote(servicePath)}`,
        workingDirectory: root,
        readyHost: "127.0.0.1",
        readyPort: servicePort,
        timeoutSeconds: 10,
        chromePath,
        nodePath: process.execPath,
        chromeProfilePath: profilePath,
        lockPath: path.join(root, "supervisor.lock"),
        logPath: path.join(root, "supervisor.log"),
      }),
    );

    const supervisor = spawn(process.execPath, [supervisorPath], { stdio: "ignore" });
    const [exitCode] = await Promise.race([
      once(supervisor, "exit"),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("supervisor did not exit")), 15_000);
        timer.unref();
      }),
    ]);

    assert.equal(exitCode, 0, await readFile(path.join(root, "supervisor.log"), "utf8"));
    assert.ok(
      Number(await readFile(appOpenedMarker, "utf8")) - Number(await readFile(readyMarker, "utf8")) >= 80,
      "the visible App opened before readiness remained stable across two checks",
    );
    assert.equal(await pathExists(stoppedMarker), true, "owned service did not receive SIGTERM");
    assert.equal(await canConnect(servicePort), false, "owned service port is still listening");
  },
);

test("WSL supervisor owns the Linux service while a Windows browser bridge owns Chrome", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-wsl-supervisor-"));
  const binDirectory = path.join(root, "bin");
  const profilePath = path.join(root, "profile");
  const servicePath = path.join(root, "fake-service.mjs");
  const supervisorPath = path.join(root, "supervisor.mjs");
  const bridgePath = path.join(root, "browser-host.ps1");
  const bridgeConfigPath = path.join(root, "browser-config.json");
  const stoppedMarker = path.join(root, "service-stopped");
  const servicePort = await reservePort();
  await mkdir(binDirectory, { recursive: true });

  await writeFile(
    servicePath,
    `import { writeFileSync } from "node:fs";\nimport http from "node:http";\nconst server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Ready</title>"); });\nserver.listen(${servicePort}, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => { writeFileSync(${JSON.stringify(stoppedMarker)}, "stopped"); process.exit(0); }));\n`,
  );
  const fakePowerShell = path.join(binDirectory, "powershell.exe");
  await writeFile(
    fakePowerShell,
    "#!/bin/sh\nmode=\"\"\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"-Mode\" ]; then shift; mode=\"$1\"; fi; shift; done\nif [ \"$mode\" = \"Run\" ]; then sleep 1.2; fi\nexit 0\n",
    { mode: 0o755 },
  );
  await chmod(fakePowerShell, 0o755);
  await writeFile(bridgePath, "placeholder");
  await writeFile(bridgeConfigPath, "{}");
  await writeFile(supervisorPath, renderSupervisor());
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify({
      platform: "wsl",
      launchMode: "windows-host-browser",
      name: "WSL Lifecycle Test",
      url: `http://127.0.0.1:${servicePort}/`,
      serviceCommand: `${shellQuote(process.execPath)} ${shellQuote(servicePath)}`,
      serviceShell: "/does/not/exist",
      directService: {
        executable: process.execPath,
        arguments: [servicePath],
        path: process.env.PATH,
      },
      workingDirectory: root,
      readyHost: "127.0.0.1",
      readyPort: servicePort,
      timeoutSeconds: 10,
      chromePath: "C:\\Chrome\\chrome.exe",
      powerShellPath: fakePowerShell,
      nodePath: process.execPath,
      chromeProfilePath: profilePath,
      hostBrowserScriptPath: bridgePath,
      hostBrowserConfigPath: bridgeConfigPath,
      hostBrowserErrorPath: path.join(root, "browser-error.txt"),
      lockPath: path.join(root, "supervisor.lock"),
      logPath: path.join(root, "supervisor.log"),
    }),
  );

  const supervisor = spawn(process.execPath, [supervisorPath], {
    stdio: "ignore",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  const [exitCode] = await Promise.race([
    once(supervisor, "exit"),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("WSL supervisor did not exit")), 15_000);
      timer.unref();
    }),
  ]);

  assert.equal(exitCode, 0, await readFile(path.join(root, "supervisor.log"), "utf8"));
  assert.equal(await pathExists(stoppedMarker), true, "owned WSL service did not receive SIGTERM");
  assert.equal(await canConnect(servicePort), false, "owned WSL service port is still listening");
});

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

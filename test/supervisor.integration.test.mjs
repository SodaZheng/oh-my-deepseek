import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  "supervisor silently starts and owns the service until the Chrome target closes",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-supervisor-"));
    const profilePath = path.join(root, "profile");
    const servicePath = path.join(root, "fake-service.mjs");
    const chromePath = path.join(root, "fake-chrome");
    const supervisorPath = path.join(root, "supervisor.mjs");
    const stoppedMarker = path.join(root, "service-stopped");
    const servicePort = await reservePort();

    await writeFile(
      servicePath,
      `import { writeFileSync } from "node:fs";\nimport net from "node:net";\nconst server = net.createServer();\nserver.listen(${servicePort}, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => { writeFileSync(${JSON.stringify(stoppedMarker)}, "stopped"); process.exit(0); }));\n`,
    );
    await writeFile(
      chromePath,
      `#!/usr/bin/env node\nimport { existsSync, mkdirSync, writeFileSync } from "node:fs";\nimport http from "node:http";\nimport path from "node:path";\nconst profileArg = process.argv.find((arg) => arg.startsWith("--user-data-dir="));\nconst profile = profileArg.slice("--user-data-dir=".length);\nmkdirSync(profile, { recursive: true });\nif (existsSync(path.join(profile, "DevToolsActivePort"))) process.exit(0);\nlet open = true;\nconst server = http.createServer((request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(request.url === "/json/version" ? { Browser: "Fake Chrome" } : (open ? [{ id: "fake-target", type: "page", url: "http://127.0.0.1:${servicePort}/" }] : []))); });\nserver.listen(0, "127.0.0.1", () => { writeFileSync(path.join(profile, "DevToolsActivePort"), String(server.address().port) + "\\n"); setTimeout(() => { open = false; }, 1200); });\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`,
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
    assert.equal(await pathExists(stoppedMarker), true, "owned service did not receive SIGTERM");
    assert.equal(await canConnect(servicePort), false, "owned service port is still listening");
  },
);

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

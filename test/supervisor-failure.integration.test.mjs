import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSupervisor } from "../src/templates/supervisor.mjs";

for (const scenario of ["exit", "proxy-error", "bridge-error", "auth"]) {
  test(`WSL startup preserves ${scenario} diagnostics`, { skip: process.platform === "win32", timeout: 12_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omd-supervisor-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const reservation = net.createServer();
    await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const serviceErrorPath = path.join(root, "loading-error.txt");
    const hostBrowserErrorPath = path.join(root, "browser-error.txt");
    const servicePath = path.join(root, "service.mjs");
    const bridgePath = path.join(root, "bridge");
    let service = "setInterval(() => {}, 1000);";
    if (scenario === "exit") service = "process.exit(23);";
    if (scenario === "proxy-error") service = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(serviceErrorPath)}, 'plugin fixture failed ?token=private-fixture'); setInterval(() => {}, 1000);`;
    if (scenario === "auth") service = `import http from 'node:http'; http.createServer((q,r) => {r.writeHead(401);r.end();}).listen(${port}, '127.0.0.1');`;
    await writeFile(servicePath, service);
    const bridgeScript = path.join(root, "bridge.mjs");
    await writeFile(bridgeScript, `import fs from 'node:fs';
const pidFile = ${JSON.stringify(path.join(root, "bridge.pid"))};
if(process.argv.at(-1) === 'Stop') { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {} }
if(process.argv.at(-1) === 'Run') {
  fs.writeFileSync(pidFile, String(process.pid));
  ${scenario === "bridge-error" ? `fs.writeFileSync(${JSON.stringify(hostBrowserErrorPath)}, 'Windows fixture bridge unavailable'); process.exit(7);` : "setInterval(() => {}, 1000);"}
}`);
    await writeFile(bridgePath, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${bridgeScript.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(root, "supervisor.mjs"), renderSupervisor());
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      platform: "wsl", launchMode: "windows-host-browser", name: "Failure fixture",
      url: `http://127.0.0.1:${port}/`, timeoutSeconds: scenario === "auth" ? 1 : 45,
      chromeProfilePath: path.join(root, "profile"), lockPath: path.join(root, "lock"),
      logPath: path.join(root, "log"), workingDirectory: root, serviceCommand: "fixture",
      directService: { executable: process.execPath, arguments: [servicePath] },
      powerShellPath: bridgePath, hostBrowserExecutablePath: bridgePath,
      serviceErrorPath, hostBrowserErrorPath,
    }));
    await writeFile(serviceErrorPath, "stale failure must be cleared");
    await writeFile(hostBrowserErrorPath, "stale bridge failure must be cleared");
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, "supervisor.mjs")], { stdio: "ignore" });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const [code] = await once(child, "exit");
    const log = await readFile(path.join(root, "log"), "utf8");
    assert.equal(code, 1, log);
    assert.ok(Date.now() - started < 8000, "failure was hidden behind the 45 second timeout");
    assert.doesNotMatch(log, /stale failure|stale bridge|private-fixture/);
    if (scenario === "exit") assert.match(log, /退出码 23/);
    if (scenario === "proxy-error") assert.match(log, /plugin fixture failed.*redacted/);
    if (scenario === "bridge-error") assert.match(log, /Windows fixture bridge unavailable/);
    if (scenario === "auth") assert.match(log, /最后检测：HTTP 401/);
  });
}

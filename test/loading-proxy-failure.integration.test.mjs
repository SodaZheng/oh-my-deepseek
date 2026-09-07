import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderMacOnDemandProxy } from "../src/templates/macos-on-demand.mjs";

test("loading proxy reports actual early service exits instead of a readiness timeout", { timeout: 15_000 }, async (t) => {
  for (const code of [0, 23]) {
    await t.test(`exit code ${code}`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "omd-early-exit-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const proxyPath = path.join(root, "proxy.mjs");
      const configPath = path.join(root, "config.json");
      const servicePath = path.join(root, "service.mjs");
      const errorPath = path.join(root, "error.txt");
      const logPath = path.join(root, "service.log");
      await writeFile(proxyPath, renderMacOnDemandProxy());
      await writeFile(servicePath, `console.error("service test diagnostic"); process.exit(${code});\n`);
      await writeFile(configPath, JSON.stringify({
        url: "http://127.0.0.1:3080/", readyHost: "127.0.0.1", readyPort: 0,
        serviceCommand: "dsh web --no-open", timeoutSeconds: 45,
        workingDirectory: root, logPath, errorPath, readyPath: path.join(root, "ready"),
        loadingIconPath: path.resolve("assets/windows-icon-master-v2.png"),
        directService: { executable: process.execPath, arguments: [servicePath], serviceKind: "dsh-web" },
      }));
      const env = { ...process.env };
      delete env.OMD_LISTEN_FD;
      const proxy = spawn(process.execPath, [proxyPath, configPath], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stderr = "";
      proxy.stderr.on("data", (chunk) => { stderr += chunk; });
      t.after(() => { if (proxy.exitCode === null) proxy.kill("SIGKILL"); });
      const [exitCode] = await once(proxy, "exit");
      assert.equal(exitCode, 1, stderr);
      const message = await readFile(errorPath, "utf8");
      assert.match(message, new RegExp(`退出码 ${code}（0x${code.toString(16).padStart(8, "0")}）`));
      assert.ok(message.includes(process.execPath), message);
      assert.doesNotMatch(message, /45 秒/);
      assert.match(await readFile(logPath, "utf8"), /service test diagnostic/);
    });
  }
});

test("Windows loading proxy starts a PowerShell service with no parent console", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
  const { existsSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "omd-powershell-service-"));
  const proxyPath = path.join(root, "proxy.mjs");
  const configPath = path.join(root, "config.json");
  const servicePath = path.join(root, "service.mjs");
  const wrapperPath = path.join(root, "service.ps1");
  const readyPath = path.join(root, "ready");
  const logPath = path.join(root, "service.log");
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  await writeFile(proxyPath, renderMacOnDemandProxy());
  await writeFile(servicePath, `import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end('<title>DeepSeek Harness</title><script>window.__DSH_BOOT__={"entries":[{"id":"ready","url":"/plugins/ready.js"}]}</script>');
}).listen(port, "127.0.0.1");
`);
  await writeFile(wrapperPath, `& ${quote(process.execPath)} ${quote(servicePath)} @args\nexit $LASTEXITCODE\n`);
  await writeFile(configPath, JSON.stringify({
    url: "http://127.0.0.1:3080/", readyHost: "127.0.0.1", readyPort: 0,
    serviceCommand: "dsh web --no-open", timeoutSeconds: 10, minimumLoadingMilliseconds: 1,
    workingDirectory: root, logPath, errorPath: path.join(root, "error.txt"), readyPath,
    loadingIconPath: path.resolve("assets/windows-icon-master-v2.png"),
    directService: {
      executable: path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      serviceKind: "dsh-web",
      dshWebLaunch: { kind: "argv", prefixArguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapperPath], arguments: ["web", "--no-open"] },
    },
  }));
  const env = { ...process.env };
  delete env.OMD_LISTEN_FD;
  const proxy = spawn(process.execPath, [proxyPath, configPath], { env, detached: true, windowsHide: true, stdio: "ignore" });
  t.after(async () => {
    if (proxy.pid && proxy.exitCode === null) {
      spawnSync("taskkill.exe", ["/pid", String(proxy.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      if (proxy.exitCode === null) await once(proxy, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 12_000;
  while (!existsSync(readyPath) && proxy.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(existsSync(readyPath), true, await readFile(logPath, "utf8"));
});

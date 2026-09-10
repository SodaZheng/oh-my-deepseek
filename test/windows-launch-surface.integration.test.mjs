import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderWindowsHostBrowser } from "../src/templates/wsl.mjs";

test("Windows and WSL bridge accepts login forms but rejects incomplete DSH documents", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omd-surface-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pages = {
    login: '<title>DSH · 访问验证</title><main><form><input></form></main>',
    complete: '<title>DeepSeek Harness</title><script>window.__DSH_BOOT__={"entries":[{"id":"app","url":"/plugins/app.js"}]}</script>',
    partial: '<title>DeepSeek Harness</title><div id="root"></div>',
    empty: '<title>DeepSeek Harness</title><script>window.__DSH_BOOT__={"entries":[]}</script>',
    malformed: '<title>DeepSeek Harness</title><script>window.__DSH_BOOT__={"entries":[{}]}</script>',
    loading: '<title>DeepSeek Harness</title><div id="omd-launch">Starting</div>',
    denied: '<title>Sign in</title>',
  };
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    res.writeHead(name === "denied" ? 401 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(pages[name]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const template = renderWindowsHostBrowser();
  const functions = template.slice(template.indexOf("function Test-CompleteServiceDocument"), template.indexOf("function Wait-ForLaunchSurface"));
  const script = path.join(root, "probe.ps1");
  await writeFile(script, `\uFEFFparam([string]$Base)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$HttpClient = [System.Net.Http.HttpClient]::new()
$HttpClient.Timeout = [TimeSpan]::FromSeconds(2)
${functions}
$Results = @{}
try {
  foreach ($Name in @('login','complete','partial','empty','malformed','loading','denied')) {
    $Config = [pscustomobject]@{url=($Base + '/' + $Name); launchUrlPath=$null}
    $script:LaunchUrl = $Config.url
    $Results[$Name] = @{surface=(Test-LaunchSurface); service=(Test-HttpService)}
  }
  $Results | ConvertTo-Json -Compress
} finally { $HttpClient.Dispose() }
`);
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, `http://127.0.0.1:${server.address().port}`], { windowsHide: true });
  let output = "", error = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, error);
  const results = JSON.parse(output);
  for (const name of ["login", "complete"]) assert.deepEqual(results[name], { surface: true, service: true });
  for (const name of ["partial", "empty", "malformed", "denied"]) assert.deepEqual(results[name], { surface: false, service: false });
  assert.deepEqual(results.loading, { surface: true, service: false });
});

import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnoseStartup, diagnoseWslStartup } from "../src/diagnose.mjs";

test("startup diagnosis inspects installed artifacts and redacts login URLs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omd-diagnose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(req.url === "/" ? 401 : 503);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/?token=fixture-secret`;
  const configPath = path.join(root, "config.json");
  const loadingPath = path.join(root, "loading-config.json");
  const errorPath = path.join(root, "loading-error.txt");
  const logPath = path.join(root, "log");
  await writeFile(loadingPath, JSON.stringify({ errorPath, directService: { executable: process.execPath } }));
  await writeFile(errorPath, "plugin failed " + url);
  await writeFile(logPath, "launch " + url + "&__omd_boot=fixture-nonce");
  await writeFile(configPath, JSON.stringify({
    platform: "wsl", workingDirectory: root, url, logPath,
    directService: { serviceKind: "loading-proxy", executable: process.execPath, arguments: ["proxy.mjs", loadingPath] },
  }));
  const result = await diagnoseWslStartup(configPath);
  assert.deepEqual(requests, ["/", "/__omd_ready"]);
  assert.deepEqual(result.reports[0].probes.map((probe) => probe.status), [401, 503]);
  assert.equal(result.reports[0].serviceExecutableExists, true);
  assert.equal(result.reports[0].loadingConfigExists, true);
  assert.match(result.reports[0].serviceError, /plugin failed/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-nonce/);
});

for (const platform of ["win32", "wsl"]) test(`diagnosis discovers ${platform} installs and includes browser timing without credentials`, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omd-diagnose-platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "Local AppData");
  const app = platform === "win32"
    ? path.join(localAppData, "Oh My DeepSeek", "apps", "fixture")
    : path.join(root, ".local", "share", "oh-my-deepseek", "apps", "fixture");
  await mkdir(app, { recursive: true });
  const timingPath = path.join(root, "browser-startup.log");
  await writeFile(timingPath, "[fixture] window-visible: 1400 ms\n[fixture] page-ready: 1900 ms\nurl /?__omd_boot=private-nonce");
  const loadingPath = path.join(app, "loading-config.json");
  await writeFile(loadingPath, JSON.stringify({ minimumLoadingMilliseconds: 0, waitForWindowReveal: true }));
  await writeFile(path.join(app, "config.json"), JSON.stringify({
    platform, url: "http://example.invalid/", workingDirectory: root,
    hostBrowserTimingPath: timingPath,
    directService: { serviceKind: "loading-proxy", arguments: ["proxy.mjs", loadingPath] },
  }));
  const result = await diagnoseStartup(undefined, { platform, homeDirectory: root, env: { LOCALAPPDATA: localAppData } });
  assert.equal(result.reports[0].platform, platform);
  assert.equal(result.reports[0].minimumLoadingMilliseconds, 0);
  assert.equal(result.reports[0].waitForWindowReveal, true);
  assert.match(result.reports[0].browserTimingTail, /page-ready: 1900 ms/);
  assert.doesNotMatch(JSON.stringify(result), /private-nonce/);
  assert.deepEqual(result.reports[0].probes, [], "diagnosis must not contact non-loopback addresses");
  assert.equal(diagnoseWslStartup, diagnoseStartup);
});

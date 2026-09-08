import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnoseWslStartup } from "../src/diagnose.mjs";

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

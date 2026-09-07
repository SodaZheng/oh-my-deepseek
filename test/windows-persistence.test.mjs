import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWindowsRestartPersistence } from "../src/platform/windows.mjs";

test("Windows persistence validates the native launcher target and rejects broken shortcuts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omd-persistence-"));
  const config = { slug: "deepseek-harness", instanceId: "fae254af", name: "DeepSeek Harness", output: path.join(root, "Desktop") };
  const env = { LOCALAPPDATA: root };
  const support = path.join(root, "Oh My DeepSeek", "apps", "deepseek-harness-fae254af");
  const launcher = path.join(support, "launcher.exe");
  const originalSpawnSync = childProcess.spawnSync;
  t.after(async () => {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(support, { recursive: true });
  await mkdir(config.output, { recursive: true });
  for (const name of ["launcher.exe", "launcher.cs", "supervisor.mjs", "browser-host.ps1", "browser-config.json", "loading-whale.png"]) {
    await writeFile(path.join(support, name), "fixture");
  }
  await writeFile(path.join(support, "config.json"), JSON.stringify({ nodePath: process.execPath }));
  await writeFile(path.join(config.output, `${config.name}.lnk`), "fixture");

  const cases = [
    { name: "native launcher with no arguments", target: launcher, args: "", ok: true },
    { name: "Windows path case and separators", target: path.win32.normalize(launcher).toUpperCase(), args: "", ok: true },
    { name: "old WScript wrapper", target: "C:\\Windows\\System32\\wscript.exe", args: `//B //NoLogo "${launcher}"`, ok: false },
    { name: "same filename in another installation", target: path.join(root, "other", "launcher.exe"), args: "", ok: false },
    { name: "unexpected arguments", target: launcher, args: "--unexpected", ok: false },
    { name: "unreadable shortcut", target: "", args: "", ok: false },
    { name: "PowerShell failure", target: launcher, args: "", status: 1, ok: false },
    { name: "PowerShell unavailable", target: launcher, args: "", error: new Error("ENOENT"), ok: false },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      childProcess.spawnSync = () => ({ stdout: `${entry.target}\r\n${entry.args}`, stderr: "", status: entry.status ?? 0, error: entry.error });
      syncBuiltinESMExports();
      const result = await inspectWindowsRestartPersistence(config, env);
      assert.equal(result.ok, entry.ok, result.detail);
    });
  }
});

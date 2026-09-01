import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveDirectPosixService,
  resolveDirectWindowsService,
} from "../src/service-command.mjs";

test("resolves a Node CLI shebang to the pinned Node executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-direct-node-"));
  const executable = path.join(root, "dsh");
  await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  await chmod(executable, 0o755);
  const directService = await resolveDirectPosixService({
    serviceCommand: "dsh web --no-open",
    serviceShell: "/bin/sh",
    servicePath: `${root}:${process.env.PATH}`,
    nodePath: process.execPath,
  });

  assert.equal(directService.executable, process.execPath);
  const resolvedExecutable = await realpath(executable);
  assert.deepEqual(directService.arguments, [resolvedExecutable, "web", "--no-open"]);
  assert.deepEqual(directService.warmupArguments, [resolvedExecutable, "web", "--help"]);
});

test("resolves a Windows PowerShell command shim without loading user profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-direct-windows-"));
  const fakePowerShell = path.join(root, "powershell.exe");
  await writeFile(
    fakePowerShell,
    "#!/bin/sh\nprintf '%s' '{\"servicePath\":\"C:\\\\Tools\\\\dsh.ps1\",\"commandType\":\"ExternalScript\",\"powerShellPath\":\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\"}'\n",
    { mode: 0o755 },
  );
  await chmod(fakePowerShell, 0o755);
  const servicePath = `${root}:${process.env.PATH}`;
  const directService = resolveDirectWindowsService({
    serviceCommand: "dsh web --no-open",
    servicePath,
    nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
  }, { ...process.env, PATH: servicePath });

  assert.equal(directService.executable, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(directService.arguments.slice(0, 6), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
  ]);
  assert.equal(directService.arguments[6], String.raw`C:\Tools\dsh.ps1`);
  assert.deepEqual(directService.arguments.slice(7), ["web", "--no-open"]);
  assert.deepEqual(directService.warmupArguments.slice(-2), ["web", "--help"]);
});

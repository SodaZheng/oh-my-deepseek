import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  assert.deepEqual(directService.dshWebLaunch, {
    kind: "argv",
    prefixArguments: [resolvedExecutable],
    arguments: ["web", "--no-open"],
  });
  assert.deepEqual(directService.warmupArguments, [resolvedExecutable, "web", "--help"]);
});

test("login-shell output does not disable the DSH authentication proxy", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omd-noisy-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "dsh");
  const shell = path.join(root, "shell");
  await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  await writeFile(shell, '#!/bin/sh\nprintf "Welcome to WSL\\n"\n/bin/sh "$@"\nprintf "Shell startup notice\\n"\n', { mode: 0o755 });
  const config = { serviceCommand: "dsh web --no-open", serviceShell: shell, servicePath: `${root}:/usr/bin:/bin`, nodePath: process.execPath };
  const resolved = await resolveDirectPosixService(config);
  assert.equal(resolved.serviceKind, "dsh-web");
  assert.equal(resolved.executable, process.execPath);
  assert.equal(resolved.arguments[0], await realpath(executable));
  await assert.rejects(resolveDirectPosixService({ ...config, serviceCommand: "/missing/omd-fixture/dsh web --no-open" }), /无法.*解析 dsh/);
  assert.equal(await resolveDirectPosixService({ ...config, serviceCommand: "SOME_ENV=value dsh web" }), null);
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
  assert.deepEqual(directService.dshWebLaunch, {
    kind: "argv",
    prefixArguments: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", String.raw`C:\Tools\dsh.ps1`,
    ],
    arguments: ["web", "--no-open"],
  });
  assert.deepEqual(directService.warmupArguments.slice(-2), ["web", "--help"]);

  await writeFile(
    fakePowerShell,
    "#!/bin/sh\nprintf '%s' '{\"servicePath\":\"C:\\\\Tools\\\\dsh.cmd\",\"commandType\":\"Application\",\"powerShellPath\":\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\"}'\n",
    { mode: 0o755 },
  );
  const commandShim = resolveDirectWindowsService({
    serviceCommand: "dsh web --no-open",
    servicePath,
    nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
  }, { ...process.env, PATH: servicePath });
  assert.deepEqual(commandShim.dshWebLaunch, {
    kind: "powershell-command",
    prefixArguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
    commandPath: String.raw`C:\Tools\dsh.cmd`,
    arguments: ["web", "--no-open"],
  });
});

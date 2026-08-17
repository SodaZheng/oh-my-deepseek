import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWindowsLauncher } from "../src/platform/windows.mjs";
import { pathExists } from "../src/utils.mjs";

test("creates Windows support files and a desktop shortcut", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-test-"));
  const fakeChrome = path.join(root, "chrome.exe");
  const shortcutDirectory = path.join(root, "Desktop");
  await writeFile(fakeChrome, "test executable placeholder");

  const config = normalizeCreateOptions(
    { name: "Test Harness", output: shortcutDirectory, cwd: root },
    { platform: "win32", cwd: root },
  );
  config.homeDirectory = root;
  const result = await createWindowsLauncher(
    config,
    { executable: fakeChrome, icon: fakeChrome },
    { LOCALAPPDATA: path.join(root, "LocalAppData"), USERPROFILE: root },
  );

  assert.equal(await pathExists(result.shortcutPath), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.ps1")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "supervisor.mjs")), true);
  assert.equal((await readFile(path.join(result.supportDirectory, "launcher.ps1"), "utf8")).charCodeAt(0), 0xfeff);
  assert.match(
    await readFile(path.join(result.supportDirectory, "config.json"), "utf8"),
    /"generatedBy": "oh-my-deepseek"/,
  );

  const launcherPath = path.join(result.supportDirectory, "launcher.ps1");
  const parseCommand = `$Tokens = $null; $Errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${launcherPath.replaceAll("'", "''")}', [ref]$Tokens, [ref]$Errors) | Out-Null; if ($Errors.Count -gt 0) { $Errors | ForEach-Object { Write-Error $_ }; exit 1 }`;
  const parseResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", parseCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(parseResult.status, 0, parseResult.stderr || parseResult.stdout);
});

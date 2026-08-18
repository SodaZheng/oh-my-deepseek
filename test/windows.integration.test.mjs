import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWindowsLauncher } from "../src/platform/windows.mjs";
import { pathExists } from "../src/utils.mjs";
import { renderWindowsHiddenLauncher } from "../src/templates/windows.mjs";
import { renderWindowsHostBrowser } from "../src/templates/wsl.mjs";

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
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.ps1")), false);
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.js")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "supervisor.mjs")), true);
  const hiddenLauncher = await readFile(path.join(result.supportDirectory, "launcher.js"), "utf8");
  assert.notEqual(hiddenLauncher.charCodeAt(0), 0xfeff);
  assert.equal(/[^\x00-\x7f]/.test(hiddenLauncher), false);
  assert.doesNotMatch(hiddenLauncher, /powershell\.exe/i);
  assert.match(
    await readFile(path.join(result.supportDirectory, "config.json"), "utf8"),
    /"generatedBy": "oh-my-deepseek"/,
  );

  const browserHostPath = path.join(root, "browser-host.ps1");
  await writeFile(browserHostPath, renderWindowsHostBrowser());
  const paths = [browserHostPath].map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
  const parseCommand = `$Files = @(${paths}); foreach ($File in $Files) { $Tokens = $null; $Errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$Tokens, [ref]$Errors) | Out-Null; if ($Errors.Count -gt 0) { $Errors | ForEach-Object { Write-Error $_ }; exit 1 } }`;
  const parseResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", parseCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(parseResult.status, 0, parseResult.stderr || parseResult.stdout);

  const escapedShortcutPath = result.shortcutPath.replaceAll("'", "''");
  const shortcutCommand = `$Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut('${escapedShortcutPath}'); [Console]::WriteLine($Shortcut.TargetPath); [Console]::WriteLine($Shortcut.Arguments)`;
  const shortcutResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", shortcutCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(shortcutResult.status, 0, shortcutResult.stderr || shortcutResult.stdout);
  assert.match(shortcutResult.stdout, /wscript\.exe/i);
  assert.match(shortcutResult.stdout, /launcher\.js/i);

  const argumentProbePath = path.join(root, "argument probe.mjs");
  const argumentOutputPath = path.join(root, "argument probe.json");
  const argumentLauncherPath = path.join(root, "argument-launcher.js");
  await writeFile(
    argumentProbePath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argumentOutputPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const expectedArguments = [argumentProbePath, "--distribution", "Ubuntu Test", "--user", "soda", "--exec", "/usr/bin/node"];
  await writeFile(argumentLauncherPath, renderWindowsHiddenLauncher({
    programPath: process.execPath,
    programArguments: expectedArguments,
    missingTitle: "Missing Node",
    missingMessage: "Node missing",
  }));
  const argumentResult = spawnSync("cscript.exe", ["//B", "//NoLogo", argumentLauncherPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(argumentResult.status, 0, argumentResult.stderr || argumentResult.stdout);
  assert.deepEqual(JSON.parse(await readFile(argumentOutputPath, "utf8")), expectedArguments.slice(1));
});

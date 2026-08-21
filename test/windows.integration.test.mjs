import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWindowsLauncher } from "../src/platform/windows.mjs";
import { pathExists } from "../src/utils.mjs";
import { renderWindowsHiddenLauncher, renderWindowsNativeLauncherSource, renderWindowsPwaMonitorSource } from "../src/templates/windows.mjs";
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
  assert.equal(await pathExists(path.join(result.supportDirectory, "window-state.ps1")), true);
  assert.equal(result.restartPersistence, "shortcut-on-disk");
  const hiddenLauncher = await readFile(path.join(result.supportDirectory, "launcher.js"), "utf8");
  assert.notEqual(hiddenLauncher.charCodeAt(0), 0xfeff);
  assert.equal(/[^\x00-\x7f]/.test(hiddenLauncher), false);
  assert.doesNotMatch(hiddenLauncher, /powershell\.exe/i);
  const storedConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "config.json"), "utf8"));
  assert.equal(storedConfig.generatedBy, "oh-my-deepseek");
  assert.equal(storedConfig.windowStateScriptPath, path.join(result.supportDirectory, "window-state.ps1"));
  assert.match(storedConfig.windowBoundsPath, /window-size\.json$/);

  const browserHostPath = path.join(root, "browser-host.ps1");
  await writeFile(browserHostPath, renderWindowsHostBrowser());
  const shortcutScriptPath = path.join(result.supportDirectory, "create-shortcut.ps1");
  const windowStateScriptPath = path.join(result.supportDirectory, "window-state.ps1");
  const paths = [browserHostPath, shortcutScriptPath, windowStateScriptPath].map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
  const parseCommand = `$Files = @(${paths}); foreach ($File in $Files) { $Tokens = $null; $Errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$Tokens, [ref]$Errors) | Out-Null; if ($Errors.Count -gt 0) { $Errors | ForEach-Object { Write-Error $_ }; exit 1 } }`;
  const parseResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", parseCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(parseResult.status, 0, parseResult.stderr || parseResult.stdout);
  const windowStateCompileResult = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowStateScriptPath,
      "-ChromeProcessId", "1",
      "-BoundsPath", path.join(root, "window-size.json"),
      "-ReadyPath", path.join(root, "window-state.ready"),
      "-CompileOnly",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(windowStateCompileResult.status, 0, windowStateCompileResult.stderr || windowStateCompileResult.stdout);
  const browserConfigPath = path.join(root, "browser-config.json");
  await writeFile(browserConfigPath, JSON.stringify({
    launchMode: "url-app",
    chromePath: fakeChrome,
    chromeProfilePath: path.join(root, "profile"),
    browserPidPath: path.join(root, "browser.pid"),
    lastErrorPath: path.join(root, "browser-error.txt"),
    appUserModelId: "OpenAI.OhMyDeepSeek.TestHarness",
  }));
  const browserHostCompileResult = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", browserHostPath, "-ConfigPath", browserConfigPath, "-Mode", "Stop"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(browserHostCompileResult.status, 0, browserHostCompileResult.stderr || browserHostCompileResult.stdout);

  const escapedShortcutPath = result.shortcutPath.replaceAll("'", "''");
  const shortcutCommand = `$Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut('${escapedShortcutPath}'); [Console]::WriteLine($Shortcut.TargetPath); [Console]::WriteLine($Shortcut.Arguments)`;
  const shortcutResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", shortcutCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(shortcutResult.status, 0, shortcutResult.stderr || shortcutResult.stdout);
  assert.match(shortcutResult.stdout, /wscript\.exe/i);
  assert.match(shortcutResult.stdout, /launcher\.js/i);

  const appUserModelId = "OpenAI.OhMyDeepSeek.TestHarness";
  const identityResult = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", shortcutScriptPath,
      "-ShortcutPath", result.shortcutPath,
      "-LauncherPath", path.join(result.supportDirectory, "launcher.js"),
      "-WorkingDirectory", result.supportDirectory,
      "-IconPath", fakeChrome,
      "-Description", "Taskbar identity test",
      "-AppUserModelId", appUserModelId,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(identityResult.status, 0, identityResult.stderr || identityResult.stdout);
  const shortcutFolder = path.dirname(result.shortcutPath).replaceAll("'", "''");
  const shortcutName = path.basename(result.shortcutPath).replaceAll("'", "''");
  const propertyCommand = `$Folder = (New-Object -ComObject Shell.Application).Namespace('${shortcutFolder}'); $Item = $Folder.ParseName('${shortcutName}'); [Console]::Write([string]$Item.ExtendedProperty('System.AppUserModel.ID'))`;
  const propertyResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", propertyCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(propertyResult.status, 0, propertyResult.stderr || propertyResult.stdout);
  assert.equal(
    propertyResult.stdout.trim(),
    appUserModelId,
    "the shortcut property store was updated in memory but not persisted to the .lnk file",
  );

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
    waitForExit: true,
  }));
  const argumentResult = spawnSync("cscript.exe", ["//B", "//NoLogo", argumentLauncherPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(argumentResult.status, 0, argumentResult.stderr || argumentResult.stdout);
  assert.deepEqual(JSON.parse(await readFile(argumentOutputPath, "utf8")), expectedArguments.slice(1));

  const detachedProbePath = path.join(root, "detached probe.mjs");
  const detachedMarkerPath = path.join(root, "detached marker.txt");
  const detachedLauncherPath = path.join(root, "detached-launcher.js");
  await writeFile(
    detachedProbePath,
    `import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(${JSON.stringify(detachedMarkerPath)}, "continued"), 1500);\n`,
  );
  await writeFile(detachedLauncherPath, renderWindowsHiddenLauncher({
    programPath: process.execPath,
    programArguments: [detachedProbePath],
    missingTitle: "Missing Node",
    missingMessage: "Node missing",
  }));
  const detachedResult = spawnSync("cscript.exe", ["//B", "//NoLogo", detachedLauncherPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(detachedResult.status, 0, detachedResult.stderr || detachedResult.stdout);
  assert.equal(await pathExists(detachedMarkerPath), false, "WScript waited for the child process instead of exiting immediately");
  const detachedDeadline = Date.now() + 5000;
  while (!(await pathExists(detachedMarkerPath)) && Date.now() < detachedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await pathExists(detachedMarkerPath), true, "child process stopped when WScript exited");

  const nativeProbePath = path.join(root, "native probe.mjs");
  const nativeOutputPath = path.join(root, "native probe.json");
  const nativeSourcePath = path.join(root, "native-launcher.cs");
  const nativeLauncherPath = path.join(root, "native-launcher.exe");
  await writeFile(nativeProbePath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(nativeOutputPath)}, JSON.stringify(process.argv.slice(2)));\n`);
  const nativeArguments = [nativeProbePath, "--distribution", "Ubuntu Test", "--exec", "/usr/bin/node"];
  await writeFile(nativeSourcePath, renderWindowsNativeLauncherSource({
    programPath: process.execPath,
    programArguments: nativeArguments,
    appUserModelId: "OpenAI.OhMyDeepSeek.NativeProbe",
    missingTitle: "Missing Node",
    missingMessage: "Node missing",
  }));
  const nativeCompile = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", `Add-Type -Path '${nativeSourcePath.replaceAll("'", "''")}' -OutputAssembly '${nativeLauncherPath.replaceAll("'", "''")}' -OutputType WindowsApplication`],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(nativeCompile.status, 0, nativeCompile.stderr || nativeCompile.stdout);
  const nativeResult = spawnSync(nativeLauncherPath, [], { encoding: "utf8", windowsHide: true });
  assert.equal(nativeResult.status, 0, nativeResult.stderr || nativeResult.stdout);
  const nativeDeadline = Date.now() + 5000;
  while (!(await pathExists(nativeOutputPath)) && Date.now() < nativeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(JSON.parse(await readFile(nativeOutputPath, "utf8")), nativeArguments.slice(1));

  const monitorSourcePath = path.join(root, "pwa-monitor.cs");
  const monitorExecutablePath = path.join(root, "pwa-monitor.exe");
  await writeFile(monitorSourcePath, renderWindowsPwaMonitorSource({
    appUserModelId: "Chrome._crx_test",
    launcherPath: nativeLauncherPath,
    windowHandlePath: path.join(root, "app-window.txt"),
    monitorId: "native-test",
  }));
  const monitorCompile = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", `Add-Type -Path '${monitorSourcePath.replaceAll("'", "''")}' -OutputAssembly '${monitorExecutablePath.replaceAll("'", "''")}' -OutputType WindowsApplication`],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(monitorCompile.status, 0, monitorCompile.stderr || monitorCompile.stdout);
});

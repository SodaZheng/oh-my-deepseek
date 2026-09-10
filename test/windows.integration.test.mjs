import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWindowsLauncher } from "../src/platform/windows.mjs";
import { resolveDirectWindowsService } from "../src/service-command.mjs";
import { pathExists } from "../src/utils.mjs";
import { renderWindowsHiddenLauncher, renderWindowsNativeLauncherSource, renderWindowsPwaMonitorSource } from "../src/templates/windows.mjs";

test("creates Windows support files and a desktop shortcut", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-test-"));
  const fakeChrome = path.join(root, "chrome.exe");
  const fakeDsh = path.join(root, "dsh.ps1");
  const shortcutDirectory = path.join(root, "Desktop");
  await writeFile(fakeChrome, "test executable placeholder");
  await writeFile(fakeDsh, "exit 0\n");
  const testEnvironment = {
    ...process.env,
    LOCALAPPDATA: path.join(root, "LocalAppData"),
    USERPROFILE: root,
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
  };

  const config = normalizeCreateOptions(
    { name: "Test Harness", output: shortcutDirectory, cwd: root },
    { platform: "win32", cwd: root, env: testEnvironment },
  );
  config.homeDirectory = root;
  const result = await createWindowsLauncher(
    config,
    { executable: fakeChrome, icon: fakeChrome },
    testEnvironment,
  );

  assert.equal(result.replacedExisting, false);
  assert.equal(await pathExists(result.shortcutPath), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.ps1")), false);
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.js")), false);
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.exe")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "launcher.cs")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "supervisor.mjs")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "window-state.ps1")), false);
  assert.equal(await pathExists(path.join(result.supportDirectory, "browser-host.ps1")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "browser-config.json")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "loading-proxy.mjs")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "loading-config.json")), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "loading-whale.png")), true);
  assert.deepEqual(
    await readFile(path.join(result.supportDirectory, "loading-whale.png")),
    await readFile(path.resolve("assets/windows-icon-master-v2.png")),
  );
  assert.equal(result.restartPersistence, "shortcut-on-disk");
  const nativeLauncher = await readFile(path.join(result.supportDirectory, "launcher.cs"), "utf8");
  assert.match(nativeLauncher, /OhMyDeepSeekLauncher/);
  assert.match(nativeLauncher, /CreateNoWindow = true/);
  assert.doesNotMatch(nativeLauncher, /Application\.Run|DwmFlush|CreateTransparentWhale/);
  const storedConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "config.json"), "utf8"));
  assert.equal(storedConfig.generatedBy, "oh-my-deepseek");
  assert.equal(storedConfig.launchMode, "windows-host-browser");
  assert.equal(storedConfig.hostBrowserScriptPath, path.join(result.supportDirectory, "browser-host.ps1"));
  assert.equal(storedConfig.directService.serviceKind, "loading-proxy");
  assert.equal(result.residentMonitor, false);
  assert.equal(result.windowGate, true);
  assert.equal(result.instantLoading, false);
  assert.equal(result.loadingRenderer, "chrome-html");
  assert.equal(result.usesLoadingScreen, true);
  const generatedBrowserConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "browser-config.json"), "utf8"));
  assert.equal(generatedBrowserConfig.loadingMode, true);
  assert.equal(generatedBrowserConfig.loadingBoundsPath, undefined);
  assert.equal(generatedBrowserConfig.launcherHandoffPath, undefined);
  const generatedLoadingConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "loading-config.json"), "utf8"));
  assert.equal(generatedLoadingConfig.platform, "win32");
  assert.equal(generatedLoadingConfig.minimumLoadingMilliseconds, 0);
  assert.equal(storedConfig.hostBrowserTimingPath, generatedBrowserConfig.startupTimingPath);
  assert.equal(generatedLoadingConfig.directService.serviceKind, "dsh-web");

  const browserHostPath = path.join(result.supportDirectory, "browser-host.ps1");
  const shortcutScriptPath = path.join(result.supportDirectory, "create-shortcut.ps1");
  const paths = [browserHostPath, shortcutScriptPath].map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
  const parseCommand = `$Files = @(${paths}); foreach ($File in $Files) { $Tokens = $null; $Errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$Tokens, [ref]$Errors) | Out-Null; if ($Errors.Count -gt 0) { $Errors | ForEach-Object { Write-Error $_ }; exit 1 } }`;
  const parseResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", parseCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(parseResult.status, 0, parseResult.stderr || parseResult.stdout);
  const browserConfigPath = path.join(root, "browser-config.json");
  await writeFile(browserConfigPath, JSON.stringify({
    launchMode: "url-app",
    chromePath: fakeChrome,
    chromeProfilePath: path.join(root, "profile"),
    browserPidPath: path.join(root, "browser.pid"),
    windowHandlePath: path.join(root, "app-window.txt"),
    lastErrorPath: path.join(root, "browser-error.txt"),
    appUserModelId: "OpenAI.OhMyDeepSeek.TestHarness",
  }));
  const browserHostCompileResult = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", browserHostPath, "-ConfigPath", browserConfigPath, "-Mode", "Stop"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(browserHostCompileResult.status, 0, browserHostCompileResult.stderr || browserHostCompileResult.stdout);
  const nativeHostPath = path.join(result.supportDirectory, "browser-host.exe");
  const nativeHost = await readFile(nativeHostPath);
  const peHeader = nativeHost.readUInt32LE(0x3c);
  assert.equal(nativeHost.readUInt16LE(peHeader + 24 + 68), 2, "bridge must use the Windows GUI subsystem, not a console executable");
  const nativeHostResult = spawnSync(nativeHostPath, ["-Mode", "Stop"], { encoding: "utf8", windowsHide: true });
  assert.equal(nativeHostResult.status, 0, nativeHostResult.stderr || nativeHostResult.stdout);
  const interopDll = path.join(result.supportDirectory, "window-interop.dll").replaceAll("'", "''");
  const boundsProbe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -Path '${interopDll}'; Add-Type -AssemblyName System.Windows.Forms; $Work=[System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea; [Console]::Write((@{ bounds=[OmdChromeWindow]::GetStartupBounds(800,600); work=@($Work.X,$Work.Y,$Work.Width,$Work.Height) } | ConvertTo-Json -Compress))`,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(boundsProbe.status, 0, boundsProbe.stderr);
  const { bounds, work } = JSON.parse(boundsProbe.stdout);
  const expectedWidth = Math.min(800, work[2]);
  const expectedHeight = Math.min(600, work[3]);
  assert.deepEqual(bounds, [work[0] + Math.floor((work[2] - expectedWidth) / 2), work[1] + Math.floor((work[3] - expectedHeight) / 2), expectedWidth, expectedHeight]);

  const escapedShortcutPath = result.shortcutPath.replaceAll("'", "''");
  const shortcutCommand = `$Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut('${escapedShortcutPath}'); [Console]::WriteLine($Shortcut.TargetPath); [Console]::WriteLine($Shortcut.Arguments)`;
  const shortcutResult = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", shortcutCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(shortcutResult.status, 0, shortcutResult.stderr || shortcutResult.stdout);
  assert.match(shortcutResult.stdout, /launcher\.exe/i);
  assert.doesNotMatch(shortcutResult.stdout, /wscript\.exe/i);

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

  const staleSupportFile = path.join(result.supportDirectory, "stale-generated-file.txt");
  await writeFile(staleSupportFile, "old launcher payload");
  const recreated = await createWindowsLauncher(
    config,
    { executable: fakeChrome, icon: fakeChrome },
    testEnvironment,
  );
  assert.equal(recreated.replacedExisting, true);
  assert.equal(await pathExists(staleSupportFile), false);
});

test("Windows npm DSH shim resolves to Node without starting a PowerShell service", {skip:process.platform!=="win32"}, async () => {
  const {mkdir,rm}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(os.tmpdir(),'omd-node-shim-'));
  try{
    const packageRoot=path.join(root,'node_modules','@deepseek-ai','dsh');
    await mkdir(path.join(packageRoot,'lib'),{recursive:true});
    await writeFile(path.join(packageRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',bin:{dsh:'lib/bin.js'}}));
    const script=path.join(packageRoot,'lib','bin.js');
    await writeFile(script,'console.log(JSON.stringify(process.argv.slice(2)))');
    await writeFile(path.join(root,'dsh.ps1'),'#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args\n');
    const servicePath=root+path.delimiter+process.env.PATH;
    const direct=resolveDirectWindowsService({serviceCommand:'dsh web --no-open',servicePath,nodePath:process.execPath});
    assert.equal(direct.executable,process.execPath);
    assert.deepEqual(direct.arguments,[script,'web','--no-open']);
    const result=spawnSync(direct.executable,direct.arguments,{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),['web','--no-open']);
  }finally{await rm(root,{recursive:true,force:true});}
});

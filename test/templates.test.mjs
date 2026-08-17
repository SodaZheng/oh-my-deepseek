import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { renderMacInfoPlist, renderMacLauncher } from "../src/templates/macos.mjs";
import { renderSupervisor } from "../src/templates/supervisor.mjs";
import { renderWindowsLauncher, renderWindowsShortcutScript } from "../src/templates/windows.mjs";
import { renderWindowsHostBrowser, renderWslWindowsLauncher } from "../src/templates/wsl.mjs";

const macConfig = normalizeCreateOptions(
  { name: "Agent & Tools", command: "npm run dev", url: "http://localhost:5173" },
  { platform: "darwin", cwd: "/tmp/project with spaces" },
);

test("macOS templates preserve config and escape plist values", () => {
  const plist = renderMacInfoPlist(macConfig);
  const launcher = renderMacLauncher(macConfig);
  const supervisor = renderSupervisor();
  assert.match(plist, /Agent &amp; Tools/);
  assert.match(plist, /OMDGeneratedBy/);
  assert.doesNotMatch(plist, /LSUIElement/);
  assert.match(launcher, /supervisor\.mjs/);
  assert.doesNotMatch(launcher, /Terminal/);
  assert.match(supervisor, /--user-data-dir=/);
  assert.match(supervisor, /DevToolsActivePort/);
  assert.match(supervisor, /stopProcessTree/);
});

test("Windows templates run a hidden lifecycle supervisor", () => {
  const config = normalizeCreateOptions(
    { name: "Agent", command: "dsh web", url: "http://127.0.0.1:3080" },
    { platform: "win32", cwd: "C:\\project" },
  );
  const launcher = renderWindowsLauncher(config);
  const supervisor = renderSupervisor();
  const shortcut = renderWindowsShortcutScript();
  assert.match(launcher, /supervisor\.mjs/);
  assert.doesNotMatch(launcher, /WindowStyle Normal/);
  assert.match(supervisor, /powershell\.exe/);
  assert.match(supervisor, /taskkill\.exe/);
  assert.match(shortcut, /WindowStyle Hidden/);
  assert.match(shortcut, /CreateShortcut/);
});

test("WSL templates keep service ownership in Linux and browser ownership in Windows", () => {
  const launcher = renderWslWindowsLauncher();
  const browserHost = renderWindowsHostBrowser();
  const supervisor = renderSupervisor();
  assert.match(launcher, /wsl\.exe/);
  assert.match(launcher, /--distribution/);
  assert.match(launcher, /--exec/);
  assert.match(browserHost, /DevToolsActivePort/);
  assert.match(browserHost, /Get-TargetSnapshot/);
  assert.match(browserHost, /taskkill\.exe/);
  assert.match(supervisor, /windows-host-browser/);
  assert.match(supervisor, /serviceShell/);
});

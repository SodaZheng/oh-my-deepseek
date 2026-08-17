import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createWslLauncher } from "../src/platform/wsl.mjs";
import { pathExists } from "../src/utils.mjs";

test("creates a Windows shortcut payload while keeping the supervisor in WSL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-wsl-test-"));
  const home = path.join(root, "home");
  const project = path.join(home, "project");
  const icon = path.join(root, "icon.ico");
  await mkdir(project, { recursive: true });
  await writeFile(icon, "icon");

  const config = normalizeCreateOptions(
    { name: "WSL Harness", cwd: project },
    {
      platform: "linux",
      cwd: project,
      env: { WSL_DISTRO_NAME: "Ubuntu-Test", USER: "tester", SHELL: "/bin/bash" },
    },
  );
  config.homeDirectory = home;
  const toLocalPath = (windowsPath) => {
    assert.match(windowsPath, /^[A-Z]:\\/i);
    return path.join(root, "windows", windowsPath[0].toLowerCase(), ...windowsPath.slice(3).split("\\"));
  };
  const interop = {
    getWindowsEnvironment() {
      return {
        localAppData: String.raw`C:\Users\tester\AppData\Local`,
        desktop: String.raw`C:\Users\tester\Desktop`,
      };
    },
    toWslPath: toLocalPath,
    toWindowsPath(value) {
      return String.raw`C:\Output` + value.replaceAll("/", "-");
    },
    createShortcut(options) {
      const target = toLocalPath(options.shortcutPath);
      writeFileSync(target, JSON.stringify(options));
    },
  };

  const result = await createWslLauncher(
    config,
    { executable: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, icon },
    interop,
  );
  const hostSupport = toLocalPath(result.hostSupportDirectory);
  const shortcut = toLocalPath(result.shortcutPath);
  assert.equal(await pathExists(shortcut), true);
  assert.equal(await pathExists(path.join(result.supportDirectory, "supervisor.mjs")), true);
  assert.equal(await pathExists(path.join(hostSupport, "browser-host.ps1")), true);
  assert.equal(await pathExists(path.join(hostSupport, "launcher.ps1")), true);
  const storedConfig = JSON.parse(await readFile(path.join(result.supportDirectory, "config.json"), "utf8"));
  assert.equal(storedConfig.platform, "wsl");
  assert.equal(storedConfig.launchMode, "windows-host-browser");
  assert.equal(storedConfig.serviceShell, "/bin/bash");
  const launchConfig = JSON.parse(await readFile(path.join(hostSupport, "wsl-launch.json"), "utf8"));
  assert.equal(launchConfig.distro, "Ubuntu-Test");
  assert.equal(launchConfig.user, "tester");
});

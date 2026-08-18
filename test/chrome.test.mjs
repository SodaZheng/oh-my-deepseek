import assert from "node:assert/strict";
import test from "node:test";
import { findChrome } from "../src/chrome.mjs";

test("WSL Chrome discovery preserves a single candidate path and validates it", async () => {
  const chromePath = String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`;
  let discoveryScript = "";
  const wslInterop = {
    runWindowsPowerShell(script) {
      discoveryScript = script;
      return { status: 0, stdout: chromePath, stderr: "" };
    },
    windowsFileExists(value) {
      assert.equal(value, chromePath);
      return true;
    },
    toWindowsPath() {
      throw new Error("unexpected path conversion");
    },
  };

  const chrome = await findChrome({ platform: "wsl" }, {}, wslInterop);

  assert.equal(chrome.executable, chromePath);
  assert.match(discoveryScript, /\$Candidates = @\(\s+@\(/);
  assert.match(discoveryScript, /\[Console\]::Write\(\$Candidates\[0\]\)/);
});

test("WSL Chrome discovery rejects a truncated PowerShell result", async () => {
  const wslInterop = {
    runWindowsPowerShell() {
      return { status: 0, stdout: "C", stderr: "" };
    },
    windowsFileExists() {
      throw new Error("a non-Windows path must be rejected before the file check");
    },
    toWindowsPath() {
      throw new Error("unexpected path conversion");
    },
  };

  await assert.rejects(
    findChrome({ platform: "wsl" }, {}, wslInterop),
    /Windows Chrome 自动探测结果无效：C/,
  );
});

test("WSL Chrome discovery rejects a missing executable before generation", async () => {
  const chromePath = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
  const wslInterop = {
    runWindowsPowerShell() {
      return { status: 0, stdout: chromePath, stderr: "" };
    },
    windowsFileExists(value) {
      assert.equal(value, chromePath);
      return false;
    },
    toWindowsPath() {
      throw new Error("unexpected path conversion");
    },
  };

  await assert.rejects(
    findChrome({ platform: "wsl" }, {}, wslInterop),
    /Windows Chrome 自动探测结果无效/,
  );
});

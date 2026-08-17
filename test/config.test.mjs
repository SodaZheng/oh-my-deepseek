import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";

test("normalizes the default DeepSeek Harness configuration", () => {
  const config = normalizeCreateOptions({}, { platform: "darwin", cwd: "/tmp/project" });
  assert.equal(config.name, "DeepSeek Harness");
  assert.equal(config.url, "http://127.0.0.1:3080/");
  assert.equal(config.readyHost, "127.0.0.1");
  assert.equal(config.readyPort, 3080);
  assert.equal(config.serviceCommand, "dsh web");
  assert.equal(config.workingDirectory, "/tmp/project");
  assert.equal(config.timeoutSeconds, 45);
});

test("derives default HTTP and HTTPS ports", () => {
  const http = normalizeCreateOptions({ url: "http://localhost/path" }, { platform: "darwin", cwd: "/tmp" });
  const https = normalizeCreateOptions({ url: "https://localhost/path" }, { platform: "win32", cwd: "C:\\work" });
  assert.equal(http.readyPort, 80);
  assert.equal(https.readyPort, 443);
});

test("rejects unsupported protocols and unsafe names", () => {
  assert.throws(
    () => normalizeCreateOptions({ url: "file:///tmp/index.html" }, { platform: "darwin", cwd: "/tmp" }),
    /仅支持/,
  );
  assert.throws(
    () => normalizeCreateOptions({ name: "bad/name" }, { platform: "darwin", cwd: "/tmp" }),
    /不能包含/,
  );
  assert.throws(
    () => normalizeCreateOptions({ icon: "/tmp/icon.png" }, { platform: "darwin", cwd: "/tmp" }),
    /\.icns/,
  );
});

test("detects WSL as a Windows desktop with a Linux service runtime", () => {
  const config = normalizeCreateOptions(
    { cwd: "/home/soda/project", chrome: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` },
    {
      platform: "linux",
      cwd: "/home/soda/project",
      env: { WSL_DISTRO_NAME: "Ubuntu-24.04", USER: "soda", SHELL: "/bin/bash" },
    },
  );
  assert.equal(config.platform, "wsl");
  assert.equal(config.wslDistro, "Ubuntu-24.04");
  assert.equal(config.wslUser, "soda");
  assert.equal(config.serviceShell, "/bin/bash");
  assert.equal(config.chrome, String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`);
});

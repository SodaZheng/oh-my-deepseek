import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCreateOptions } from "../src/config.mjs";
import { createMacLauncher } from "../src/platform/macos.mjs";

test("creates a signed self-contained macOS app and desktop shortcut", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-test-"));
  const fakeChrome = path.join(root, "chrome");
  const fakeIcon = path.join(root, "app.icns");
  await writeFile(fakeChrome, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(fakeChrome, 0o755);
  await writeFile(fakeIcon, "fake icon for codesign test");

  const config = normalizeCreateOptions(
    {
      name: "Test Harness",
      output: path.join(root, "Applications"),
      cwd: root,
    },
    { platform: "darwin", cwd: root },
  );
  config.homeDirectory = root;
  const result = await createMacLauncher(config, { executable: fakeChrome, icon: fakeIcon });

  const plist = await readFile(path.join(result.appPath, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /OMDGeneratedBy/);
  assert.equal(await readlink(result.desktopShortcut), result.appPath);
  assert.match(
    await readFile(path.join(result.appPath, "Contents", "Resources", "config.json"), "utf8"),
    /"generatedBy": "oh-my-deepseek"/,
  );
  assert.equal(await readFile(path.join(result.appPath, "Contents", "Resources", "supervisor.mjs"), "utf8").then(Boolean), true);
});

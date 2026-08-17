import { stat } from "node:fs/promises";
import { findChrome } from "./chrome.mjs";
import { createMacLauncher } from "./platform/macos.mjs";
import { createWindowsLauncher } from "./platform/windows.mjs";
import { pathExists } from "./utils.mjs";

export async function createLauncher(config) {
  if (!(await pathExists(config.workingDirectory))) {
    throw new Error(`工作目录不存在：${config.workingDirectory}`);
  }
  const workingDirectoryStat = await stat(config.workingDirectory);
  if (!workingDirectoryStat.isDirectory()) {
    throw new Error(`工作目录不是文件夹：${config.workingDirectory}`);
  }

  const chrome = await findChrome(config);
  if (config.platform === "darwin") return createMacLauncher(config, chrome);
  return createWindowsLauncher(config, chrome);
}

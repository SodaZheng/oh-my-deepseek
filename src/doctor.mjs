import { spawnSync } from "node:child_process";
import { findChrome } from "./chrome.mjs";

export async function runDoctor(config) {
  const checks = [];
  try {
    const chrome = await findChrome(config);
    checks.push({ name: "Google Chrome", ok: true, detail: chrome.executable });
  } catch (error) {
    checks.push({ name: "Google Chrome", ok: false, detail: error.message });
  }

  const commandCheck = checkServiceCommand(config);
  checks.push(commandCheck);
  checks.push({ name: "Node.js", ok: true, detail: process.version });
  return { platform: config.platform, checks, ok: checks.every((check) => check.ok) };
}

function checkServiceCommand(config) {
  const firstWord = config.serviceCommand.trim().split(/\s+/, 1)[0];
  let result;
  if (config.platform === "darwin") {
    const escaped = firstWord.replaceAll("'", `'"'"'`);
    result = spawnSync("/bin/zsh", ["-lic", `command -v '${escaped}'`], { encoding: "utf8" });
  } else {
    result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-Command", `(Get-Command '${firstWord.replaceAll("'", "''")}' -ErrorAction SilentlyContinue).Source`],
      { encoding: "utf8", windowsHide: true },
    );
  }
  const detail = (result.stdout || "").trim() || (result.stderr || "").trim() || `找不到命令：${firstWord}`;
  return { name: `服务命令 ${firstWord}`, ok: !result.error && result.status === 0 && Boolean(result.stdout.trim()), detail };
}

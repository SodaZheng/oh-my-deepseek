import { CONFIG_VERSION, GENERATED_BY, PACKAGE_VERSION } from "../constants.mjs";
import { shellQuote, xmlEscape } from "../utils.mjs";

export function renderMacInfoPlist(config, hasIcon = true) {
  const bundleId = `dev.ohmydeepseek.launcher.${config.instanceId}`;
  const iconEntry = hasIcon
    ? `  <key>CFBundleIconFile</key>
  <string>app.icns</string>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(config.name)}</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(config.name)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${PACKAGE_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${CONFIG_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>OMDConfigVersion</key>
  <integer>${CONFIG_VERSION}</integer>
  <key>OMDGeneratedBy</key>
  <string>${GENERATED_BY}</string>
${iconEntry}
</dict>
</plist>
`;
}

export function renderMacLauncher(config) {
  return `#!/bin/zsh

set -u

readonly app_name=${shellQuote(config.name)}
readonly node_path=${shellQuote(config.nodePath)}
readonly contents_dir="\${0:A:h:h}"
readonly supervisor="\${contents_dir}/Resources/supervisor.mjs"

if [[ ! -x "\${node_path}" ]]; then
  /usr/bin/osascript - "找不到 Node.js" "创建 \${app_name} 时使用的 Node.js 已被移动或删除：\${node_path}" <<'APPLESCRIPT' >/dev/null 2>&1
on run arguments
  display alert (item 1 of arguments) message (item 2 of arguments) as critical buttons {"好"} default button "好"
end run
APPLESCRIPT
  exit 1
fi

/usr/bin/nohup "\${node_path}" "\${supervisor}" >/dev/null 2>&1 &
exit 0
`;
}

export function renderMacChromeShimInfo({ config, appId, chromeVersion, chromeBundleVersion, appDataPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleName</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundleDisplayName</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundleExecutable</key><string>app_mode_loader</string>
  <key>CFBundleIdentifier</key><string>com.google.Chrome.app.${appId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundleShortVersionString</key><string>${xmlEscape(chromeVersion)}</string>
  <key>CFBundleVersion</key><string>${xmlEscape(chromeBundleVersion)}</string>
  <key>CrBundleIdentifier</key><string>com.google.Chrome</string>
  <key>CrBundleVersion</key><string>${xmlEscape(chromeVersion)}</string>
  <key>CrAppModeShortcutID</key><string>${appId}</string>
  <key>CrAppModeShortcutName</key><string>${xmlEscape(config.name)}</string>
  <key>CrAppModeShortcutURL</key><string>${xmlEscape(config.url)}</string>
  <key>CrAppModeUserDataDir</key><string>${xmlEscape(appDataPath)}</string>
  <key>CrAppModeIsAdhocSigned</key><true/>
  <key>LSHasLocalizedDisplayName</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppleScriptEnabled</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

export function renderMacMonitor() {
  return `import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, "monitor-config.json"), "utf8"));
let activeSupervisor = null;
let stopping = false;

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

writeLog("启动 macOS App 监视器");
await main();

async function main() {
  while (!stopping) {
    const appPids = findAppPids();
    if (appPids.length === 0) {
      await delay(100);
      continue;
    }

    if (await serviceIsReady()) {
      writeLog(\`检测到 App PID \${appPids.join(",")}；服务已由外部提供，不接管\`);
      await waitForAppProcessesToExit();
      continue;
    }

    writeLog(\`拦截冷启动 App PID \${appPids.join(",")}，准备服务\`);
    await terminateAppProcesses();
    if (stopping) break;
    await runSupervisor();
  }
}

function findAppPids() {
  const result = spawnSync("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) return [];
  const pids = [];
  for (const line of result.stdout.split("\\n")) {
    const match = line.match(/^\\s*(\\d+)\\s+(.+)$/);
    if (match && match[2].startsWith(config.appExecutablePath)) pids.push(Number(match[1]));
  }
  return pids;
}

async function terminateAppProcesses() {
  const deadline = Date.now() + 3000;
  let missingSince = null;
  while (!stopping && Date.now() < deadline) {
    const pids = findAppPids();
    if (pids.length === 0) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= 300) return;
    } else {
      missingSince = null;
      for (const pid of pids) {
        try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") writeLog(\`停止 App PID \${pid} 失败：\${error.message}\`); }
      }
    }
    await delay(50);
  }
  for (const pid of findAppPids()) {
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") writeLog(\`强制停止 App PID \${pid} 失败：\${error.message}\`); }
  }
  await delay(150);
}

async function runSupervisor() {
  appendFileSync(config.logPath, \`[\${new Date().toISOString()}] 监视器启动监督器\\n\`);
  const descriptor = openSync(config.logPath, "a", 0o600);
  activeSupervisor = spawn(config.nodePath, [config.supervisorPath], {
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  const exitCode = await new Promise((resolve) => {
    activeSupervisor.once("error", (error) => {
      writeLog(\`监督器进程错误：\${error.message}\`);
      resolve(1);
    });
    activeSupervisor.once("exit", (code) => resolve(code ?? 1));
  });
  activeSupervisor = null;
  writeLog(\`监督器已退出，状态码 \${exitCode}\`);
  await delay(250);
}

async function waitForAppProcessesToExit() {
  while (!stopping && findAppPids().length > 0) await delay(250);
}

async function serviceIsReady() {
  try {
    const response = await fetch(config.url, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return true;
    const html = await response.text();
    if (!html.includes("<title>DeepSeek Harness</title>")) return true;
    return html.includes("window.__DSH_BOOT__") && html.includes('"url":"/plugins/');
  } catch {
    return false;
  }
}

function stop() {
  stopping = true;
  if (activeSupervisor && activeSupervisor.exitCode === null) {
    try { activeSupervisor.kill("SIGTERM"); } catch {}
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeLog(message) {
  appendFileSync(config.logPath, \`[\${new Date().toISOString()}] [monitor] \${message}\\n\`);
}
`;
}

export function renderMacLaunchAgent({ label, programArguments, logPath }) {
  const argumentsXml = programArguments.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

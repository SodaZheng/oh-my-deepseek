export function renderSupervisor() {
  return `import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
const devToolsPortFile = path.join(config.chromeProfilePath, "DevToolsActivePort");
let serviceChild = null;
let chromeChild = null;
let ownsService = false;
let ownsLock = false;
let shuttingDown = false;
let serviceSpawnError = null;

mkdirSync(path.dirname(config.logPath), { recursive: true });
mkdirSync(config.chromeProfilePath, { recursive: true });
mkdirSync(path.dirname(config.lockPath), { recursive: true });

main().catch(async (error) => {
  writeLog(\`启动失败：\${error.stack || error.message || String(error)}\`);
  showError(\`\${config.name} 启动失败\`, \`\${error.message || String(error)}\\n\\n日志：\${config.logPath}\`);
  await shutdown(1);
});

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

async function main() {
  if (!acquireLock()) {
    await activateExistingApp();
    return;
  }
  writeLog("启动监督器");
  if (config.launchMode === "chrome-app-shim") {
    await runChromeAppShim();
    return;
  }
  let serviceReadyPromise;
  if (!(await serviceIsReady())) {
    serviceChild = startService();
    ownsService = true;
    serviceReadyPromise = waitForService();
  } else {
    writeLog("检测到已有服务；本次不会在退出时停止它");
    serviceReadyPromise = Promise.resolve(true);
  }

  chromeChild = startChrome(false);
  const [serviceReady] = await Promise.all([serviceReadyPromise, waitForChromeDevTools()]);
  if (!serviceReady) {
    const reason = serviceSpawnError?.message || \`服务未能在 \${config.timeoutSeconds} 秒内监听 \${config.readyHost}:\${config.readyPort}\`;
    throw new Error(reason);
  }
  if (ownsService) writeLog(\`服务已就绪，PID \${serviceChild.pid}\`);
  openChromeAppWindow();
  const targetId = await waitForChromeTarget();
  await closePrewarmTargets(targetId);
  writeLog(\`Chrome App 已打开，target \${targetId}\`);
  await waitForChromeTargetToClose(targetId);
  writeLog("检测到 Chrome App 已关闭");
  await shutdown(0);
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(config.lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(descriptor);
      ownsLock = true;
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const ownerPid = readLockPid();
      if (ownerPid && processIsAlive(ownerPid)) {
        writeLog(\`已有监督器 PID \${ownerPid}，忽略重复启动\`);
        return false;
      }
      rmSync(config.lockPath, { force: true });
    }
  }
  return false;
}

function readLockPid() {
  try {
    return Number(JSON.parse(readFileSync(config.lockPath, "utf8")).pid) || null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function activateExistingApp() {
  if (config.platform === "darwin" && config.chromeShimPath) {
    spawnSync("/usr/bin/open", [config.chromeShimPath], { stdio: "ignore" });
    return;
  }
  if (config.platform === "darwin" && config.runtimeBundleId) {
    spawnSync("/usr/bin/open", ["-b", config.runtimeBundleId], { stdio: "ignore" });
    return;
  }
  const targets = await readChromeTargets();
  const target = targets?.find(targetMatchesApp);
  const port = readDevToolsPort();
  if (!target || !port) return;
  try {
    await fetch(\`http://127.0.0.1:\${port}/json/activate/\${target.id}\`, { signal: AbortSignal.timeout(1000) });
  } catch {}
}

async function runChromeAppShim() {
  if (!(await serviceIsReady())) {
    serviceChild = startService();
    ownsService = true;
    if (!(await waitForService())) {
      const reason = serviceSpawnError?.message || \`服务未能在 \${config.timeoutSeconds} 秒内监听 \${config.readyHost}:\${config.readyPort}\`;
      throw new Error(reason);
    }
    writeLog(\`服务已就绪，PID \${serviceChild.pid}\`);
  } else {
    writeLog("检测到已有服务；本次不会在退出时停止它");
  }

  const opened = spawnSync("/usr/bin/open", [config.chromeShimPath], { encoding: "utf8" });
  if (opened.error || opened.status !== 0) throw new Error(\`无法打开 Chrome App Shim：\${opened.error?.message || opened.stderr || opened.stdout}\`);
  await waitForChromeShimLifecycle();
  writeLog("检测到 Chrome App Shim 已关闭");
  await shutdown(0);
}

async function waitForChromeShimLifecycle() {
  const startDeadline = Date.now() + config.timeoutSeconds * 1000;
  let seen = false;
  let missingSince = null;
  while (true) {
    const running = chromeShimIsRunning();
    if (running) {
      seen = true;
      missingSince = null;
    } else if (seen) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= 1500) return;
    } else if (Date.now() >= startDeadline) {
      throw new Error("Chrome App Shim 启动超时");
    }
    await delay(250);
  }
}

function chromeShimIsRunning() {
  const result = spawnSync("/bin/ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.split("\\n").some((line) => line.startsWith(config.chromeShimExecutablePath));
}

function startService() {
  appendFileSync(config.logPath, \`\\n[\${new Date().toISOString()}] 启动服务：\${config.serviceCommand}\\n\`);
  const descriptor = openSync(config.logPath, "a", 0o600);
  const child = config.platform === "win32"
    ? spawn("powershell.exe", ["-NoLogo", "-WindowStyle", "Hidden", "-Command", config.serviceCommand], {
        cwd: config.workingDirectory,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", descriptor, descriptor],
      })
    : spawn("/bin/zsh", ["-lic", config.serviceCommand], {
        cwd: config.workingDirectory,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", descriptor, descriptor],
      });
  closeSync(descriptor);
  child.once("error", (error) => {
    serviceSpawnError = error;
    writeLog(\`服务进程错误：\${error.message}\`);
  });
  return child;
}

async function waitForService() {
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await serviceIsReady()) return true;
    if (serviceSpawnError || serviceChild.exitCode !== null) return false;
    await delay(250);
  }
  return serviceIsReady();
}

function serviceIsReady() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: config.readyHost, port: config.readyPort });
    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function startChrome(openWindow) {
  rmSync(devToolsPortFile, { force: true });
  const launchMode = openWindow
    ? [\`--app=\${config.url}\`]
    : ["--app=data:text/html,Preparing%20Chrome%20Runtime", "--window-position=-10000,-10000", "--window-size=1,1"];
  const child = spawn(
    config.chromePath,
    [
      ...launchMode,
      \`--user-data-dir=\${config.chromeProfilePath}\`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      ...(config.chromeExtraArgs || []),
    ],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
  child.once("error", (error) => writeLog(\`Chrome 进程错误：\${error.message}\`));
  return child;
}

async function closePrewarmTargets(appTargetId) {
  const targets = await readChromeTargets();
  const port = readDevToolsPort();
  if (!targets || !port) return;
  for (const target of targets) {
    if (target.id === appTargetId || target.type !== "page" || !target.url.startsWith("data:text/html,Preparing")) continue;
    try {
      await fetch(\`http://127.0.0.1:\${port}/json/close/\${target.id}\`, { signal: AbortSignal.timeout(1000) });
    } catch {}
  }
}

function openChromeAppWindow() {
  const opener = spawn(
    config.chromePath,
    [
      \`--app=\${config.url}\`,
      \`--user-data-dir=\${config.chromeProfilePath}\`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(config.chromeExtraArgs || []),
    ],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
  opener.unref();
}

async function waitForChromeDevTools() {
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (chromeChild.exitCode !== null) throw new Error(\`Chrome 在初始化期间退出，状态码 \${chromeChild.exitCode}\`);
    const port = readDevToolsPort();
    if (port) {
      try {
        const response = await fetch(\`http://127.0.0.1:\${port}/json/version\`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return true;
      } catch {}
    }
    await delay(200);
  }
  throw new Error("Chrome 初始化超时");
}

async function waitForChromeTarget() {
  const deadline = Date.now() + Math.min(config.timeoutSeconds, 30) * 1000;
  while (Date.now() < deadline) {
    if (chromeChild.exitCode !== null) throw new Error(\`Chrome 在 App 窗口打开前退出，状态码 \${chromeChild.exitCode}\`);
    const targets = await readChromeTargets();
    const target = targets?.find(targetMatchesApp);
    if (target) return target.id;
    await delay(250);
  }
  throw new Error("无法确认 Chrome App 窗口已打开");
}

function targetMatchesApp(target) {
  if (target.type !== "page") return false;
  try {
    return new URL(target.url).origin === new URL(config.url).origin;
  } catch {
    return false;
  }
}

async function waitForChromeTargetToClose(targetId) {
  while (true) {
    if (chromeChild.exitCode !== null) return;
    const targets = await readChromeTargets();
    if (targets && !targets.some((target) => target.id === targetId)) return;
    await delay(500);
  }
}

async function readChromeTargets() {
  const port = readDevToolsPort();
  if (!port) return null;
  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/json/list\`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  } catch {
    return null;
  }
}

function readDevToolsPort() {
  try {
    const port = Number(readFileSync(devToolsPortFile, "utf8").split(/\\r?\\n/, 1)[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (chromeChild && chromeChild.exitCode === null) await stopProcessTree(chromeChild.pid, "Chrome");
  if (ownsService && serviceChild) await stopProcessTree(serviceChild.pid, "服务");
  releaseLock();
  writeLog(\`监督器退出，状态码 \${exitCode}\`);
  process.exitCode = exitCode;
}

async function stopProcessTree(pid, label) {
  if (!pid) return;
  writeLog(\`正在停止\${label}进程树，PID \${pid}\`);
  if (config.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/t"], { windowsHide: true, stdio: "ignore" });
    await delay(1000);
    if (processIsAlive(pid)) {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") writeLog(\`停止\${label}失败：\${error.message}\`);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && processGroupIsAlive(pid)) await delay(100);
  if (processGroupIsAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") writeLog(\`强制停止\${label}失败：\${error.message}\`);
    }
  }
}

function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  if (!ownsLock) return;
  const ownerPid = readLockPid();
  if (ownerPid === process.pid) rmSync(config.lockPath, { force: true });
  ownsLock = false;
}

function showError(title, message) {
  if (config.platform === "darwin") {
    const script = ["on run arguments", ' display alert (item 1 of arguments) message (item 2 of arguments) as critical buttons {"好"} default button "好"', "end run"].join("\\n");
    const alert = spawn("/usr/bin/osascript", ["-e", script, title, message], { detached: true, stdio: "ignore" });
    alert.unref();
    return;
  }
  const ps = \`Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(\${psQuote(message)}, \${psQuote(title)}, 'OK', 'Error') | Out-Null\`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const alert = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  alert.unref();
}

function psQuote(value) {
  return \`'\${String(value).replaceAll("'", "''")}'\`;
}

function writeLog(message) {
  try {
    appendFileSync(config.logPath, \`[\${new Date().toISOString()}] \${message}\\n\`);
  } catch {
    // A logging failure must not prevent process cleanup.
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
`;
}

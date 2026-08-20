export function renderSupervisor() {
  return `import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
let serviceStartedAt = null;
let windowStateChild = null;

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
  if (config.launchMode === "windows-host-browser") {
    await runWindowsHostBrowser();
    return;
  }
  let serviceReadyPromise;
  if (!(await serviceIsReady())) {
    serviceChild = startService();
    ownsService = true;
    serviceReadyPromise = waitForService();
  } else {
    writeLog("检测到已有服务；App 退出时仍会强制清理对应端口");
    serviceReadyPromise = Promise.resolve(true);
  }

  if (config.platform === "win32") {
    const serviceReady = await serviceReadyPromise;
    if (!serviceReady) {
      const reason = serviceSpawnError?.message || \`服务未能在 \${config.timeoutSeconds} 秒内提供可用页面：\${config.url}\`;
      throw new Error(reason);
    }
    if (ownsService) logOwnedServiceReady();
    chromeChild = startChrome(true);
    await waitForChromeDevTools();
    const targetId = await waitForChromeTarget();
    windowStateChild = await startWindowsWindowState();
    writeLog(\`Chrome App 已打开，target \${targetId}\`);
    await waitForChromeTargetToClose(targetId);
    writeLog("检测到 Chrome App 已关闭");
    await requireConfiguredPortReleased();
    await shutdown(0);
    return;
  }

  chromeChild = startChrome(false);
  const [serviceReady] = await Promise.all([serviceReadyPromise, waitForChromeDevTools()]);
  if (!serviceReady) {
    const reason = serviceSpawnError?.message || \`服务未能在 \${config.timeoutSeconds} 秒内提供可用页面：\${config.url}\`;
    throw new Error(reason);
  }
  if (ownsService) logOwnedServiceReady();
  openChromeAppWindow();
  const targetId = await waitForChromeTarget();
  await closePrewarmTargets(targetId);
  writeLog(\`Chrome App 已打开，target \${targetId}\`);
  await waitForChromeTargetToClose(targetId);
  writeLog("检测到 Chrome App 已关闭");
  await requireConfiguredPortReleased();
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
  if (config.launchMode === "windows-host-browser") {
    spawnSync(powerShellExecutable(), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", config.hostBrowserScriptPath,
      "-ConfigPath", config.hostBrowserConfigPath,
      "-Mode", "Activate",
    ], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    return;
  }
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

async function runWindowsHostBrowser() {
  let serviceReadyPromise;
  if (!(await serviceIsReady())) {
    serviceChild = startService();
    ownsService = true;
    serviceReadyPromise = waitForService();
  } else {
    writeLog("检测到已有服务；App 退出时仍会强制清理对应端口");
    serviceReadyPromise = Promise.resolve(true);
  }

  chromeChild = startWindowsBrowserBridge();
  const browserExitPromise = waitForChildExit(chromeChild).then(
    (code) => ({ code, error: null }),
    (error) => ({ code: 1, error }),
  );
  if (!(await serviceReadyPromise)) {
    stopWindowsBrowserBridge();
    const reason = serviceSpawnError?.message || \`服务未能在 \${config.timeoutSeconds} 秒内提供可用页面：\${config.url}\`;
    throw new Error(reason);
  }
  if (ownsService) logOwnedServiceReady();

  const browserResult = await browserExitPromise;
  if (browserResult.code !== 0) {
    let detail = "";
    try { detail = readFileSync(config.hostBrowserErrorPath, "utf8").trim(); } catch {}
    throw new Error(detail || browserResult.error?.message || \`Windows Chrome 桥接器退出，状态码 \${browserResult.code}\`);
  }
  writeLog("检测到 Windows Chrome App 已关闭");
  await requireConfiguredPortReleased();
  await shutdown(0);
}

function startWindowsBrowserBridge() {
  appendFileSync(config.logPath, \`[\${new Date().toISOString()}] 启动 Windows Chrome 桥接器\n\`);
  const descriptor = openSync(config.logPath, "a", 0o600);
  const child = spawn(powerShellExecutable(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", config.hostBrowserScriptPath,
    "-ConfigPath", config.hostBrowserConfigPath,
    "-Mode", "Run",
  ], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  return child;
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function stopWindowsBrowserBridge() {
  if (config.launchMode !== "windows-host-browser") return;
  spawnSync(powerShellExecutable(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", config.hostBrowserScriptPath,
    "-ConfigPath", config.hostBrowserConfigPath,
    "-Mode", "Stop",
  ], { windowsHide: true, stdio: "ignore", timeout: 5000 });
}

async function runChromeAppShim() {
  if (!(await serviceIsReady())) {
    serviceChild = startService();
    ownsService = true;
    if (!(await waitForService())) {
      const reason = serviceSpawnError?.message || \`服务未能在 \${config.timeoutSeconds} 秒内提供可用页面：\${config.url}\`;
      throw new Error(reason);
    }
    logOwnedServiceReady();
  } else {
    writeLog("检测到已有服务；App 退出时仍会强制清理对应端口");
  }

  const opened = spawnSync("/usr/bin/open", [config.chromeShimPath], { encoding: "utf8" });
  if (opened.error || opened.status !== 0) throw new Error(\`无法打开 Chrome App Shim：\${opened.error?.message || opened.stderr || opened.stdout}\`);
  await waitForChromeShimLifecycle();
  writeLog("检测到 Chrome App Shim 已关闭");
  await requireConfiguredPortReleased();
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

async function stopConfiguredPortListeners() {
  const port = Number(config.readyPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    writeLog(\`无法清理无效端口：\${config.readyPort}\`);
    return false;
  }

  const signaled = new Set();
  const gracefulDeadline = Date.now() + 2000;
  while (Date.now() < gracefulDeadline) {
    const pids = listeningPidsForPort(port);
    if (pids === null) {
      await delay(100);
      continue;
    }
    if (pids.length === 0) {
      if (await portStaysClosed(port, 300)) {
        writeLog(\`端口 \${port} 已释放\`);
        return true;
      }
      continue;
    }
    for (const pid of pids) {
      if (!signaled.has(pid)) {
        writeLog(\`正在停止端口 \${port} 的监听进程，PID \${pid}\`);
        signaled.add(pid);
      }
      terminatePortListener(pid, false, port);
    }
    await delay(100);
  }

  const forceSignaled = new Set();
  const forceDeadline = Date.now() + 3000;
  while (Date.now() < forceDeadline) {
    const pids = listeningPidsForPort(port);
    if (pids === null) {
      await delay(100);
      continue;
    }
    if (pids.length === 0) {
      if (await portStaysClosed(port, 300)) {
        writeLog(\`端口 \${port} 已强制释放\`);
        return true;
      }
      continue;
    }
    for (const pid of pids) {
      if (!forceSignaled.has(pid)) {
        writeLog(\`正在强制停止端口 \${port} 的监听进程，PID \${pid}\`);
        forceSignaled.add(pid);
      }
      terminatePortListener(pid, true, port);
    }
    await delay(100);
  }

  const remaining = listeningPidsForPort(port);
  writeLog(remaining === null
    ? \`端口 \${port} 未能确认已释放\`
    : \`端口 \${port} 未能释放\${remaining.length > 0 ? \`，仍有 PID \${remaining.join(",")}\` : ""}\`);
  return false;
}

async function requireConfiguredPortReleased() {
  if (await stopConfiguredPortListeners()) return;
  throw new Error(\`App 已关闭，但端口 \${config.readyPort} 未能释放，请查看日志\`);
}

function listeningPidsForPort(port) {
  if (config.platform === "win32") return listeningWindowsPidsForPort(port);
  if (config.platform === "wsl") return listeningLinuxPidsForPort(port);
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-t", \`-iTCP:\${port}\`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    writeLog(\`查询端口 \${port} 的监听进程失败：\${result.error?.message || result.stderr || result.stdout}\`);
    return null;
  }
  return parsePidLines(result.stdout);
}

function listeningWindowsPidsForPort(port) {
  const script = "$ErrorActionPreference = 'Stop'; Get-NetTCPConnection -State Listen -LocalPort " + port
    + " | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [Console]::Out.WriteLine([string]$_) }";
  const result = spawnSync(powerShellExecutable(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], { encoding: "utf8", windowsHide: true });
  if (!result.error && result.status === 0) return parsePidLines(result.stdout);

  const fallback = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
  if (fallback.error || fallback.status !== 0) {
    writeLog(\`查询端口 \${port} 的 Windows 监听进程失败：\${result.error?.message || result.stderr || fallback.error?.message || fallback.stderr}\`);
    return null;
  }
  const pids = [];
  for (const line of fallback.stdout.split(/\\r?\\n/)) {
    const fields = line.trim().split(/\\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP") continue;
    const portMatch = fields[1].match(/:(\\d+)$/);
    if (!portMatch || Number(portMatch[1]) !== port) continue;
    if (fields[3].toUpperCase() !== "LISTENING") continue;
    pids.push(fields.at(-1));
  }
  return parsePidLines(pids.join("\\n"));
}

function listeningLinuxPidsForPort(port) {
  const socketInodes = new Set();
  for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table;
    try { table = readFileSync(tablePath, "utf8"); } catch { continue; }
    for (const line of table.split(/\\r?\\n/).slice(1)) {
      const fields = line.trim().split(/\\s+/);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const localPort = Number.parseInt(fields[1]?.split(":").at(-1), 16);
      if (localPort === port && fields[9]) socketInodes.add(fields[9]);
    }
  }
  if (socketInodes.size === 0) return [];

  const pids = [];
  let processes;
  try { processes = readdirSync("/proc", { withFileTypes: true }); } catch (error) {
    writeLog(\`查询端口 \${port} 的 WSL 监听进程失败：\${error.message}\`);
    return null;
  }
  for (const entry of processes) {
    if (!entry.isDirectory() || !/^\\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid <= 1 || pid === process.pid) continue;
    let descriptors;
    try { descriptors = readdirSync(\`/proc/\${pid}/fd\`); } catch { continue; }
    for (const descriptor of descriptors) {
      let target;
      try { target = readlinkSync(\`/proc/\${pid}/fd/\${descriptor}\`); } catch { continue; }
      const match = target.match(/^socket:\\[(\\d+)\\]$/);
      if (match && socketInodes.has(match[1])) {
        pids.push(pid);
        break;
      }
    }
  }
  return [...new Set(pids)];
}

function parsePidLines(output) {
  return [...new Set(String(output)
    .split(/\\r?\\n/)
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid))];
}

function terminatePortListener(pid, force, port) {
  if (config.platform === "win32") {
    const argumentsList = ["/pid", String(pid), "/t"];
    if (force) argumentsList.push("/f");
    const result = spawnSync("taskkill.exe", argumentsList, { windowsHide: true, encoding: "utf8" });
    if (result.error || (result.status !== 0 && processIsAlive(pid))) {
      writeLog(\`\${force ? "强制" : ""}停止端口 \${port} 的 Windows 监听进程失败：\${result.error?.message || result.stderr || result.stdout}\`);
    }
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") writeLog(\`\${force ? "强制" : ""}停止端口 \${port} 的监听进程失败：\${error.message}\`);
  }
}

async function portStaysClosed(port, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const pids = listeningPidsForPort(port);
    if (pids === null || pids.length > 0) return false;
    await delay(50);
  }
  const pids = listeningPidsForPort(port);
  return pids !== null && pids.length === 0;
}

function startService() {
  serviceStartedAt = Date.now();
  appendFileSync(config.logPath, \`\\n[\${new Date().toISOString()}] 启动服务：\${config.serviceCommand}\\n\`);
  const descriptor = openSync(config.logPath, "a", 0o600);
  let child;
  if (config.platform === "win32") {
    child = spawn(powerShellExecutable(), ["-NoLogo", "-WindowStyle", "Hidden", "-Command", config.serviceCommand], {
      cwd: config.workingDirectory,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
    });
  } else if (config.platform === "wsl" && config.directService?.executable && existsSync(config.directService.executable)) {
    writeLog(\`直接执行服务入口：\${config.directService.executable}\`);
    child = spawn(config.directService.executable, config.directService.arguments, {
      cwd: config.workingDirectory,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
      env: {
        ...process.env,
        ...(config.directService.path ? { PATH: config.directService.path } : {}),
        ...(config.directService.nodeCompileCachePath && !process.env.NODE_COMPILE_CACHE
          ? { NODE_COMPILE_CACHE: config.directService.nodeCompileCachePath }
          : {}),
      },
    });
  } else {
    child = spawn(config.platform === "wsl" ? config.serviceShell : "/bin/zsh", ["-lic", config.serviceCommand], {
      cwd: config.workingDirectory,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
    });
  }
  closeSync(descriptor);
  child.once("error", (error) => {
    serviceSpawnError = error;
    writeLog(\`服务进程错误：\${error.message}\`);
  });
  return child;
}

function logOwnedServiceReady() {
  const elapsed = serviceStartedAt === null ? "未知" : \`\${((Date.now() - serviceStartedAt) / 1000).toFixed(1)} 秒\`;
  writeLog(\`服务完整就绪，PID \${serviceChild.pid}，冷启动用时 \${elapsed}\`);
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

async function startWindowsWindowState() {
  rmSync(config.windowStateReadyPath, { force: true });
  const descriptor = openSync(config.logPath, "a", 0o600);
  const child = spawn(powerShellExecutable(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", config.windowStateScriptPath,
    "-ChromeProcessId", String(chromeChild.pid),
    "-BoundsPath", config.windowBoundsPath,
    "-ReadyPath", config.windowStateReadyPath,
    "-TimeoutSeconds", String(Math.min(config.timeoutSeconds, 10)),
  ], {
    windowsHide: true,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  child.once("error", (error) => writeLog(\`Windows 窗口状态监视器错误：\${error.message}\`));
  const deadline = Date.now() + Math.min(config.timeoutSeconds, 10) * 1000;
  while (Date.now() < deadline) {
    if (existsSync(config.windowStateReadyPath)) return child;
    if (child.exitCode !== null) throw new Error(\`Windows 窗口状态监视器提前退出，状态码 \${child.exitCode}\`);
    await delay(100);
  }
  throw new Error("Windows 窗口状态监视器启动超时");
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

  if (chromeChild && chromeChild.exitCode === null) {
    stopWindowsBrowserBridge();
    await stopProcessTree(chromeChild.pid, config.platform === "wsl" ? "Windows Chrome 桥接器" : "Chrome");
  }
  if (windowStateChild && windowStateChild.exitCode === null) {
    await stopProcessTree(windowStateChild.pid, "Windows 窗口状态监视器");
  }
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
  const alert = spawn(powerShellExecutable(), ["-NoLogo", "-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  alert.unref();
}

function powerShellExecutable() {
  return config.platform === "wsl" && config.powerShellPath
    ? config.powerShellPath
    : "powershell.exe";
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

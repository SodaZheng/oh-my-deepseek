import {
  renderMacLoadingDocument,
  renderMacLoadingOverlayBody,
  renderMacLoadingOverlayHead,
} from "./macos-loading.mjs";

export function renderMacOnDemandHttpProxy() {
  const loadingDocument = JSON.stringify(renderMacLoadingDocument());
  const overlayHead = JSON.stringify(renderMacLoadingOverlayHead());
  const overlayBody = JSON.stringify(renderMacLoadingOverlayBody());
  return `import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const listenFd = Number(process.env.OMD_LISTEN_FD);
const loadingTemplate = ${loadingDocument};
const overlayHeadTemplate = ${overlayHead};
const overlayBodyTemplate = ${overlayBody};
const publicUrl = new URL(config.url);
const loadingIcon = readFileSync(config.loadingIconPath);
const loadingStartedAt = Date.now();
const sockets = new Set();
let serviceChild = null;
let serviceSpawnError = null;
let shuttingDown = false;
let backendPort = null;
let backendReady = false;
let serviceToken = null;
let readinessCookie = "";
let readinessSetCookie = [];
const earlyLaunchNonce = config.earlyLoading && config.launchUrlPath ? randomBytes(32).toString("hex") : null;
const earlyCookieName = "omd_launch_" + (publicUrl.port || "80");
let browserLoadingServed = false;
let handoffComplete = false;
let windowRevealedAt = null;
let firstFrameReady = false;
let startupFailure = null;

mkdirSync(path.dirname(config.logPath), { recursive: true });
rmSync(config.readyPath, { force: true });
rmSync(config.errorPath, { force: true });
if (config.launchUrlPath) rmSync(config.launchUrlPath, { force: true });

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

const proxy = http.createServer(handleRequest);
proxy.on("connection", trackSocket);
proxy.on("upgrade", handleUpgrade);
proxy.on("error", fail);
const listenOptions = Number.isInteger(listenFd) && listenFd >= 0
  ? { fd: listenFd, exclusive: false }
  : { host: config.readyHost, port: config.readyPort };
proxy.listen(listenOptions, () => void main());

async function main() {
  try {
    if (earlyLaunchNonce) {
      const launchUrl = new URL(config.url);
      launchUrl.searchParams.set("__omd_boot", earlyLaunchNonce);
      writeFileSync(config.launchUrlPath, launchUrl.href, { mode: 0o600 });
      writeLog("小鲸鱼启动页已就绪，正在并行启动服务");
    }
    if (config.directService?.serviceKind !== "dsh-web") {
      throw new Error("小鲸鱼 loading 按需模式当前要求服务命令为 dsh web");
    }
    backendPort = await reserveBackendPort();
    serviceChild = startService(backendPort);
    if (!(await waitForService(backendPort))) {
      throw serviceSpawnError || new Error(\`服务未能在 \${config.timeoutSeconds} 秒内完整就绪\`);
    }
    const minimumLoadingMilliseconds = Number(config.minimumLoadingMilliseconds) || 900;
    const remainingLoadingTime = minimumLoadingMilliseconds - (Date.now() - loadingStartedAt);
    if (!config.waitForWindowReveal && remainingLoadingTime > 0) await delay(remainingLoadingTime);
    backendReady = true;
    if (config.launchUrlPath && !earlyLaunchNonce) {
      const launchUrl = new URL(config.url);
      if (serviceToken) launchUrl.searchParams.set("token", serviceToken);
      writeFileSync(config.launchUrlPath, launchUrl.href, { mode: 0o600 });
    }
    writeFileSync(config.readyPath, String(Date.now()), { mode: 0o600 });
    writeLog(\`按需服务完整就绪，内部端口 \${backendPort}\`);
  } catch (error) {
    fail(error);
  }
}

function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", publicUrl);
  if (requestUrl.pathname === "/__omd_first_frame") {
    if (request.method === "POST") firstFrameReady = true;
    response.writeHead(firstFrameReady ? 204 : 503, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (earlyLaunchNonce && request.method === "GET" && requestUrl.pathname === publicUrl.pathname
    && requestUrl.searchParams.get("__omd_boot") === earlyLaunchNonce) {
    if (/Chrome\\\//i.test(String(request.headers["user-agent"] || ""))) browserLoadingServed = true;
    const html = personalize(loadingTemplate);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html),
      "cache-control": "no-store", "referrer-policy": "no-referrer",
      "set-cookie": earlyCookieName + "=" + earlyLaunchNonce + "; Path=/; HttpOnly; SameSite=Strict",
    });
    response.end(html);
    return;
  }
  if (requestUrl.pathname === "/__omd_window_visible" && request.method === "POST") {
    windowRevealedAt ||= Date.now();
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__omd_browser_ready") {
    const visible = !config.waitForWindowReveal || (windowRevealedAt !== null
      && Date.now() - windowRevealedAt >= (Number(config.minimumLoadingMilliseconds) || 900));
    const headers = { "cache-control": "no-store" };
    if (backendReady && earlyLaunchNonce && serviceToken) {
      const authorizedLaunch = String(request.headers.cookie || "").split(";").some((part) => part.trim() === earlyCookieName + "=" + earlyLaunchNonce);
      if (!authorizedLaunch) {
        response.writeHead(401, headers);
        response.end();
        return;
      }
      if (visible) headers["set-cookie"] = readinessSetCookie;
    }
    response.writeHead(backendReady && visible ? 204 : 503, headers);
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__omd_loading_icon") {
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": loadingIcon.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    response.end(loadingIcon);
    return;
  }
  if (requestUrl.pathname === "/__omd_ready") {
    response.writeHead(backendReady ? 204 : 503, {
      "cache-control": "no-store",
      ...(backendReady ? {} : { "retry-after": "0" }),
    });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__omd_handoff_complete" && request.method === "POST") {
    handoffComplete = true;
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__omd_handoff_ready") {
    response.writeHead(handoffComplete ? 204 : 503, { "cache-control": "no-store" });
    response.end();
    return;
  }

  const isDocument = request.method === "GET"
    && requestUrl.pathname === publicUrl.pathname
    && String(request.headers.accept || "").includes("text/html");
  const launchHandoff = requestUrl.searchParams.get("__omd_launch") === "1";
  // Let DSH exchange its own login token for its authority-bound session cookie.
  // Never attach the internal readiness cookie to unauthenticated browser requests.
  if (request.method === "GET" && requestUrl.pathname === "/" && requestUrl.searchParams.has("token") && backendPort) {
    proxyHttp(request, response, request.url, false);
    return;
  }
  const isChromeDocument = isDocument && /Chrome\\\//i.test(String(request.headers["user-agent"] || ""));
  const shouldServeBrowserLoading = isChromeDocument && !launchHandoff && !browserLoadingServed;
  if (shouldServeBrowserLoading) browserLoadingServed = true;
  if (isDocument && !launchHandoff && !startupFailure && (!backendReady || shouldServeBrowserLoading)) {
    const html = personalize(loadingTemplate);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
    });
    response.end(html);
    return;
  }
  if (!backendReady) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(startupFailure?.message || "DeepSeek Harness is starting");
    return;
  }

  let upstreamPath = request.url;
  if (isDocument && launchHandoff) {
    requestUrl.searchParams.delete("__omd_launch");
    upstreamPath = requestUrl.pathname + requestUrl.search;
  }
  // DSH combo assets use /plugins/??package/client.js&rev=...; even deleting
  // an absent URLSearchParams key reserializes and breaks that wire format.
  proxyHttp(request, response, upstreamPath, isDocument && launchHandoff);
}

function proxyHttp(request, response, upstreamPath, injectOverlay) {
  const headers = { ...request.headers, host: publicUrl.host };
  if (injectOverlay) headers["accept-encoding"] = "identity";
  const upstream = http.request({
    host: "127.0.0.1",
    port: backendPort,
    method: request.method,
    path: upstreamPath,
    headers,
  }, (upstreamResponse) => {
    const contentType = String(upstreamResponse.headers["content-type"] || "");
    if (!injectOverlay || !contentType.includes("text/html")) {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      return;
    }
    const chunks = [];
    upstreamResponse.on("data", (chunk) => chunks.push(chunk));
    upstreamResponse.on("end", () => {
      const html = injectLoadingOverlay(Buffer.concat(chunks).toString("utf8"));
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders["content-encoding"];
      delete responseHeaders["transfer-encoding"];
      responseHeaders["content-length"] = String(Buffer.byteLength(html));
      responseHeaders["cache-control"] = "no-store";
      response.writeHead(upstreamResponse.statusCode || 200, responseHeaders);
      response.end(html);
    });
  });
  trackSocket(upstream);
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(error.message);
  });
  request.pipe(upstream);
}

function handleUpgrade(request, client, head) {
  trackSocket(client);
  if (!backendReady || startupFailure) {
    client.end("HTTP/1.1 503 Service Unavailable\\r\\nConnection: close\\r\\n\\r\\n");
    return;
  }
  const backend = net.connect({ host: "127.0.0.1", port: backendPort }, () => {
    const rawHeaders = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = String(name).toLowerCase() === "host" ? publicUrl.host : request.rawHeaders[index + 1];
      rawHeaders.push(\`\${name}: \${value}\`);
    }
    backend.write(\`\${request.method} \${request.url} HTTP/\${request.httpVersion}\\r\\n\${rawHeaders.join("\\r\\n")}\\r\\n\\r\\n\`);
    if (head.length > 0) backend.write(head);
    client.pipe(backend);
    backend.pipe(client);
  });
  trackSocket(backend);
  backend.once("error", () => client.destroy());
}

function injectLoadingOverlay(html) {
  const head = personalize(overlayHeadTemplate);
  const body = personalize(overlayBodyTemplate);
  const withHead = html.includes("</head>") ? html.replace("</head>", head + "</head>") : head + html;
  return withHead.includes("</body>") ? withHead.replace("</body>", body + "</body>") : withHead + body;
}

function personalize(template) {
  return template
    .replaceAll("__OMD_APP_NAME__", escapeHtml(config.name || "DeepSeek Harness"))
    .replaceAll("__OMD_TIMEOUT_MS__", String((Number(config.timeoutSeconds) || 45) * 1000));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function trackSocket(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function startService(port) {
  const direct = config.directService;
  const launch = buildDshLaunch(direct, port);
  appendFileSync(config.logPath, \`\\n[\${new Date().toISOString()}] 按需启动服务：\${config.serviceCommand}（内部端口 \${port}）\\n\`);
  const child = spawn(launch.executable, launch.arguments, {
    cwd: config.workingDirectory,
    // Windows PowerShell can exit silently without running -File when detached
    // from a console. taskkill /t handles the Windows service tree on cleanup.
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(direct.path ? { PATH: direct.path } : {}),
      ...(direct.nodeCompileCachePath ? { NODE_COMPILE_CACHE: direct.nodeCompileCachePath } : {}),
    },
  });
  captureServiceOutput(child.stdout, port, true);
  captureServiceOutput(child.stderr, port, false);
  child.once("error", (error) => { serviceSpawnError = error; });
  child.once("exit", (code, signal) => {
    if (shuttingDown || backendReady) return;
    const status = code === null ? \`信号 \${signal}\` : \`退出码 \${code}（0x\${(code >>> 0).toString(16).padStart(8, "0")}）\`;
    serviceSpawnError ||= new Error(\`服务在完整就绪前退出：\${status}；入口：\${launch.executable}\`);
  });
  return child;
}

function captureServiceOutput(stream, port, readAnnouncement) {
  let pending = "";
  stream.setEncoding("utf8");
  const consume = (line) => {
    if (readAnnouncement && line.startsWith("dsh web: ")) {
      try {
        const announced = new URL(line.slice(9).split(/\\s/)[0]);
        if (announced.protocol === "http:" && announced.hostname === "127.0.0.1"
          && Number(announced.port) === port && announced.pathname === "/") {
          serviceToken = announced.searchParams.get("token") || null;
        }
      } catch {}
    }
    appendFileSync(config.logPath, line.replace(/([?&]token=)[^\\s)]+/g, "$1[redacted]"));
  };
  stream.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\\n")) >= 0) {
      consume(pending.slice(0, end + 1));
      pending = pending.slice(end + 1);
    }
  });
  stream.on("end", () => { if (pending) consume(pending); });
}

function buildDshLaunch(direct, port) {
  const logicalArguments = rewriteDshArguments(direct.dshWebLaunch?.arguments || direct.arguments, port);
  if (direct.dshWebLaunch?.kind === "argv") {
    return {
      executable: direct.executable,
      arguments: [...direct.dshWebLaunch.prefixArguments, ...logicalArguments],
    };
  }
  if (direct.dshWebLaunch?.kind === "powershell-command") {
    const invocation = [direct.dshWebLaunch.commandPath, ...logicalArguments].map(powerShellQuote).join(" ");
    return {
      executable: direct.executable,
      arguments: [...direct.dshWebLaunch.prefixArguments, \`& \${invocation}\`],
    };
  }
  return { executable: direct.executable, arguments: logicalArguments };
}

function powerShellQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function rewriteDshArguments(input, port) {
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const argument = String(input[index]);
    if (argument === "--port" || argument === "--host") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=") || argument.startsWith("--host=")) continue;
    output.push(argument);
  }
  output.push("--host", "127.0.0.1", "--port", String(port), "--trusted-host", publicUrl.host);
  return output;
}

async function waitForService(port) {
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  let consecutiveSuccesses = 0;
  while (Date.now() < deadline) {
    if (await serviceIsReady(port)) {
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses >= 2) return true;
    } else {
      consecutiveSuccesses = 0;
    }
    if (serviceSpawnError || serviceChild?.exitCode !== null) return false;
    await delay(100);
  }
  return false;
}

async function serviceIsReady(port) {
  try {
    if (serviceToken && !readinessCookie) {
      const login = await readBackendPage(port, "/?token=" + encodeURIComponent(serviceToken));
      if (login.status === 303 && login.headers.location === "/") {
        readinessSetCookie = login.headers["set-cookie"] || [];
        readinessCookie = readinessSetCookie.map((cookie) => cookie.split(";", 1)[0]).join("; ");
      }
    }
    const response = await readBackendPage(port, "/", readinessCookie);
    if (response.status < 200 || response.status >= 300) return false;
    const contentType = response.headers["content-type"] || "";
    if (!contentType.includes("text/html")) return true;
    const html = response.body;
    if (!html.includes("<title>DeepSeek Harness</title>")) return true;
    return dshBootManifestIsComplete(html);
  } catch {
    return false;
  }
}

function readBackendPage(port, requestPath, cookie = "") {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: "127.0.0.1", port, path: requestPath,
      headers: { host: publicUrl.host, "cache-control": "no-cache", ...(cookie ? { cookie } : {}) },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("DSH readiness request timed out")));
  });
}

function dshBootManifestIsComplete(html) {
  const markers = ["window.__DSH_BOOT__", 'globalThis["__DSH_BOOT__"]', "globalThis['__DSH_BOOT__']"];
  for (const marker of markers) {
    const markerOffset = html.indexOf(marker);
    if (markerOffset < 0) continue;
    const assignmentOffset = html.indexOf("=", markerOffset + marker.length);
    const scriptEndOffset = html.indexOf("</script>", assignmentOffset + 1);
    if (assignmentOffset < 0 || scriptEndOffset < 0) continue;
    try {
      const serialized = html.slice(assignmentOffset + 1, scriptEndOffset).trim().replace(/;\\s*$/, "");
      const manifest = JSON.parse(serialized);
      const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
      return entries.length > 0 && entries.every((entry) =>
        typeof entry?.id === "string" && entry.id.length > 0
        && typeof entry?.url === "string" && entry.url.startsWith("/plugins/"));
    } catch {
      return false;
    }
  }
  return false;
}

async function reserveBackendPort() {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    reservation.once("listening", resolve);
    reservation.once("error", reject);
  });
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => reservation.close(resolve));
  if (!port) throw new Error("无法分配 DSH 内部端口");
  return port;
}

function fail(error) {
  if (shuttingDown) return;
  const message = error?.stack || error?.message || String(error);
  writeLog(\`按需启动失败：\${message}\`);
  startupFailure = error instanceof Error ? error : new Error(String(error));
  try { writeFileSync(config.errorPath, startupFailure.message, { mode: 0o600 }); } catch {}
  void shutdown(1);
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  rmSync(config.readyPath, { force: true });
  if (config.launchUrlPath) rmSync(config.launchUrlPath, { force: true });
  for (const socket of sockets) socket.destroy();
  if (proxy.listening) await new Promise((resolve) => proxy.close(() => resolve()));
  if (serviceChild?.pid && serviceChild.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/pid", String(serviceChild.pid), "/t"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-serviceChild.pid, "SIGTERM"); } catch {}
    }
    const deadline = Date.now() + 2500;
    while (serviceChild.exitCode === null && Date.now() < deadline) await delay(50);
    if (serviceChild.exitCode === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/pid", String(serviceChild.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else {
        try { process.kill(-serviceChild.pid, "SIGKILL"); } catch {}
      }
    }
  }
  process.exit(exitCode);
}

function writeLog(message) {
  appendFileSync(config.logPath, \`[\${new Date().toISOString()}] [on-demand] \${message}\\n\`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
`;
}

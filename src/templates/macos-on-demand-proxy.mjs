import {
  renderMacLoadingDocument,
  renderMacLoadingOverlayBody,
  renderMacLoadingOverlayHead,
} from "./macos-loading.mjs";

export function renderMacOnDemandHttpProxy() {
  const loadingDocument = JSON.stringify(renderMacLoadingDocument());
  const overlayHead = JSON.stringify(renderMacLoadingOverlayHead());
  const overlayBody = JSON.stringify(renderMacLoadingOverlayBody());
  return `import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";

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
let browserLoadingServed = false;
let handoffComplete = false;
let startupFailure = null;

mkdirSync(path.dirname(config.logPath), { recursive: true });
rmSync(config.readyPath, { force: true });
rmSync(config.errorPath, { force: true });

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
    if (remainingLoadingTime > 0) await delay(remainingLoadingTime);
    backendReady = true;
    writeFileSync(config.readyPath, String(Date.now()), { mode: 0o600 });
    writeLog(\`按需服务完整就绪，内部端口 \${backendPort}\`);
  } catch (error) {
    fail(error);
  }
}

function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", publicUrl);
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

  requestUrl.searchParams.delete("__omd_launch");
  proxyHttp(request, response, requestUrl, isDocument && launchHandoff);
}

function proxyHttp(request, response, requestUrl, injectOverlay) {
  const headers = { ...request.headers, host: publicUrl.host };
  if (injectOverlay) headers["accept-encoding"] = "identity";
  const upstream = http.request({
    host: "127.0.0.1",
    port: backendPort,
    method: request.method,
    path: requestUrl.pathname + requestUrl.search,
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
  const descriptor = openSync(config.logPath, "a", 0o600);
  const child = spawn(launch.executable, launch.arguments, {
    cwd: config.workingDirectory,
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
    env: {
      ...process.env,
      ...(direct.path ? { PATH: direct.path } : {}),
      ...(direct.nodeCompileCachePath ? { NODE_COMPILE_CACHE: direct.nodeCompileCachePath } : {}),
    },
  });
  closeSync(descriptor);
  child.once("error", (error) => { serviceSpawnError = error; });
  return child;
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
    const response = await fetch(\`http://127.0.0.1:\${port}/\`, {
      headers: { "cache-control": "no-cache", host: publicUrl.host },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return true;
    const html = await response.text();
    if (!html.includes("<title>DeepSeek Harness</title>")) return true;
    return dshBootManifestIsComplete(html);
  } catch {
    return false;
  }
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

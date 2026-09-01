export function renderMacOnDemandActivatorSource() {
  return String.raw`#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <launch.h>
#import <errno.h>
#import <fcntl.h>
#import <signal.h>
#import <sys/wait.h>
#import <unistd.h>

static NSArray<NSRunningApplication *> *LiveApplications(NSString *bundleIdentifier) {
  NSMutableArray<NSRunningApplication *> *live = [NSMutableArray array];
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
    if (!application.isTerminated) [live addObject:application];
  }
  return live;
}

static void TerminateApplications(NSString *bundleIdentifier) {
  for (NSRunningApplication *application in LiveApplications(bundleIdentifier)) [application terminate];
}

static void ShowFailure(NSString *name, NSString *message) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp activateIgnoringOtherApps:YES];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"%@ 启动失败", name];
  alert.informativeText = message;
  alert.alertStyle = NSAlertStyleCritical;
  [alert addButtonWithTitle:@"好"];
  [alert runModal];
}

static void StopChild(pid_t child) {
  if (child <= 0) return;
  fprintf(stderr, "[on-demand-native] stopping child process group %d\n", child);
  if (kill(-child, SIGTERM) != 0) fprintf(stderr, "[on-demand-native] SIGTERM failed: %d\n", errno);
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
  while ([deadline timeIntervalSinceNow] > 0) {
    int status = 0;
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child || (result < 0 && errno == ECHILD)) return;
    usleep(50000);
  }
  kill(-child, SIGKILL);
  waitpid(child, NULL, 0);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *configPath = [NSString stringWithUTF8String:argv[1]];
    NSData *data = [NSData dataWithContentsOfFile:configPath];
    NSError *jsonError = nil;
    NSDictionary *config = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError] : nil;
    if (![config isKindOfClass:[NSDictionary class]] || jsonError) return 3;

    NSString *bundleIdentifier = config[@"appBundleIdentifier"];
    NSString *nodePath = config[@"nodePath"];
    NSString *proxyPath = config[@"proxyPath"];
    NSString *readyPath = config[@"readyPath"];
    NSString *errorPath = config[@"errorPath"];
    NSString *name = config[@"name"] ?: @"DeepSeek Harness";
    NSTimeInterval timeout = [config[@"timeoutSeconds"] doubleValue];
    if (timeout < 1) timeout = 45;

    [[NSFileManager defaultManager] removeItemAtPath:readyPath error:nil];
    [[NSFileManager defaultManager] removeItemAtPath:errorPath error:nil];

    int *sockets = NULL;
    size_t socketCount = 0;
    int activationError = launch_activate_socket("HttpListener", &sockets, &socketCount);
    if (activationError != 0 || socketCount == 0) {
      fprintf(stderr, "launch_activate_socket failed: %d\n", activationError);
      free(sockets);
      return 4;
    }
    int listener = sockets[0];
    for (size_t index = 1; index < socketCount; index += 1) close(sockets[index]);
    free(sockets);
    int descriptorFlags = fcntl(listener, F_GETFD);
    if (descriptorFlags >= 0) fcntl(listener, F_SETFD, descriptorFlags & ~FD_CLOEXEC);

    NSDate *findDeadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
    while (LiveApplications(bundleIdentifier).count == 0 && [findDeadline timeIntervalSinceNow] > 0) usleep(10000);
    fprintf(stderr, "[on-demand-native] target App kept visible; first request buffered until DSH readiness\n");

    pid_t child = fork();
    if (child == 0) {
      setpgid(0, 0);
      NSString *descriptor = [NSString stringWithFormat:@"%d", listener];
      setenv("OMD_LISTEN_FD", descriptor.UTF8String, 1);
      execl(nodePath.UTF8String, nodePath.UTF8String, proxyPath.UTF8String, configPath.UTF8String, NULL);
      _exit(127);
    }
    close(listener);
    if (child < 0) return 5;
    setpgid(child, child);
    fprintf(stderr, "[on-demand-native] started proxy PID %d\n", child);

    BOOL revealed = NO;
    BOOL failed = NO;
    NSString *failureMessage = nil;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    NSDate *missingSince = nil;
    while (revealed || [deadline timeIntervalSinceNow] > 0) {
      int status = 0;
      pid_t waitResult = waitpid(child, &status, WNOHANG);
      if (waitResult == child) {
        if (!revealed) {
          failed = YES;
          failureMessage = [NSString stringWithContentsOfFile:errorPath encoding:NSUTF8StringEncoding error:nil];
          if (failureMessage.length == 0) failureMessage = @"按需启动进程提前退出，请查看日志。";
        }
        child = 0;
        break;
      }

      NSArray<NSRunningApplication *> *applications = LiveApplications(bundleIdentifier);
      if (applications.count == 0) {
        if (!missingSince) missingSince = [NSDate date];
        if ([[NSDate date] timeIntervalSinceDate:missingSince] >= (revealed ? 1.5 : 0.3)) {
          fprintf(stderr, "[on-demand-native] target App closed\n");
          break;
        }
      } else {
        missingSince = nil;
      }

      if (!revealed && [[NSFileManager defaultManager] fileExistsAtPath:readyPath]) {
        fprintf(stderr, "[on-demand-native] stable readiness reached in the existing App window\n");
        revealed = YES;
      } else if (!revealed && [[NSFileManager defaultManager] fileExistsAtPath:errorPath]) {
        failed = YES;
        failureMessage = [NSString stringWithContentsOfFile:errorPath encoding:NSUTF8StringEncoding error:nil];
        break;
      }
      usleep(50000);
    }

    if (!revealed && !failed && LiveApplications(bundleIdentifier).count > 0) {
      failed = YES;
      failureMessage = @"等待 DSH 完整初始化超时，请查看日志。";
    }
    StopChild(child);
    [[NSFileManager defaultManager] removeItemAtPath:readyPath error:nil];
    if (failed) {
      TerminateApplications(bundleIdentifier);
      ShowFailure(name, failureMessage ?: @"未知错误");
      return 1;
    }
  }
  return 0;
}
`;
}

export function renderMacOnDemandProxy() {
  return `import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const listenFd = Number(process.env.OMD_LISTEN_FD);
let serviceChild = null;
let serviceSpawnError = null;
let shuttingDown = false;
let backendPort = null;
let resolveBackendReady;
let startupFailure = null;
let resolveFirstResponse;
const backendReady = new Promise((resolve) => { resolveBackendReady = resolve; });
const firstResponse = new Promise((resolve) => { resolveFirstResponse = resolve; });
const sockets = new Set();

mkdirSync(path.dirname(config.logPath), { recursive: true });
rmSync(config.readyPath, { force: true });
rmSync(config.errorPath, { force: true });

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

const proxy = net.createServer((client) => {
  sockets.add(client);
  client.once("close", () => sockets.delete(client));
  client.once("error", () => {});
  client.pause();
  backendReady.then(() => {
    if (client.destroyed || shuttingDown || startupFailure) {
      client.destroy();
      return;
    }
    const backend = net.connect({ host: "127.0.0.1", port: backendPort });
    sockets.add(backend);
    backend.once("close", () => sockets.delete(backend));
    backend.once("error", () => client.destroy());
    backend.once("data", () => resolveFirstResponse());
    client.pipe(backend);
    backend.pipe(client);
    client.resume();
  }, () => client.destroy());
});

proxy.on("error", fail);
proxy.listen({ fd: listenFd, exclusive: false }, () => void main());

async function main() {
  try {
    if (config.directService?.serviceKind !== "dsh-web") {
      throw new Error("macOS 零常驻按需模式当前要求服务命令为 dsh web");
    }
    backendPort = await reserveBackendPort();
    serviceChild = startService(backendPort);
    if (!(await waitForService(backendPort))) {
      throw serviceSpawnError || new Error(\`服务未能在 \${config.timeoutSeconds} 秒内完整就绪\`);
    }
    resolveBackendReady();
    await Promise.race([firstResponse, delay(2000)]);
    await delay(100);
    writeFileSync(config.readyPath, String(Date.now()), { mode: 0o600 });
    writeLog(\`按需服务完整就绪，内部端口 \${backendPort}\`);
  } catch (error) {
    fail(error);
  }
}

function startService(port) {
  const direct = config.directService;
  const argumentsList = rewriteDshArguments(direct.arguments, port);
  appendFileSync(config.logPath, \`\\n[\${new Date().toISOString()}] 按需启动服务：\${config.serviceCommand}（内部端口 \${port}）\\n\`);
  const descriptor = openSync(config.logPath, "a", 0o600);
  const child = spawn(direct.executable, argumentsList, {
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
  child.once("error", (error) => {
    serviceSpawnError = error;
  });
  return child;
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
  const publicAuthority = new URL(config.url).host;
  output.push("--host", "127.0.0.1", "--port", String(port), "--trusted-host", publicAuthority);
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
      headers: { "cache-control": "no-cache", host: new URL(config.url).host },
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
  try { writeFileSync(config.errorPath, error?.message || String(error), { mode: 0o600 }); } catch {}
  startupFailure = error instanceof Error ? error : new Error(String(error));
  resolveBackendReady();
  void shutdown(1);
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  rmSync(config.readyPath, { force: true });
  for (const socket of sockets) socket.destroy();
  if (proxy.listening) await new Promise((resolve) => proxy.close(() => resolve()));
  if (serviceChild?.pid && serviceChild.exitCode === null) {
    try { process.kill(-serviceChild.pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 2500;
    while (serviceChild.exitCode === null && Date.now() < deadline) await delay(50);
    if (serviceChild.exitCode === null) {
      try { process.kill(-serviceChild.pid, "SIGKILL"); } catch {}
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

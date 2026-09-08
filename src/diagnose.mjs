import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  diagnoseWslStartup(process.argv[2]).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}

// Inspect the installed artifacts, not a newly normalized create configuration.
// Do not dump environment variables, tokens, cookies, or entire profile files.
export async function diagnoseWslStartup(configPath) {
  const base = path.join(os.homedir(), ".local/share/oh-my-deepseek/apps");
  const paths = configPath ? [path.resolve(configPath)] : (await readdir(base))
    .filter((name) => !name.startsWith(".")).map((name) => path.join(base, name, "config.json"));
  const reports = [];
  for (const file of paths) {
    const config = await json(file);
    if (!config) continue;
    if (config.platform !== "wsl") throw new Error("diagnose 当前用于 WSL 生成的 config.json");
    const loadingPath = config.directService?.serviceKind === "loading-proxy"
      ? config.directService.arguments?.[1] : null;
    const loading = loadingPath ? await json(loadingPath) : null;
    const supervisor = await readFile(path.join(path.dirname(file), "supervisor.mjs"), "utf8").catch(() => "");
    const report = {
      configPath: file, configVersion: config.configVersion, launchMode: config.launchMode,
      serviceKind: config.directService?.serviceKind ?? "shell",
      serviceShell: config.serviceShell,
      serviceCommand: redact(config.serviceCommand ?? ""), url: redact(config.url),
      workingDirectoryExists: await exists(config.workingDirectory),
      serviceExecutable: config.directService?.executable,
      serviceExecutableExists: await exists(config.directService?.executable),
      loadingConfigExists: Boolean(loading),
      dshExecutable: loading?.directService?.executable,
      dshExecutableExists: await exists(loading?.directService?.executable),
      supervisorUsesProxyReadiness: config.directService?.serviceKind === "loading-proxy" && supervisor.includes('new URL("/__omd_ready", config.url)'),
      supervisorSupportsProxyReadiness: supervisor.includes('new URL("/__omd_ready", config.url)'),
      supervisorReportsServiceErrors: supervisor.includes("function serviceFailureReason"),
      launchUrlExists: await exists(config.launchUrlPath),
      serviceError: await readDiagnostic(config.serviceErrorPath || loading?.errorPath),
      browserError: await readDiagnostic(config.hostBrowserErrorPath),
      logPath: config.logPath, logTail: await readDiagnostic(config.logPath),
      probes: [],
    };
    const url = new URL(config.url);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      for (const route of ["/", "/__omd_ready"]) {
        const target = new URL(route, url);
        target.username = ""; target.password = "";
        try {
          const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(1500) });
          report.probes.push({ path: route, status: response.status });
          await response.body?.cancel();
        } catch (error) {
          report.probes.push({ path: route, error: error.cause?.code || error.name });
        }
      }
    }
    reports.push(report);
  }
  if (!reports.length) throw new Error("没有找到 WSL 启动配置；可用 --config 指定实际 config.json");
  return { node: process.version, reports };
}

function redact(value) {
  return String(value).replace(/([?&](?:token|__omd_boot)=)[^\s)"']+/g, "$1[redacted]");
}

async function json(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function exists(file) {
  if (!file) return false;
  return stat(file).then(() => true, () => false);
}

async function readDiagnostic(file) {
  if (!file) return null;
  try { return redact((await readFile(file, "utf8")).split(/\r?\n/).slice(-60).join("\n")).slice(-12000); }
  catch { return null; }
}

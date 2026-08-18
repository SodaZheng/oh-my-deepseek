import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "./constants.mjs";
import { assertSafeAppName, slugify, stableId } from "./utils.mjs";

export function normalizeCreateOptions(values, { platform = process.platform, cwd = process.cwd(), env = process.env } = {}) {
  const normalizedPlatform = platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP)
    ? "wsl"
    : platform;
  if (normalizedPlatform !== "darwin" && normalizedPlatform !== "win32" && normalizedPlatform !== "wsl") {
    throw new Error(`暂不支持 ${platform}；当前只支持 macOS、Windows 和 Windows 上的 WSL`);
  }

  const name = (values.name ?? DEFAULTS.name).trim();
  assertSafeAppName(name, normalizedPlatform === "wsl" ? "win32" : normalizedPlatform);

  const url = normalizeUrl(values.url ?? DEFAULTS.url);
  const serviceCommand = (values.command ?? DEFAULTS.serviceCommand).trim();
  if (!serviceCommand) throw new Error("服务启动命令不能为空");

  const timeoutSeconds = parsePositiveInteger(values.timeout ?? String(DEFAULTS.timeoutSeconds), "启动超时");
  if (timeoutSeconds > 600) throw new Error("启动超时不能超过 600 秒");

  const workingDirectory = path.resolve(values.cwd ?? cwd);
  const icon = values.icon ? path.resolve(values.icon) : null;
  if (icon) {
    const expectedExtension = normalizedPlatform === "darwin" ? ".icns" : ".ico";
    if (path.extname(icon).toLowerCase() !== expectedExtension) {
      throw new Error(`${normalizedPlatform === "darwin" ? "macOS" : "Windows"} 自定义图标必须是 ${expectedExtension} 文件`);
    }
  }
  const slug = slugify(name);
  const instanceIdentity = `${name}\0${url.href}\0${workingDirectory}`
    + (normalizedPlatform === "wsl" ? `\0${env.WSL_DISTRO_NAME ?? "unknown-wsl"}` : "");
  const instanceId = stableId(instanceIdentity, 16);

  return {
    platform: normalizedPlatform,
    name,
    url: url.href,
    readyHost: normalizeReadyHost(url.hostname),
    readyPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    serviceCommand,
    timeoutSeconds,
    workingDirectory,
    chrome: values.chrome
      ? normalizeChromePath(values.chrome, normalizedPlatform)
      : null,
    chromeAppId: values["chrome-app-id"] ?? null,
    icon,
    output: values.output ? path.resolve(values.output) : null,
    desktop: values["no-desktop"] !== true,
    force: values.force === true,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    slug,
    instanceId,
    homeDirectory: os.homedir(),
    nodePath: process.execPath,
    wslDistro: normalizedPlatform === "wsl" ? env.WSL_DISTRO_NAME ?? null : null,
    wslUser: normalizedPlatform === "wsl" ? env.USER ?? null : null,
    serviceShell: normalizedPlatform === "wsl" ? env.SHELL || "/bin/bash" : null,
    servicePath: normalizedPlatform === "wsl" ? env.PATH ?? null : null,
  };
}

function normalizeChromePath(value, platform) {
  if (platform === "wsl" && (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\"))) {
    return value;
  }
  return path.resolve(value);
}

function normalizeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 无效：${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL 仅支持 http:// 或 https://");
  }
  if (!url.hostname) throw new Error("URL 必须包含主机名");
  return url;
}

function normalizeReadyHost(hostname) {
  if (hostname === "[::1]" || hostname === "::1") return "::1";
  return hostname;
}

function parsePositiveInteger(raw, label) {
  if (!/^\d+$/.test(String(raw))) throw new Error(`${label}必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数`);
  return value;
}

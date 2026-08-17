import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(target) {
  try {
    await access(target, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(target) {
  await mkdir(target, { recursive: true });
}

export async function writeText(target, contents, mode = 0o644) {
  await ensureDirectory(path.dirname(target));
  await writeFile(target, contents, { encoding: "utf8", mode });
}

export async function readTextIfPresent(target) {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function stableId(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `app-${stableId(value, 8)}`;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function powershellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function assertSafeAppName(name, platform) {
  if (!name || !name.trim()) throw new Error("应用名称不能为空");
  if (/[\u0000-\u001f]/.test(name) || name.includes("/") || name.includes(":")) {
    throw new Error("应用名称不能包含 /、: 或控制字符");
  }
  if (platform === "win32" && /[<>"\\|?*]/.test(name)) {
    throw new Error('Windows 应用名称不能包含 < > " \\ | ? *');
  }
}

export async function removeExactTarget(target) {
  const stat = await lstat(target);
  await rm(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}

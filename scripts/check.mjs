import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["bin", "src", "scripts", "test"];
const files = [];

for (const root of roots) {
  await collectModules(path.resolve(root), files);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(1);
  }
}

process.stdout.write(`语法检查通过：${files.length} 个模块\n`);

async function collectModules(directory, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectModules(target, output);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) output.push(target);
  }
}

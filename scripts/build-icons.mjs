import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("build:icons 当前需要 macOS 自带的 sips");
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(projectRoot, "icon.icns");
const output = path.join(projectRoot, "icon.ico");
const sizes = [16, 32, 48, 64, 128, 256];
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "oh-my-deepseek-icons-"));

try {
  const images = [];
  for (const size of sizes) {
    const pngPath = path.join(temporaryDirectory, `${size}.png`);
    const result = spawnSync("/usr/bin/sips", ["-z", String(size), String(size), "-s", "format", "png", source, "--out", pngPath], {
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      throw new Error(`无法生成 ${size}×${size} PNG：${result.error?.message || result.stderr || result.stdout}`);
    }
    images.push({ size, data: await readFile(pngPath) });
  }
  await writeFile(output, createIco(images));
  process.stdout.write(`已生成 ${output}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function createIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize + entrySize * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = headerSize + index * entrySize;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

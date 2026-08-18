import { parseArgs } from "node:util";
import { normalizeCreateOptions } from "./config.mjs";
import { PACKAGE_VERSION } from "./constants.mjs";
import { createLauncher } from "./create.mjs";
import { runDoctor } from "./doctor.mjs";

const OPTION_DEFINITIONS = {
  name: { type: "string", short: "n" },
  url: { type: "string", short: "u" },
  command: { type: "string", short: "c" },
  cwd: { type: "string" },
  timeout: { type: "string", short: "t" },
  chrome: { type: "string" },
  "chrome-app-id": { type: "string" },
  icon: { type: "string" },
  output: { type: "string", short: "o" },
  "no-desktop": { type: "boolean" },
  force: { type: "boolean", short: "f" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTION_DEFINITIONS,
    allowPositionals: true,
    strict: true,
  });

  if (values.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const command = positionals[0] ?? "create";
  if (positionals.length > 1) throw new Error(`无法识别的参数：${positionals.slice(1).join(" ")}`);
  if (values.help) {
    process.stdout.write(renderHelp(command));
    return;
  }

  const config = normalizeCreateOptions(values);
  if (command === "create") {
    const result = await createLauncher(config);
    printCreateResult(result, config.json);
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor(config);
    printDoctorResult(result, config.json);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`未知命令：${command}。可用命令：create、doctor`);
}

function printCreateResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const prefix = result.dryRun ? "将创建" : "已创建";
  if (result.platform === "darwin") {
    process.stdout.write(`${prefix} macOS App：${result.appPath}\n`);
    if (result.desktopShortcut) process.stdout.write(`${prefix}桌面入口：${result.desktopShortcut}\n`);
    if (result.usesChromeShim) {
      process.stdout.write(`Chrome App Shim：${result.chromeShimPath}\n`);
      process.stdout.write(`按需启动监视器（${result.monitorMode}）：${result.launchAgentPath}\n`);
    }
    else process.stdout.write("提示：未检测到该 URL 的已安装 Chrome Web App，将使用直接 Chrome 模式，Dock 显示 Chrome 图标。\n");
  } else if (result.platform === "wsl") {
    process.stdout.write(`${prefix} Windows 快捷方式：${result.shortcutPath}\n`);
    process.stdout.write(`WSL 发行版：${result.wslDistro}\n`);
    if (result.usesInstalledPwa) {
      process.stdout.write(`Windows Chrome App：已安装 PWA ${result.chromeAppId}（${result.chromeProfileDirectory}）\n`);
    } else {
      process.stdout.write("提示：未检测到 Windows Chrome 已安装的对应 PWA，将回退到 --app=<URL> 模式。\n");
    }
    process.stdout.write(`WSL 监督器目录：${result.supportDirectory}\n`);
    process.stdout.write(`Windows 桥接器目录：${result.hostSupportDirectory}\n`);
  } else {
    process.stdout.write(`${prefix} Windows 快捷方式：${result.shortcutPath}\n`);
    process.stdout.write(`启动文件目录：${result.supportDirectory}\n`);
  }
  process.stdout.write(`服务命令：${result.serviceCommand}\n`);
  process.stdout.write(`Chrome App：${result.url}\n`);
}

function printDoctorResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const check of result.checks) {
    process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}：${check.detail}\n`);
  }
}

function renderHelp(command) {
  if (command === "doctor") {
    return `oh-my-deepseek doctor [选项]

检查 Chrome、服务命令和 Node.js 环境。

常用选项：
  --command, -c <命令>   要检查的服务命令，默认 dsh web
  --chrome <路径>        Chrome.app、Chrome 可执行文件或 chrome.exe
  --chrome-app-id <ID>   已安装 Chrome Web App ID（通常自动检测）
  --json                 输出 JSON
  --help, -h             显示帮助
`;
  }

  return `oh-my-deepseek create [选项]

创建一个桌面入口：静默启动本地服务，等待端口就绪，再用 Google Chrome
的 --app 模式打开无地址栏窗口；关闭 App 后自动清理本次启动的服务。

选项：
  --name, -n <名称>      应用名称，默认 DeepSeek Harness
  --url, -u <URL>        Chrome App URL，默认 http://127.0.0.1:3080/
  --command, -c <命令>   服务命令，默认 dsh web
  --cwd <目录>           服务工作目录，默认执行 create 时的当前目录
  --timeout, -t <秒>     等待服务就绪时间，默认 45
  --chrome <路径>        Chrome.app、Chrome 可执行文件或 chrome.exe
  --chrome-app-id <ID>   已安装 Chrome Web App ID（通常自动检测）
  --icon <路径>          macOS 使用 .icns；Windows 使用 .ico
  --output, -o <目录>    macOS App 安装目录 / Windows 快捷方式目录
  --no-desktop           macOS 不创建桌面快捷入口
  --force, -f            允许覆盖同名的非本工具产物
  --dry-run              只显示计划，不写文件
  --json                 输出 JSON
  --version, -v          显示版本
  --help, -h             显示帮助

示例：
  oh-my-deepseek create
  oh-my-deepseek create --name "My Agent" --url http://127.0.0.1:5173 --command "npm run dev"

在 WSL 中运行时会自动创建 Windows 桌面快捷方式：DSH 和 Node.js 留在 WSL，
Chrome 使用 Windows 宿主机安装；宿主机无需另装 Node.js。
`;
}

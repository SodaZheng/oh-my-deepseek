# oh-my-deepseek

把本地 Web 服务变成可以直接双击的 Chrome App。

用户点击入口后，工具会在后台静默启动服务，等待监听端口就绪，再用 Google Chrome 的 `--app=<URL>` 模式打开无地址栏窗口。关闭该 Chrome App 后，工具会自动停止由本次入口启动的服务进程树。

同一个 App 在全局只允许一个监督器、一个服务进程树和一个 Chrome App Shim。重复点击只激活现有窗口，不会再打开新的 Chrome。

支持：

- macOS 13+
- Windows 10/11
- Node.js 20+
- Google Chrome

默认使用项目根目录的 `icon.icns`；Windows 安装包使用由它生成的 `icon.ico`。仍可通过 `--icon` 覆盖单个 App 的图标。

## 快速开始

在本项目目录安装并创建默认入口：

```bash
npm install
npm link
oh-my-deepseek doctor
oh-my-deepseek create
```

默认配置：

- 应用名称：`DeepSeek Harness`
- 服务命令：`dsh web`
- 页面地址：`http://127.0.0.1:3080/`
- 服务工作目录：执行 `create` 时所在的目录
- 启动超时：45 秒

macOS 会把自包含 App 安装到 `~/Applications/DeepSeek Harness.app`，并在桌面创建快捷入口。Windows 会把启动文件放在 `%LOCALAPPDATA%\Oh My DeepSeek\apps`，并在桌面创建 `.lnk`。

macOS 会优先检测当前 Chrome 配置中已安装的 Web App，并使用 Chrome 官方 `app_mode_loader` 生成轻量 App Shim。它直接复用系统 Google Chrome，因此启动快、Dock 使用自定义图标、Cookie 和登录状态保持普通 Chrome 行为，也不会触发自定义 Runtime 的 Safe Storage 授权。

如果 URL 尚未安装为 Chrome Web App，工具会回退到直接 Chrome 模式并明确提示；此时功能仍可用，但 Dock 显示 Chrome 图标。可先在 Chrome 中把页面安装为应用，再重新运行 `create`，或通过 `--chrome-app-id` 指定已知 App ID。

## 创建其他本地 Web App

```bash
oh-my-deepseek create \
  --name "My Agent" \
  --url http://127.0.0.1:5173 \
  --command "npm run dev" \
  --cwd /path/to/project
```

PowerShell 示例：

```powershell
oh-my-deepseek create `
  --name "My Agent" `
  --url http://127.0.0.1:5173 `
  --command "npm run dev" `
  --cwd C:\code\my-agent
```

完整选项：

```text
--name, -n <名称>      应用名称
--url, -u <URL>        Chrome App URL；其主机和端口也用于就绪检测
--command, -c <命令>   在终端运行的服务命令
--cwd <目录>           服务工作目录
--timeout, -t <秒>     最多等待时间
--chrome <路径>        Chrome.app、Chrome 可执行文件或 chrome.exe
--icon <路径>          macOS 使用 .icns；Windows 使用 .ico
--output, -o <目录>    macOS App 安装目录 / Windows 快捷方式目录
--no-desktop           macOS 不创建桌面快捷入口
--force, -f            覆盖同名的非本工具产物
--dry-run              只查看创建计划
--json                 机器可读输出
```

再次运行相同的 `create` 命令会更新本工具生成的入口。如果同名位置是其他 App 或文件，默认会停止并提示；只有显式加入 `--force` 才会覆盖。

## 启动行为

1. 检查 URL 对应的 TCP 主机和端口。
2. 如果已经可用，直接打开 Chrome App，并把该服务视为外部进程。
3. 如果尚未可用，在后台静默启动服务，并记录本次服务进程树。
4. 服务就绪后打开 Chrome 官方 App Shim；直接模式则打开 `--app=<URL>`。
5. 监测 App Shim 或直接模式页面窗口的生命周期。
6. App 窗口关闭后，仅停止本次启动的服务。
7. 启动失败时弹出提示，详细输出保存在日志文件中。
8. 重复点击时激活现有窗口，不创建第二个实例。

如果端口在点击入口前已经可用，关闭 Chrome App **不会**停止原有服务，避免误杀用户手动启动或由其他工具管理的进程。

默认日志位置：

- macOS：`~/Library/Logs/Oh My DeepSeek/<应用名>.log`
- Windows：`%LOCALAPPDATA%\Oh My DeepSeek\logs\<应用名>.log`

## 开发与验证

```bash
npm run check
npm test
npm pack --dry-run
```

CI 在 `macos-latest` 和 `windows-latest` 上运行语法与模板测试；macOS 会实际生成并临时签名测试 App，Windows 会实际生成测试 `.lnk`。

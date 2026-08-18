# oh-my-deepseek

把本地 Web 服务变成可以直接双击的 Chrome App。

用户点击入口后，工具会在后台静默启动服务，等待页面和插件清单就绪，再用 Google Chrome 打开无地址栏窗口。关闭该 Chrome App 后，工具会自动停止由本次入口启动的服务进程树。

同一个 App 在全局只允许一个监督器、一个服务进程树和一个 Chrome App Shim。重复点击只激活现有窗口，不会再打开新的 Chrome。

支持：

- macOS 13+
- Windows 10/11
- WSL（推荐 WSL 2；DSH/Node.js 在 WSL，Chrome 在 Windows 宿主机）
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

macOS 会把官方 Chrome App Shim 安装到 `~/Applications/DeepSeek Harness.app`，并在桌面创建快捷入口。它就是唯一的可见 App，可直接从 `~/Applications` 拖入 Dock。Windows 会把启动文件放在 `%LOCALAPPDATA%\Oh My DeepSeek\apps`，并在桌面创建 `.lnk`。快捷方式通过无控制台的 Windows Script Host 直接启动 Node 监督器，不再经过常驻 PowerShell 启动层；`launcher.js` 使用无 BOM 的纯 ASCII 内容，Unicode 路径和提示以 `\uXXXX` 表示，兼容经典 JScript 引擎。旧快捷方式需要重新运行一次 `oh-my-deepseek create` 才能更新。

在 WSL 里执行同样的 `doctor` 和 `create` 命令即可自动进入 WSL 模式：桌面仍生成 Windows `.lnk`，点击后由 Windows Script Host 直接调用 `wsl.exe`，静默进入创建时使用的发行版和用户，使用 WSL 内的 Node.js 启动 `dsh web`，再由 Windows 宿主机的 Chrome 打开 App 窗口。宿主机无需重复安装 Node.js 或 DSH。

macOS 会优先检测当前 Chrome 配置中已安装的 Web App，并使用 Chrome 官方 `app_mode_loader` 生成唯一的可见 App。一个由 `launchd` 管理的无界面原生监视器通过 `NSWorkspace.runningApplications` 事件在登录期间等待点击，不做进程轮询：冷启动时先关闭尚未就绪的首次窗口，启动服务，等待页面就绪，再重新打开同一个 App。监视器本身不启动或常驻业务服务；关闭 App 后仍只停止本次接管启动的服务进程树。

创建时如果本机可用 Apple Command Line Tools，工具会现场编译并临时签名 universal 原生监视器；如果不可用，则自动回退到兼容的 Node.js 监视器，不影响 App 创建。

因为启动和运行始终是 `~/Applications` 中的同一个 Chrome App Shim，Dock 只显示一个图标。它继续复用系统 Google Chrome，Cookie 和登录状态保持普通 Chrome 行为，也不会触发自定义 Runtime 的 Safe Storage 授权。首次冷启动可能有一次很短的图标弹跳。

如果 URL 尚未安装为 Chrome Web App，工具会回退到直接 Chrome 模式并明确提示；此时功能仍可用，但 Dock 显示 Chrome 图标。可先在 Chrome 中把页面安装为应用，再重新运行 `create`，或通过 `--chrome-app-id` 指定已知 App ID。

### WSL + Windows Chrome

```bash
# 在安装了 dsh 的 WSL 发行版中执行
npm install
npm link
oh-my-deepseek doctor
oh-my-deepseek create
```

WSL 模式保留与原生桌面入口一致的行为：静默启动、自定义图标、无地址栏 Chrome App、全局单实例、重复点击激活现有窗口、关闭窗口后只停止本入口启动的 DSH 进程树。项目和 `node_modules` 可以继续放在 WSL Linux 文件系统中。

WSL 创建入口时会扫描 Windows Chrome 的 `Default` 和 `Profile N`，按页面 URL 识别已经安装的 PWA。检测成功后使用 Chrome 官方 `chrome_proxy.exe --app-id=<ID> --profile-directory=<Profile>` 启动，因此复用 Windows Chrome 的登录状态、PWA 菜单、图标和窗口体验；不会再为主路径创建独立调试 Profile，也不需要 DevTools 端口。桥接器通过本次新增的 Windows 顶层窗口句柄完成激活和关闭检测。

第一次使用前，需要在 Windows 的普通 Chrome 窗口中安装一次页面：先在 WSL 手动运行服务，在 Windows Chrome 打开对应 URL，选择“安装此网站为应用”或“将网页安装为应用”，然后重新运行 `oh-my-deepseek create`。如果没有检测到已安装 PWA，工具会明确提示并回退到 `--app=<URL>` 兼容模式。

Windows 宿主浏览器桥接器只在 App 运行期间存在。PWA 模式使用窗口句柄状态；URL 回退模式复用单个 HTTP 客户端与 Chrome 进程对象。空闲状态不安装常驻 Windows 服务或守护进程。

Windows 默认可通过 `localhost` 访问 WSL 内的 Web 服务。如果机器关闭了 WSL localhost 转发、被防火墙/VPN 拦截，或 DSH 没有监听配置中的地址和端口，启动器会弹出明确错误并保留日志；不会改写网络或防火墙设置。

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

1. 请求配置的 URL，确认页面已返回；DeepSeek Harness 还会等待完整的插件启动清单。
2. 如果已经可用，直接打开 Chrome App，并把该服务视为外部进程。
3. 如果尚未可用，在后台静默启动服务，并记录本次服务进程树。
4. macOS 监视器拦截尚未就绪的首次 Shim 进程；服务就绪后重新打开同一个 App。直接模式则打开 `--app=<URL>`。
5. 监测 App Shim 或直接模式页面窗口的生命周期。
6. App 窗口关闭后，仅停止本次启动的服务。
7. 启动失败时弹出提示，详细输出保存在日志文件中。
8. 重复点击时激活现有窗口，不创建第二个实例。

如果端口在点击入口前已经可用，关闭 Chrome App **不会**停止原有服务，避免误杀用户手动启动或由其他工具管理的进程。

默认日志位置：

- macOS：`~/Library/Logs/Oh My DeepSeek/<应用名>.log`
- Windows：`%LOCALAPPDATA%\Oh My DeepSeek\logs\<应用名>.log`
- WSL：`~/.local/state/oh-my-deepseek/logs/<应用名>.log`

macOS 的无界面监视器由 `~/Library/LaunchAgents/dev.ohmydeepseek.monitor.<实例 ID>.plist` 管理；详细状态与服务输出共用上述日志。原生监视器只响应应用列表变化，空闲时不会执行 `ps` 或 TCP 轮询。

## 开发与验证

```bash
npm run check
npm test
npm pack --dry-run
```

CI 在 `macos-latest` 和 `windows-latest` 上运行语法与模板测试；macOS 会实际编译原生监视器、生成并临时签名测试 App，Windows 会实际生成测试 `.lnk`。WSL 安装布局和双端生命周期另有不依赖真实 WSL 的集成测试。

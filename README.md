# oh-my-deepseek

把本地 Web 服务变成可以直接双击的 Chrome App。

用户点击入口后，工具会在后台静默启动服务，等待页面和插件清单完整就绪，再用 Google Chrome 打开无地址栏窗口。关闭该 Chrome App 后，工具会强制停止所有监听配置端口的进程，确保端口被释放，不区分服务由本入口、终端还是其他工具启动。

同一个 App 在全局只允许一个监督器、一个服务进程树和一个 Chrome App Shim。重复点击只激活现有窗口，不会再打开新的 Chrome。

支持：

- macOS 13+
- Windows 10/11
- WSL（推荐 WSL 2；DSH/Node.js 在 WSL，Chrome 在 Windows 宿主机）
- Node.js 20+
- Google Chrome

macOS 默认使用项目根目录的 `icon.icns`；Windows 使用针对任务栏小尺寸单独优化的 `icon.ico`，其主图保存在 `assets/windows-icon-master-v2.png`。仍可通过 `--icon` 覆盖单个 App 的图标。

## 快速开始

在本项目目录安装并创建默认入口：

```bash
npm install
npm link
oh-my-deepseek doctor
oh-my-deepseek create
oh-my-deepseek doctor
```

默认配置：

- 应用名称：`DeepSeek Harness`
- 服务命令：`dsh web --no-open`（浏览器窗口由桌面入口统一打开）
- 页面地址：`http://127.0.0.1:3080/`
- 服务工作目录：执行 `create` 时所在的目录
- 启动超时：45 秒
- 服务启动：三平台都会在创建入口时解析简单命令，点击后直接执行并复用 Node 磁盘编译缓存，不常驻 DSH

macOS 会把官方 Chrome App Shim 安装到 `~/Applications/DeepSeek Harness.app`，并在桌面创建快捷入口。它就是唯一的可见 App，可直接从 `~/Applications` 拖入 Dock。Windows 会把启动文件放在 `%LOCALAPPDATA%\Oh My DeepSeek\apps`，并在桌面创建 `.lnk`。快捷方式直接启动无控制台的原生 `launcher.exe`：窗口先显示本地小鲸鱼 loading，再并行启动 Node 监督器，不需要等待 Node、DSH 或 WSL 初始化后才反馈。旧快捷方式需要重新运行一次 `omd` 或 `oh-my-deepseek create` 才能更新；命令会先删除本工具生成的旧入口和启动文件，再创建全新的入口。

在 WSL 里执行同样的 `doctor` 和 `create` 命令即可自动进入 WSL 模式。检测到 Chrome 已安装 PWA 时，工具仍用官方 `chrome_proxy.exe`、App ID 和原有 Chrome Profile 打开真实 PWA，因此登录、Cookie 和窗口能力不变；但桌面入口与开始菜单入口改用 Oh My DeepSeek 自己的无控制台 `launcher.exe`、专属 AppUserModelID 和 `app.ico`。点击后这个 Windows 原生启动器会先显示 loading，同时在后台唤醒 WSL；Chrome/PWA 在窗口门后完成 DSH 页面初始化，随后按 loading 窗口的同一位置和尺寸显示，并用相同任务栏身份完成无白屏交接。新版不再安装 Windows 登录监视器；必须从 OMD 生成的桌面、开始菜单或已迁移任务栏入口启动。

如果找不到 Chrome 官方 PWA 快捷方式，才回退到原生 `launcher.exe` 入口。两条路径都不再经过 Windows Script Host。生成入口时工具会提前解析 `dsh` 等简单服务命令的绝对可执行路径和参数；点击时监督器直接执行该入口，跳过交互式登录 shell、启动脚本和重复的命令发现。macOS、原生 Windows 和 WSL 都会为默认 `dsh web --no-open` 准备 Node 磁盘编译缓存，把可以提前完成的模块编译移到 `create` 阶段。宿主机无需重复安装 Node.js 或 DSH，也不会安装常驻预热进程。

macOS 会继续使用 Chrome 官方 `app_mode_loader` 和唯一的可见 App。`SMAppService` 只向 launchd 注册一个按需 socket：空闲时由系统持有端口，没有 OMD、Node 或 DSH 用户进程。点击官方 App 后，第一次 HTTP 连接才拉起原生按需启动器；它不再 hide/unhide 整个 App，而是缓冲第一次页面请求，在内部随机端口启动 DSH，并通过本机 TCP 代理保留原 URL。完整页面与插件清单连续稳定后，同一个请求在同一个窗口中继续完成，不关闭、不重开、不切换 Dock 身份。关闭 App 后代理、DSH 和启动器全部退出。

macOS、Windows 和 WSL 都使用同一套「深海呼吸 · 珍珠雾印」小鲸鱼 loading。背景使用 DSH 暗色启动页的 `#151517`；原 icon 会被实时提取为透明底、低透明度的暖珍珠灰鲸鱼，并按鲸鱼主体范围裁掉圆角方底外围的暗色投影残影，只保留椭圆涟漪与从喷水孔上浮的气泡。状态文字与最大涟漪范围保持独立间距。Windows/WSL 的第一帧来自已编译的本机窗口，所以不依赖 WSL、Node 或本地端口，点击后即可出现；它读取上次真实 DSH 窗口的外层尺寸并在主屏工作区居中。原生动效通过 `DwmFlush` 跟随显示器合成节奏，在 60Hz、120Hz、144Hz 屏幕上自适应刷新；所有位移按实际时间插值，不使用固定帧步长。真实 Chrome/PWA 在背后等待 `#root` 稳定，再接过同一位置、尺寸和任务栏身份。页面遮罩用 420ms 淡出；系统启用“减少动态效果”时，网页和 Windows 原生 loading 都会自动停用动画。

该模式会由 launchd 保留配置 URL 的端口（默认 `127.0.0.1:3080`），但不会为此保留用户进程或占用 CPU/内存。若要在终端另开一个 DSH，请显式使用其他端口，例如 `dsh web --port 3081`。

macOS 13 及以上会让用户控制后台项目。第一次创建或系统撤销授权后，工具会打开“系统设置 → 通用 → 登录项与扩展”，需要允许 `DeepSeek Harness On Demand Launcher` 一次；这是 launchd socket 注册授权，不代表存在登录常驻进程。授权状态会持久保存，后续重启不需要重新运行 `create`。

如果新版 Chrome 不再提供旧的 URL→App ID 索引，macOS 生成器会校验并复用既有 `ownership.json`、Shim 配置和 Chrome Manifest Resources 中保存的 App ID。已存在的官方 Shim 不会因为一次启发式检测失败就被降级覆盖成普通 launcher；关联资源无法验证时会停止创建并提示重新安装 PWA。

创建时工具会使用 Apple Command Line Tools 现场编译、以 macOS 13 为最低目标并临时签名 universal 原生按需启动器和 `SMAppService` 管理器。若无法完成编译，`create` 会明确失败并提示先运行 `xcode-select --install`。

因为启动和运行始终是 Chrome 自己重建并验证过的同一个 App Shim，`create` 不再删除或重写 canonical Shim；Dock 只保留这个图标。它继续复用系统 Google Chrome，Cookie 和登录状态保持普通 Chrome 行为，也不会触发自定义 Runtime 的 Safe Storage 授权。

如果 URL 尚未安装为 Chrome Web App，工具会回退到直接 Chrome 模式并明确提示；此时功能仍可用，但 Dock 显示 Chrome 图标。可先在 Chrome 中把页面安装为应用，再重新运行 `create`，或通过 `--chrome-app-id` 指定已知 App ID。

### WSL + Windows Chrome

```bash
# 在安装了 dsh 的 WSL 发行版中执行
npm install
npm link
oh-my-deepseek doctor
oh-my-deepseek create
```

WSL 模式保留与原生桌面入口一致的行为：静默启动、自定义图标、无地址栏 Chrome App、全局单实例、重复点击激活现有窗口、关闭窗口后强制释放 WSL 内的配置端口。Windows 原生 loading 会在 WSL 冷启动前先出现；真实 DSH 页面仍只会在页面和插件清单完整可用、客户端根节点完成布局后接管可见窗口。

`dsh web --no-open`、`npm run dev` 以及只包含普通参数和引号的命令会使用直接执行快路径，并在应用状态目录复用 Node 磁盘编译缓存，减少后续冷启动重复解析模块的开销。对于默认的 `dsh web --no-open`，`create` 阶段会通过一次无服务端口的帮助命令提前填充编译缓存，把模块编译从第一次桌面点击移到入口生成时完成。`--no-open` 避免 DSH 自己再打开一个普通浏览器窗口，最终窗口统一由本工具管理。包含管道、重定向、变量展开、命令替换、通配符或环境变量赋值的复杂命令会自动回退到原有 shell 兼容路径，避免改变命令语义。三平台都只在点击后启动 DSH，空闲时不占用 DSH 的 CPU 或内存；快路径只保留少量磁盘缓存。

切换到真实页面前会连续两次验证完整页面、`window.__DSH_BOOT__` 和插件清单，避免把端口已监听或半初始化 HTML 当作可用。检查间隔是 100 ms；WSL 的 Windows 宿主侧会先确认 localhost 转发已经能读取 loading 或完整页面，再让窗口门显示首帧。

WSL 创建入口时会扫描 Windows Chrome 的 `Default` 和 `Profile N`，按页面 URL 识别已经安装的 PWA。检测成功后使用 Chrome 官方 `chrome_proxy.exe --app-id=<ID> --profile-directory=<Profile>` 启动，因此复用 Windows Chrome 的登录状态、PWA 菜单和窗口能力；任务栏图标则来自本工具生成的 `app.ico`。主路径不会创建独立调试 Profile，也不需要 DevTools 端口。桥接器通过 Windows 顶层窗口句柄完成身份切换、激活和关闭检测。

按需窗口门只处理由 OMD 入口启动的新窗口；托管后的真实 PWA 窗口会改用本工具的专属 App ID，并与桌面、开始菜单快捷方式保持一致。Chrome 的 Profile、App ID 和启动参数不变，任务栏身份与浏览器身份彼此解耦。

第一次使用前，需要在 Windows 的普通 Chrome 窗口中安装一次页面：先在 WSL 手动运行服务，在 Windows Chrome 打开对应 URL，选择“安装此网站为应用”或“将网页安装为应用”，然后重新运行 `oh-my-deepseek create`。如果没有检测到已安装 PWA，工具会明确提示并回退到 `--app=<URL>` 兼容模式。

更新已有入口时，`omd` 会校验旧任务栏固定项确实指向同一 Chrome PWA，先把原 `.lnk` 备份到本入口的 Windows 状态目录，再原地改成 OMD 的 `launcher.exe`、专属 AppUserModelID 和图标。旧固定位置因此会直接按需启动 WSL 监督器；未迁移的 Chrome 官方快捷方式不会再被后台进程接管。

Windows 宿主浏览器桥接器只在 App 窗口运行期间存在。PWA 模式使用窗口句柄状态；URL 回退模式复用单个 HTTP 客户端与 Chrome 进程对象。WSL、DSH 和 PWA 监视器都不会在登录时预热或常驻；主桌面、开始菜单和迁移后的任务栏入口从磁盘直接冷启动。

Windows/WSL 启动入口会记录真实 App 窗口的外层宽高；下次启动时恢复该宽高，并在 Chrome 选中的当前显示器可用区域内居中。窗口尺寸记录独立保存在本入口的 Windows 状态目录中，不依赖 Chrome 对内容区域尺寸的换算，因此不会因为标题栏、边框或任务栏产生二次启动尺寸偏差；如果显示器分辨率变小，尺寸会自动收敛到可用区域内。

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

再次运行 `omd` 或相同的 `create` 命令时，会先销毁、删除本工具生成的旧快捷方式和启动文件，再创建全新的入口；Chrome Profile、登录 Cookie 和已保存的窗口尺寸会保留。如果同名位置是其他 App 或文件，默认会停止并提示；只有显式加入 `--force` 才会覆盖。若旧 App 仍在运行，命令会要求先关闭，避免运行过程中删除其启动文件。

## 启动行为

1. 请求配置的 URL，确认页面已返回；DeepSeek Harness 还会等待完整的插件启动清单。
2. 如果已经可用，直接打开 Chrome App，并把该服务视为外部进程。
3. 如果尚未可用，在后台静默启动服务，并记录本次服务进程树。
4. macOS launchd socket 在第一次页面连接时拉起按需启动器；同一个 Shim 和窗口保持不变，首次请求等待服务稳定后直接继续，不隐藏、不关闭重开。直接模式仍打开 `--app=<URL>`。
5. 监测 App Shim 或直接模式页面窗口的生命周期。
6. App 窗口关闭后，定位并停止所有监听配置端口的进程；普通终止无效时执行强制终止，并确认端口持续空闲。
7. 启动失败时弹出提示，详细输出保存在日志文件中。
8. 重复点击时激活现有窗口，不创建第二个实例。

WSL 的常规 PWA 链路为：自有桌面/开始菜单/任务栏快捷方式 → 无控制台 `launcher.exe` → 指定发行版的 `wsl.exe --exec` → Node 监督器 → 完整就绪后在隐藏窗口门内打开原 Chrome PWA → 窗口切换到自有任务栏身份并一次显示。没有 Windows 登录事件监视器；运行时也不启动 WScript 或交互式登录 shell。

如果端口在点击入口前已经可用，App 会直接复用该服务；但关闭 Chrome App 时仍会停止监听该端口的进程。该规则适用于 macOS、Windows 和 WSL，可能终止用户手动启动或由其他工具管理的服务。

默认日志位置：

- macOS：`~/Library/Logs/Oh My DeepSeek/<应用名>.log`
- Windows：`%LOCALAPPDATA%\Oh My DeepSeek\logs\<应用名>.log`
- WSL：`~/.local/state/oh-my-deepseek/logs/<应用名>.log`

macOS 的按需 socket 使用版本化的 `Contents/Library/LaunchAgents/dev.ohmydeepseek.ondemand.v3.<实例 ID>.plist` 服务身份，并由 `SMAppService` 注册；plist 没有 `RunAtLoad` 或 `KeepAlive`，旧监视器进程和旧登录入口会在升级时停止并移除。原生 helper 版本独立于普通配置版本，重复执行 `create` 不会重签或替换已注册的 Mach-O。

三端的重启持久性不同，但验收行为一致：

- macOS：`SMAppService` 恢复 launchd 按需 socket，空闲无进程；双击官方 Chrome App Shim 后才启动 DSH。
- Windows：桌面 `.lnk`、`launcher.js`、监督器和绝对 Node.js 路径全部落盘，双击时直接冷启动，不依赖重启前的进程。
- WSL：Windows 桌面/开始菜单 `.lnk`、原生 `launcher.exe` 和 WSL 内监督器全部落盘；不再创建 Windows“启动”目录监视器。

运行 `oh-my-deepseek doctor` 可以检查当前平台的这些最终生成产物；入口尚未创建时该项仅提示，入口部分丢失、后台授权被撤销或保存的运行时路径失效时会返回失败。

## 开发与验证

```bash
npm run check
npm test
npm pack --dry-run
```

CI 在 `macos-latest` 和 `windows-latest` 上运行语法与模板测试；macOS 会实际编译按需启动器，并通过临时 launchd socket 验证空闲无进程、触发期间 App PID 和可见性不变、请求缓冲以及退出清理；Windows 会实际生成测试 `.lnk`。WSL 安装布局和双端生命周期另有不依赖真实 WSL 的集成测试。

import { CONFIG_VERSION, GENERATED_BY, PACKAGE_VERSION } from "../constants.mjs";
import { shellQuote, xmlEscape } from "../utils.mjs";

export function renderMacInfoPlist(config, hasIcon = true) {
  const bundleId = `dev.ohmydeepseek.launcher.${config.instanceId}`;
  const iconEntry = hasIcon
    ? `  <key>CFBundleIconFile</key>
  <string>app.icns</string>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(config.name)}</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(config.name)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${PACKAGE_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${CONFIG_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>OMDConfigVersion</key>
  <integer>${CONFIG_VERSION}</integer>
  <key>OMDGeneratedBy</key>
  <string>${GENERATED_BY}</string>
${iconEntry}
</dict>
</plist>
`;
}

export function renderMacLauncher(config) {
  return `#!/bin/zsh

set -u

readonly app_name=${shellQuote(config.name)}
readonly node_path=${shellQuote(config.nodePath)}
readonly contents_dir="\${0:A:h:h}"
readonly supervisor="\${contents_dir}/Resources/supervisor.mjs"

if [[ ! -x "\${node_path}" ]]; then
  /usr/bin/osascript - "找不到 Node.js" "创建 \${app_name} 时使用的 Node.js 已被移动或删除：\${node_path}" <<'APPLESCRIPT' >/dev/null 2>&1
on run arguments
  display alert (item 1 of arguments) message (item 2 of arguments) as critical buttons {"好"} default button "好"
end run
APPLESCRIPT
  exit 1
fi

/usr/bin/nohup "\${node_path}" "\${supervisor}" >/dev/null 2>&1 &
exit 0
`;
}

export function renderMacChromeLauncher(config, appReadyPath) {
  return `#!/bin/zsh

set -u

readonly app_name=${shellQuote(config.name)}
readonly node_path=${shellQuote(config.nodePath)}
readonly app_ready_path=${shellQuote(appReadyPath)}
readonly timeout_seconds=${config.timeoutSeconds}
readonly contents_dir="\${0:A:h:h}"
readonly supervisor="\${contents_dir}/Resources/supervisor.mjs"
readonly app_mode_loader="\${contents_dir}/MacOS/app_mode_loader"

if [[ ! -x "\${node_path}" ]]; then
  /usr/bin/osascript - "找不到 Node.js" "创建 \${app_name} 时使用的 Node.js 已被移动或删除：\${node_path}" <<'APPLESCRIPT' >/dev/null 2>&1
on run arguments
  display alert (item 1 of arguments) message (item 2 of arguments) as critical buttons {"好"} default button "好"
end run
APPLESCRIPT
  exit 1
fi

if [[ ! -x "\${app_mode_loader}" ]]; then
  /usr/bin/osascript - "无法启动 \${app_name}" "App 内缺少 Chrome App Mode Loader，请重新运行 oh-my-deepseek create。" <<'APPLESCRIPT' >/dev/null 2>&1
on run arguments
  display alert (item 1 of arguments) message (item 2 of arguments) as critical buttons {"好"} default button "好"
end run
APPLESCRIPT
  exit 1
fi

/usr/bin/nohup "\${node_path}" "\${supervisor}" >/dev/null 2>&1 &
readonly supervisor_pid=$!
readonly deadline=$((SECONDS + timeout_seconds + 5))

while (( SECONDS < deadline )); do
  if [[ -f "\${app_ready_path}" ]]; then
    ready_pid="$(/bin/cat "\${app_ready_path}" 2>/dev/null || true)"
    if [[ "\${ready_pid}" == <-> ]] && /bin/kill -0 "\${ready_pid}" 2>/dev/null; then
      exec "\${app_mode_loader}"
    fi
  fi
  if ! /bin/kill -0 "\${supervisor_pid}" 2>/dev/null; then
    exit 1
  fi
  /bin/sleep 0.1
done

exit 1
`;
}

export function renderMacChromeAppInfo({ config, appId, chromeVersion, chromeBundleVersion, appDataPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleName</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundleDisplayName</key><string>${xmlEscape(config.name)}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>com.google.Chrome.app.${appId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundleShortVersionString</key><string>${xmlEscape(chromeVersion)}</string>
  <key>CFBundleVersion</key><string>${xmlEscape(chromeBundleVersion)}</string>
  <key>CrBundleIdentifier</key><string>com.google.Chrome</string>
  <key>CrBundleVersion</key><string>${xmlEscape(chromeVersion)}</string>
  <key>CrAppModeShortcutID</key><string>${appId}</string>
  <key>CrAppModeShortcutName</key><string>${xmlEscape(config.name)}</string>
  <key>CrAppModeShortcutURL</key><string>${xmlEscape(config.url)}</string>
  <key>CrAppModeUserDataDir</key><string>${xmlEscape(appDataPath)}</string>
  <key>CrAppModeIsAdhocSigned</key><true/>
  <key>LSHasLocalizedDisplayName</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppleScriptEnabled</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>OMDConfigVersion</key><integer>${CONFIG_VERSION}</integer>
  <key>OMDGeneratedBy</key><string>${GENERATED_BY}</string>
</dict></plist>
`;
}

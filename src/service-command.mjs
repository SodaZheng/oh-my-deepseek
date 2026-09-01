import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isExecutable, powershellSingleQuote, shellQuote } from "./utils.mjs";

export async function resolveDirectPosixService(config) {
  const words = parseSimpleServiceCommand(config.serviceCommand);
  if (!words) return null;
  const [command, ...arguments_] = words;
  const shell = config.serviceShell || "/bin/zsh";
  const result = spawnSync(
    shell,
    ["-lic", `command -v ${shellQuote(command)}`],
    {
      encoding: "utf8",
      env: { ...process.env, ...(config.servicePath ? { PATH: config.servicePath } : {}) },
    },
  );
  if (result.error || result.status !== 0) return null;
  const discoveredExecutable = result.stdout.trim();
  if (!path.isAbsolute(discoveredExecutable) || discoveredExecutable.includes("\n")) return null;

  let executable;
  try {
    executable = await realpath(discoveredExecutable);
  } catch {
    return null;
  }
  if (!(await isExecutable(executable))) return null;

  const isDshWeb = path.basename(command).toLowerCase() === "dsh" && arguments_[0] === "web";
  const nodeScript = await nodeShebangScript(executable, config.nodePath);
  if (nodeScript) {
    return {
      executable: config.nodePath,
      arguments: [nodeScript, ...arguments_],
      path: config.servicePath,
      serviceKind: isDshWeb ? "dsh-web" : "generic",
      warmupArguments: isDshWeb ? [nodeScript, "web", "--help"] : null,
    };
  }

  return {
    executable,
    arguments: arguments_,
    path: config.servicePath,
    serviceKind: isDshWeb ? "dsh-web" : "generic",
    warmupArguments: isDshWeb ? ["web", "--help"] : null,
  };
}

export function resolveDirectWindowsService(config, env = process.env) {
  const words = parseSimpleServiceCommand(config.serviceCommand);
  if (!words) return null;
  const [command, ...arguments_] = words;
  const query = `$Service = Get-Command -Name ${powershellSingleQuote(command)} -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1; $PowerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write((@{ servicePath = [string]$Service.Source; commandType = [string]$Service.CommandType; powerShellPath = [string]$PowerShell } | ConvertTo-Json -Compress))`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...env, ...(config.servicePath ? { PATH: config.servicePath } : {}) },
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;

  let discovered;
  try {
    discovered = JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
  if (!path.win32.isAbsolute(discovered.servicePath) || !path.win32.isAbsolute(discovered.powerShellPath)) return null;

  const isDshWeb = path.win32.basename(command).toLowerCase() === "dsh" && arguments_[0] === "web";
  const extension = path.win32.extname(discovered.servicePath).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return {
      executable: discovered.servicePath,
      arguments: arguments_,
      path: config.servicePath,
      serviceKind: isDshWeb ? "dsh-web" : "generic",
      warmupArguments: isDshWeb ? ["web", "--help"] : null,
    };
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return {
      executable: config.nodePath,
      arguments: [discovered.servicePath, ...arguments_],
      path: config.servicePath,
      serviceKind: isDshWeb ? "dsh-web" : "generic",
      warmupArguments: isDshWeb ? [discovered.servicePath, "web", "--help"] : null,
    };
  }
  if (extension !== ".ps1" && extension !== ".cmd" && extension !== ".bat") return null;

  const renderInvocation = (serviceArguments) => [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    ...(extension === ".ps1"
      ? ["-File", discovered.servicePath, ...serviceArguments]
      : ["-Command", `& ${powershellSingleQuote(discovered.servicePath)} ${serviceArguments.map(powershellSingleQuote).join(" ")}`]),
  ];
  return {
    executable: discovered.powerShellPath,
    arguments: renderInvocation(arguments_),
    path: config.servicePath,
    serviceKind: isDshWeb ? "dsh-web" : "generic",
    warmupArguments: isDshWeb ? renderInvocation(["web", "--help"]) : null,
  };
}

export function warmDirectServiceCompileCache(directService, config) {
  if (!directService?.warmupArguments || !directService.nodeCompileCachePath) return false;
  const result = spawnSync(directService.executable, directService.warmupArguments, {
    cwd: config.workingDirectory,
    env: {
      ...process.env,
      ...(directService.path ? { PATH: directService.path } : {}),
      NODE_COMPILE_CACHE: directService.nodeCompileCachePath,
    },
    stdio: "ignore",
    timeout: 30_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function parseSimpleServiceCommand(command) {
  const words = [];
  let current = "";
  let state = "unquoted";
  let started = false;
  const finishWord = () => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (state === "single") {
      if (character === "'") state = "unquoted";
      else current += character;
      continue;
    }
    if (state === "double") {
      if (character === '"') {
        state = "unquoted";
      } else if (character === "\\") {
        index += 1;
        if (index >= command.length) return null;
        if (command[index] === '"' || command[index] === "\\") current += command[index];
        else current += `\\${command[index]}`;
      } else if (character === "$" || character === "`") {
        return null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\n" || character === "\r") {
      return null;
    } else if (/\s/.test(character)) {
      finishWord();
    } else if (character === "'") {
      state = "single";
      started = true;
    } else if (character === '"') {
      state = "double";
      started = true;
    } else if (character === "\\") {
      index += 1;
      if (index >= command.length) return null;
      current += command[index];
      started = true;
    } else if ("|&;<>()$`*?[]{}~#".includes(character)) {
      return null;
    } else {
      current += character;
      started = true;
    }
  }
  if (state !== "unquoted") return null;
  finishWord();
  if (words.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return null;
  return words;
}

async function nodeShebangScript(executable, nodePath) {
  if (!nodePath || !(await isExecutable(nodePath))) return null;
  let handle;
  try {
    handle = await open(executable, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
    return /^#!\s*\/usr\/bin\/env(?:\s+-S)?\s+node(?:\s|$)/.test(firstLine) ? executable : null;
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch {}
  }
}

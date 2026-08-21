import { xmlEscape } from "../utils.mjs";

export function renderMacServiceManagerInfo({ bundleIdentifier, name }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(name)} Background Launcher</string>
  <key>CFBundleExecutable</key>
  <string>service-manager</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(name)} Background Launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
`;
}

export function renderMacManagedLaunchAgent({ label, monitorConfigPath, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>BundleProgram</key>
  <string>Contents/MacOS/monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>monitor</string>
    <string>${xmlEscape(monitorConfigPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function renderMacServiceManagerSource({ launchAgentPlistName }) {
  const encodedPlistName = Buffer.from(launchAgentPlistName, "utf8").toString("base64");
  return String.raw`#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

static NSString *Decode(NSString *value) {
  NSData *data = [[NSData alloc] initWithBase64EncodedString:value options:0];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSString *StatusName(SMAppServiceStatus status) {
  switch (status) {
    case SMAppServiceStatusNotRegistered: return @"not-registered";
    case SMAppServiceStatusEnabled: return @"enabled";
    case SMAppServiceStatusRequiresApproval: return @"requires-approval";
    case SMAppServiceStatusNotFound: return @"not-found";
  }
  return @"unknown";
}

static void PrintStatus(SMAppService *service) {
  fprintf(stdout, "%s\n", [StatusName(service.status) UTF8String]);
  fflush(stdout);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (@available(macOS 13.0, *)) {
      NSString *plistName = Decode(@"${encodedPlistName}");
      SMAppService *service = [SMAppService agentServiceWithPlistName:plistName];
      NSString *command = argc >= 2 ? [NSString stringWithUTF8String:argv[1]] : @"status";

      if ([command isEqualToString:@"status"]) {
        PrintStatus(service);
        return service.status == SMAppServiceStatusEnabled ? 0 : 4;
      }
      if ([command isEqualToString:@"register"]) {
        if (service.status != SMAppServiceStatusEnabled) {
          NSError *error = nil;
          if (![service registerAndReturnError:&error]) {
            PrintStatus(service);
            if (service.status == SMAppServiceStatusRequiresApproval) return 4;
            fprintf(stderr, "%s\n", [error.localizedDescription UTF8String]);
            return 1;
          }
        }
        PrintStatus(service);
        return service.status == SMAppServiceStatusEnabled ? 0 : 4;
      }
      if ([command isEqualToString:@"unregister"]) {
        if (service.status != SMAppServiceStatusNotRegistered && service.status != SMAppServiceStatusNotFound) {
          NSError *error = nil;
          if (![service unregisterAndReturnError:&error]) {
            fprintf(stderr, "%s\n", [error.localizedDescription UTF8String]);
            return 1;
          }
        }
        PrintStatus(service);
        return 0;
      }
      if ([command isEqualToString:@"open-settings"]) {
        [SMAppService openSystemSettingsLoginItems];
        PrintStatus(service);
        return 0;
      }
      fprintf(stderr, "unknown command\n");
      return 2;
    }
    fprintf(stderr, "macOS 13 or newer is required\n");
    return 3;
  }
}
`;
}

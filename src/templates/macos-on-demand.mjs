import { renderMacOnDemandHttpProxy } from "./macos-on-demand-proxy.mjs";

export function renderMacOnDemandActivatorSource() {
  return String.raw`#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <launch.h>
#import <errno.h>
#import <fcntl.h>
#import <signal.h>
#import <sys/wait.h>
#import <unistd.h>

static NSArray<NSRunningApplication *> *LiveApplications(NSString *bundleIdentifier) {
  NSMutableArray<NSRunningApplication *> *live = [NSMutableArray array];
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
    if (!application.isTerminated) [live addObject:application];
  }
  return live;
}

static void TerminateApplications(NSString *bundleIdentifier) {
  for (NSRunningApplication *application in LiveApplications(bundleIdentifier)) [application terminate];
}

static void ShowFailure(NSString *name, NSString *message) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp activateIgnoringOtherApps:YES];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"%@ 启动失败", name];
  alert.informativeText = message;
  alert.alertStyle = NSAlertStyleCritical;
  [alert addButtonWithTitle:@"好"];
  [alert runModal];
}

static void StopChild(pid_t child) {
  if (child <= 0) return;
  fprintf(stderr, "[on-demand-native] stopping child process group %d\n", child);
  if (kill(-child, SIGTERM) != 0) fprintf(stderr, "[on-demand-native] SIGTERM failed: %d\n", errno);
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
  while ([deadline timeIntervalSinceNow] > 0) {
    int status = 0;
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child || (result < 0 && errno == ECHILD)) return;
    usleep(50000);
  }
  kill(-child, SIGKILL);
  waitpid(child, NULL, 0);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *configPath = [NSString stringWithUTF8String:argv[1]];
    NSData *data = [NSData dataWithContentsOfFile:configPath];
    NSError *jsonError = nil;
    NSDictionary *config = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError] : nil;
    if (![config isKindOfClass:[NSDictionary class]] || jsonError) return 3;

    NSString *bundleIdentifier = config[@"appBundleIdentifier"];
    NSString *nodePath = config[@"nodePath"];
    NSString *proxyPath = config[@"proxyPath"];
    NSString *readyPath = config[@"readyPath"];
    NSString *errorPath = config[@"errorPath"];
    NSString *name = config[@"name"] ?: @"DeepSeek Harness";
    NSTimeInterval timeout = [config[@"timeoutSeconds"] doubleValue];
    if (timeout < 1) timeout = 45;

    [[NSFileManager defaultManager] removeItemAtPath:readyPath error:nil];
    [[NSFileManager defaultManager] removeItemAtPath:errorPath error:nil];

    int *sockets = NULL;
    size_t socketCount = 0;
    int activationError = launch_activate_socket("HttpListener", &sockets, &socketCount);
    if (activationError != 0 || socketCount == 0) {
      fprintf(stderr, "launch_activate_socket failed: %d\n", activationError);
      free(sockets);
      return 4;
    }
    int listener = sockets[0];
    for (size_t index = 1; index < socketCount; index += 1) close(sockets[index]);
    free(sockets);
    int descriptorFlags = fcntl(listener, F_GETFD);
    if (descriptorFlags >= 0) fcntl(listener, F_SETFD, descriptorFlags & ~FD_CLOEXEC);

    NSDate *findDeadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
    while (LiveApplications(bundleIdentifier).count == 0 && [findDeadline timeIntervalSinceNow] > 0) usleep(10000);
    fprintf(stderr, "[on-demand-native] target App kept visible; first request buffered until DSH readiness\n");

    pid_t child = fork();
    if (child == 0) {
      setpgid(0, 0);
      NSString *descriptor = [NSString stringWithFormat:@"%d", listener];
      setenv("OMD_LISTEN_FD", descriptor.UTF8String, 1);
      execl(nodePath.UTF8String, nodePath.UTF8String, proxyPath.UTF8String, configPath.UTF8String, NULL);
      _exit(127);
    }
    close(listener);
    if (child < 0) return 5;
    setpgid(child, child);
    fprintf(stderr, "[on-demand-native] started proxy PID %d\n", child);

    BOOL revealed = NO;
    BOOL failed = NO;
    NSString *failureMessage = nil;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    NSDate *missingSince = nil;
    while (revealed || [deadline timeIntervalSinceNow] > 0) {
      int status = 0;
      pid_t waitResult = waitpid(child, &status, WNOHANG);
      if (waitResult == child) {
        if (!revealed) {
          failed = YES;
          failureMessage = [NSString stringWithContentsOfFile:errorPath encoding:NSUTF8StringEncoding error:nil];
          if (failureMessage.length == 0) failureMessage = @"按需启动进程提前退出，请查看日志。";
        }
        child = 0;
        break;
      }

      NSArray<NSRunningApplication *> *applications = LiveApplications(bundleIdentifier);
      if (applications.count == 0) {
        if (!missingSince) missingSince = [NSDate date];
        if ([[NSDate date] timeIntervalSinceDate:missingSince] >= (revealed ? 1.5 : 0.3)) {
          fprintf(stderr, "[on-demand-native] target App closed\n");
          break;
        }
      } else {
        missingSince = nil;
      }

      if (!revealed && [[NSFileManager defaultManager] fileExistsAtPath:readyPath]) {
        fprintf(stderr, "[on-demand-native] stable readiness reached in the existing App window\n");
        revealed = YES;
      } else if (!revealed && [[NSFileManager defaultManager] fileExistsAtPath:errorPath]) {
        failed = YES;
        failureMessage = [NSString stringWithContentsOfFile:errorPath encoding:NSUTF8StringEncoding error:nil];
        break;
      }
      usleep(50000);
    }

    if (!revealed && !failed && LiveApplications(bundleIdentifier).count > 0) {
      failed = YES;
      failureMessage = @"等待 DSH 完整初始化超时，请查看日志。";
    }
    StopChild(child);
    [[NSFileManager defaultManager] removeItemAtPath:readyPath error:nil];
    if (failed) {
      TerminateApplications(bundleIdentifier);
      ShowFailure(name, failureMessage ?: @"未知错误");
      return 1;
    }
  }
  return 0;
}
`;
}

export function renderMacOnDemandProxy() {
  return renderMacOnDemandHttpProxy();
}

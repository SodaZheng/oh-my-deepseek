export function renderMacNativeMonitorSource() {
  return String.raw`#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

@interface OMDMonitor : NSObject
@property(nonatomic, strong) NSDictionary *config;
@property(atomic, assign) BOOL supervising;
- (instancetype)initWithConfig:(NSDictionary *)config;
- (void)start;
@end

static void *OMDRunningApplicationsContext = &OMDRunningApplicationsContext;

@implementation OMDMonitor

- (instancetype)initWithConfig:(NSDictionary *)config {
  self = [super init];
  if (self) {
    _config = config;
    _supervising = NO;
  }
  return self;
}

- (void)start {
  [[NSWorkspace sharedWorkspace]
      addObserver:self
         forKeyPath:@"runningApplications"
            options:NSKeyValueObservingOptionNew
            context:OMDRunningApplicationsContext];
  [self appendLog:@"启动原生 macOS App 监视器"];
  [self inspectRunningApplications];
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  if (context == OMDRunningApplicationsContext) {
    [self inspectRunningApplications];
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)inspectRunningApplications {
  NSString *bundleIdentifier = self.config[@"appBundleIdentifier"];
  NSRunningApplication *application = nil;
  for (NSRunningApplication *candidate in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
    if (!candidate.isTerminated) {
      application = candidate;
      break;
    }
  }
  if (!application) return;

  @synchronized(self) {
    if (self.supervising) return;
    self.supervising = YES;
  }

  [self appendLog:[NSString stringWithFormat:@"捕获 App 启动 PID %d", application.processIdentifier]];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      [self terminateTargetApplications];
      [self runSupervisor];
      @synchronized(self) {
        self.supervising = NO;
      }
    }
  });
}

- (NSArray<NSRunningApplication *> *)liveTargetApplications {
  NSString *bundleIdentifier = self.config[@"appBundleIdentifier"];
  NSMutableArray<NSRunningApplication *> *live = [NSMutableArray array];
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
    if (!application.isTerminated) [live addObject:application];
  }
  return live;
}

- (void)terminateTargetApplications {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
  NSInteger stableEmptyChecks = 0;
  while ([deadline timeIntervalSinceNow] > 0) {
    NSArray<NSRunningApplication *> *applications = [self liveTargetApplications];
    if (applications.count == 0) {
      stableEmptyChecks += 1;
      if (stableEmptyChecks >= 3) return;
    } else {
      stableEmptyChecks = 0;
      for (NSRunningApplication *application in applications) [application terminate];
    }
    [NSThread sleepForTimeInterval:0.1];
  }
  for (NSRunningApplication *application in [self liveTargetApplications]) [application forceTerminate];
  [NSThread sleepForTimeInterval:0.15];
}

- (void)runSupervisor {
  NSString *nodePath = self.config[@"nodePath"];
  NSString *supervisorPath = self.config[@"supervisorPath"];
  NSString *logPath = self.config[@"logPath"];
  if (![[NSFileManager defaultManager] isExecutableFileAtPath:nodePath]) {
    [self appendLog:[NSString stringWithFormat:@"找不到 Node.js：%@", nodePath]];
    return;
  }

  if (![[NSFileManager defaultManager] fileExistsAtPath:logPath]) {
    [[NSFileManager defaultManager] createFileAtPath:logPath contents:nil attributes:nil];
  }
  NSFileHandle *logHandle = [NSFileHandle fileHandleForWritingAtPath:logPath];
  [logHandle seekToEndOfFile];

  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:nodePath];
  task.arguments = @[supervisorPath];
  task.standardOutput = logHandle;
  task.standardError = logHandle;
  NSError *error = nil;
  if (![task launchAndReturnError:&error]) {
    [self appendLog:[NSString stringWithFormat:@"无法启动监督器：%@", error.localizedDescription]];
    [logHandle closeFile];
    return;
  }
  [self appendLog:[NSString stringWithFormat:@"启动监督器 PID %d", task.processIdentifier]];
  [task waitUntilExit];
  [logHandle closeFile];
  [self appendLog:[NSString stringWithFormat:@"监督器已退出，状态码 %d", task.terminationStatus]];
}

- (void)appendLog:(NSString *)message {
  NSString *logPath = self.config[@"logPath"];
  NSString *line = [NSString stringWithFormat:@"[%@] [native-monitor] %@\n", [NSDate date], message];
  NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
  @synchronized(self) {
    if (![[NSFileManager defaultManager] fileExistsAtPath:logPath]) {
      [[NSFileManager defaultManager] createFileAtPath:logPath contents:nil attributes:nil];
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:logPath];
    [handle seekToEndOfFile];
    [handle writeData:data];
    [handle closeFile];
  }
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *configPath = [NSString stringWithUTF8String:argv[1]];
    NSData *data = [NSData dataWithContentsOfFile:configPath];
    if (!data) return 3;
    NSError *error = nil;
    NSDictionary *config = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (![config isKindOfClass:[NSDictionary class]] || error) return 4;
    OMDMonitor *monitor = [[OMDMonitor alloc] initWithConfig:config];
    [monitor start];
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
`;
}

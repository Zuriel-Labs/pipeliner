#import <AppKit/AppKit.h>
#import <Virtualization/Virtualization.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <signal.h>
#include <errno.h>
#include <math.h>

// Native qualification only. Bridge mode shares only fresh synthetic input/output folders.
static void report(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static void fail(NSString *stage, NSError *error) { report(@{@"failed": stage, @"errorCode": @(error.code)}); exit(1); }
static NSURL *childURL(NSString *root, NSString *name) { return [NSURL fileURLWithPath:[root stringByAppendingPathComponent:name]]; }
static BOOL writePrivate(NSData *data, NSURL *url) {
  return [data writeToURL:url options:NSDataWritingWithoutOverwriting error:nil] && chmod(url.fileSystemRepresentation, 0600) == 0;
}
static NSDictionary *readPrivateJSON(NSURL *url) {
  int fd = open(url.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) { if (errno == ENOENT) return nil; fail(@"bridge-output-open", nil); }
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_uid != getuid()
    || (info.st_mode & 0777) != 0600 || info.st_size < 1 || info.st_size > 16384) { close(fd); fail(@"bridge-output-shape", nil); }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)info.st_size];
  ssize_t length = read(fd, data.mutableBytes, data.length); close(fd);
  if (length != info.st_size) fail(@"bridge-output-read", nil);
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class]) fail(@"bridge-output-json", nil); return value;
}

@interface MacQualification : NSObject <VZVirtualMachineDelegate>
@property NSString *root;
@property VZVirtualMachine *vm;
@property VZMacOSInstaller *installer;
@property NSWindow *window;
@property NSTimer *monitor;
@property NSDate *began;
@property BOOL finishing;
@property BOOL bootDeadlineExceeded;
@property (strong) dispatch_source_t termination;
@property BOOL bridge;
@property VZVirtualMachineView *view;
@property NSString *nonce;
@property BOOL clicked;
- (void)install;
- (void)boot;
- (void)armTermination;
- (void)captureAndStop;
- (BOOL)capture:(NSString *)name;
- (void)key:(unsigned short)code text:(NSString *)text flags:(NSEventModifierFlags)flags completion:(void (^)(void))completion;
- (void)typeFixed:(NSString *)text completion:(void (^)(void))completion;
@end

@implementation MacQualification
- (void)armTermination {
  signal(SIGTERM, SIG_IGN);
  self.termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(self.termination, ^{
    report(@{@"ownedCancellationReceived": @YES});
    if (self.installer) [self.installer.progress cancel];
    else if (self.vm) [self stop];
    else fail(@"cancel-before-vm-start", nil);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ fail(@"owned-cancellation-unverified", nil); });
  });
  dispatch_resume(self.termination);
}
- (VZVirtualMachineConfiguration *)configuration:(VZMacPlatformConfiguration *)platform {
  NSError *error = nil;
  VZVirtualMachineConfiguration *configuration = [VZVirtualMachineConfiguration new];
  configuration.label = [@"Pipeliner-54-" stringByAppendingString:self.root.lastPathComponent];
  configuration.platform = platform; configuration.bootLoader = [[VZMacOSBootLoader alloc] init];
  configuration.CPUCount = 2; configuration.memorySize = 4ULL * 1024 * 1024 * 1024;
  VZDiskImageStorageDeviceAttachment *disk = [[VZDiskImageStorageDeviceAttachment alloc]
    initWithURL:childURL(self.root, @"Disk.img") readOnly:NO error:&error];
  if (!disk) fail(@"disk-attachment", error);
  configuration.storageDevices = @[[[VZVirtioBlockDeviceConfiguration alloc] initWithAttachment:disk]];
  VZMacGraphicsDeviceConfiguration *graphics = [[VZMacGraphicsDeviceConfiguration alloc] init];
  graphics.displays = @[[[VZMacGraphicsDisplayConfiguration alloc] initWithWidthInPixels:1024 heightInPixels:768 pixelsPerInch:80]];
  configuration.graphicsDevices = @[graphics]; configuration.keyboards = @[[[VZMacKeyboardConfiguration alloc] init]];
  configuration.pointingDevices = @[[[VZMacTrackpadConfiguration alloc] init]];
  if (self.bridge) {
    for (NSString *name in @[@"input", @"output"]) {
      NSURL *url = childURL(self.root, name); struct stat info; char actual[PATH_MAX];
      if (!realpath(url.fileSystemRepresentation, actual) || strcmp(actual, url.fileSystemRepresentation) != 0
        || lstat(actual, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 077) != 0) fail(@"bridge-share-ownership", nil);
    }
    VZVirtioFileSystemDeviceConfiguration *share = [[VZVirtioFileSystemDeviceConfiguration alloc] initWithTag:VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag];
    share.share = [[VZMultipleDirectoryShare alloc] initWithDirectories:@{
      @"input": [[VZSharedDirectory alloc] initWithURL:childURL(self.root, @"input") readOnly:YES],
      @"output": [[VZSharedDirectory alloc] initWithURL:childURL(self.root, @"output") readOnly:NO]}];
    configuration.directorySharingDevices = @[share];
  }
  if (configuration.networkDevices.count || configuration.directorySharingDevices.count != (self.bridge ? 1 : 0) || configuration.audioDevices.count
      || configuration.socketDevices.count || configuration.usbControllers.count) fail(@"unexpected-host-device", nil);
  if (![configuration validateWithError:&error]) fail(@"configuration-validation", error);
  report(@{@"configurationValidated": @YES, @"cpuCount": @(configuration.CPUCount), @"memoryBytes": @(configuration.memorySize),
    @"hostShares": @(self.bridge ? 2 : 0), @"readOnlyInput": @(self.bridge), @"networkDevices": @0, @"audioDevices": @0, @"usbDevices": @0});
  return configuration;
}
- (void)watchInstallation {
  self.monitor = [NSTimer scheduledTimerWithTimeInterval:10 repeats:YES block:^(NSTimer *timer) {
    struct statvfs disk = {0}; BOOL reserved = statvfs(self.root.fileSystemRepresentation, &disk) == 0 && (uint64_t)disk.f_bavail * disk.f_frsize >= 16ULL * 1024 * 1024 * 1024;
    struct stat guestDisk; uint64_t allocated = lstat(childURL(self.root, @"Disk.img").fileSystemRepresentation, &guestDisk) == 0 ? (uint64_t)guestDisk.st_blocks * 512 : 0;
    report(@{@"installationFraction": @(self.installer.progress.fractionCompleted), @"storageReserve": reserved ? @YES : @NO,
      @"availableBytes": @((uint64_t)disk.f_bavail * disk.f_frsize), @"allocatedGuestDiskBytes": @(allocated)});
    if (!reserved || -self.began.timeIntervalSinceNow > 1800) {
      [self.installer.progress cancel]; [timer invalidate];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ fail(@"installation-cancel-unverified", nil); });
    }
  }];
}
- (void)install {
  [VZMacOSRestoreImage loadFileURL:childURL(self.root, @"Restore.ipsw") completionHandler:^(VZMacOSRestoreImage *image, NSError *loadError) {
    dispatch_async(dispatch_get_main_queue(), ^{
      VZMacOSConfigurationRequirements *requirements = image.mostFeaturefulSupportedConfiguration;
      if (!image || loadError || !image.supported || ![image.buildVersion isEqualToString:@"26A434"] || !requirements
        || requirements.minimumSupportedCPUCount > 2 || requirements.minimumSupportedMemorySize > 4ULL * 1024 * 1024 * 1024) fail(@"restore-image-configuration", loadError);
      int fd = open(childURL(self.root, @"Disk.img").fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
      if (fd < 0) fail(@"owned-disk-create", nil);
      BOOL sized = ftruncate(fd, 48ULL * 1024 * 1024 * 1024) == 0; close(fd); if (!sized) fail(@"owned-disk-size", nil);
      VZMacPlatformConfiguration *platform = [[VZMacPlatformConfiguration alloc] init];
      platform.hardwareModel = requirements.hardwareModel; platform.machineIdentifier = [VZMacMachineIdentifier new];
      if (!writePrivate(platform.hardwareModel.dataRepresentation, childURL(self.root, @"HardwareModel"))
        || !writePrivate(platform.machineIdentifier.dataRepresentation, childURL(self.root, @"MachineIdentifier"))) fail(@"platform-record", nil);
      NSError *error = nil;
      platform.auxiliaryStorage = [[VZMacAuxiliaryStorage alloc] initCreatingStorageAtURL:childURL(self.root, @"AuxiliaryStorage") hardwareModel:platform.hardwareModel options:0 error:&error];
      if (!platform.auxiliaryStorage) fail(@"auxiliary-storage-create", error);
      self.vm = [[VZVirtualMachine alloc] initWithConfiguration:[self configuration:platform]]; self.vm.delegate = self;
      self.installer = [[VZMacOSInstaller alloc] initWithVirtualMachine:self.vm restoreImageURL:childURL(self.root, @"Restore.ipsw")];
      self.began = [NSDate date]; [self watchInstallation];
      [self.installer installWithCompletionHandler:^(NSError *installError) {
        [self.monitor invalidate]; if (installError) fail(@"installation", installError);
        void (^complete)(void) = ^{ report(@{@"installed": @YES, @"build": image.buildVersion, @"vmStopped": self.vm.state == VZVirtualMachineStateStopped ? @YES : @NO,
          @"milliseconds": @((long long)(-self.began.timeIntervalSinceNow * 1000))}); exit(self.vm.state == VZVirtualMachineStateStopped ? 0 : 1); };
        if (self.vm.state == VZVirtualMachineStateStopped) complete();
        else [self.vm stopWithCompletionHandler:^(NSError *stopError) { if (stopError) fail(@"post-install-stop", stopError); complete(); }];
      }];
    });
  }];
}
- (void)stop {
  if (self.finishing) return; self.finishing = YES;
  [self.vm stopWithCompletionHandler:^(NSError *error) {
    if (error) fail(@"bounded-stop", error);
    report(@{@"vmStopped": self.vm.state == VZVirtualMachineStateStopped ? @YES : @NO,
      @"milliseconds": @((long long)(-self.began.timeIntervalSinceNow * 1000))}); [self.window close]; exit(self.vm.state == VZVirtualMachineStateStopped && !self.bootDeadlineExceeded ? 0 : 1);
  }];
}
- (BOOL)capture:(NSString *)name {
  NSBitmapImageRep *bitmap = [self.view bitmapImageRepForCachingDisplayInRect:self.view.bounds];
  if (bitmap) [self.view cacheDisplayInRect:self.view.bounds toBitmapImageRep:bitmap];
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  return png && writePrivate(png, childURL(self.root, name));
}
- (void)captureAndStop {
  BOOL saved = [self capture:@"owned-guest-view.png"];
  report(@{@"ownedGuestViewCaptured": @(saved)}); [self stop];
}
- (void)deliver:(NSEvent *)event {
  NSResponder *receiver = self.window.firstResponder;
  if (self.vm.state != VZVirtualMachineStateRunning || self.window.contentView != self.view || !event
    || NSApp.keyWindow != self.window || event.window != self.window || event.windowNumber != self.window.windowNumber || ![receiver isKindOfClass:NSView.class]
    || ![(NSView *)receiver isDescendantOf:self.view]) fail(@"bridge-event-ownership", nil);
  [NSApp sendEvent:event];
}
- (void)modifier:(NSEventModifierFlags)flags code:(unsigned short)code {
  NSEvent *event = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:self.window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:code];
  [self deliver:event];
}
- (void)key:(unsigned short)code text:(NSString *)text flags:(NSEventModifierFlags)flags completion:(void (^)(void))completion {
  NSEvent *down = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:self.window.windowNumber context:nil characters:text charactersIgnoringModifiers:text.lowercaseString isARepeat:NO keyCode:code];
  [self deliver:down];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    NSEvent *up = [NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
      windowNumber:self.window.windowNumber context:nil characters:text charactersIgnoringModifiers:text.lowercaseString isARepeat:NO keyCode:code];
    [self deliver:up]; completion();
  });
}
- (void)typeFixed:(NSString *)text completion:(void (^)(void))completion {
  if (!text.length) { completion(); return; }
  NSDictionary *keys = @{@"a":@0,@"b":@11,@"c":@8,@"d":@2,@"e":@14,@"f":@3,@"g":@5,@"h":@4,@"i":@34,@"j":@38,@"k":@40,@"l":@37,@"m":@46,
    @"n":@45,@"o":@31,@"p":@35,@"q":@12,@"r":@15,@"s":@1,@"t":@17,@"u":@32,@"v":@9,@"w":@13,@"x":@7,@"y":@16,@"z":@6,@" ":@49,@"/":@44,@".":@47};
  NSString *letter = [text substringToIndex:1], *lower = letter.lowercaseString;
  NSNumber *code = keys[lower]; if (!code) fail(@"bridge-fixed-key", nil);
  NSEventModifierFlags flags = [letter isEqual:lower] ? 0 : NSEventModifierFlagShift;
  if (flags) [self modifier:flags code:56];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [self key:code.unsignedShortValue text:letter flags:flags completion:^{
      if (flags) [self modifier:0 code:56];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ [self typeFixed:[text substringFromIndex:1] completion:completion]; });
    }];
  });
}
- (void)bridgeBootstrap {
  if (self.vm.state != VZVirtualMachineStateRunning || self.window.contentView != self.view || self.window.windowNumber <= 0) fail(@"bridge-owned-view", nil);
  NSView *receiver = [self.view hitTest:NSMakePoint(NSMidX(self.view.bounds), NSMidY(self.view.bounds))];
  if (!receiver || ![receiver isDescendantOf:self.view] || ![self.window makeFirstResponder:receiver]) fail(@"bridge-event-receiver", nil);
  report(@{@"ownedEventReceiverVerified": @YES});
  [self modifier:NSEventModifierFlagCommand code:55]; [self modifier:NSEventModifierFlagCommand | NSEventModifierFlagShift code:56];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [self key:5 text:@"G" flags:NSEventModifierFlagCommand | NSEventModifierFlagShift completion:^{
      [self modifier:NSEventModifierFlagCommand code:56]; [self modifier:0 code:55];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (![self capture:@"bridge-path.png"]) fail(@"bridge-path-capture", nil);
        [self typeFixed:@"/Volumes/My Shared Files/input" completion:^{
          [self key:36 text:@"\r" flags:0 completion:^{
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
              if (![self capture:@"bridge-folder.png"]) fail(@"bridge-folder-capture", nil);
              [self typeFixed:@"Agent" completion:^{
                [self modifier:NSEventModifierFlagCommand code:55];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                  [self key:31 text:@"o" flags:NSEventModifierFlagCommand completion:^{
                    [self modifier:0 code:55]; report(@{@"fixedGuestBootstrapSent": @YES, @"hostGlobalInputPosted": @NO});
                  }];
                });
              }];
            });
          }];
        }];
      });
    }];
  });
}
- (void)watchBridge {
  self.monitor = [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
    NSDictionary *ready = readPrivateJSON(childURL(self.root, @"output/agent-ready.json"));
    if (ready && !self.clicked) {
      NSArray *keys = @[@"nonce",@"pid",@"window",@"buttonX",@"buttonY",@"neighborReadDenied",@"neighborWriteDenied",@"readOnlyWriteDenied",@"escapeLinkReadDenied",@"descendantDenied",@"targetBundle",@"signatureVerified",@"actualGuestWindowVerified"];
      if (ready.count != keys.count || ![ready[@"nonce"] isEqual:self.nonce]
        || ![ready[@"targetBundle"] isEqual:[NSString stringWithFormat:@"/Users/pipeliner/Library/Caches/pipeliner-54-app-%@/Target.app", self.nonce]]) fail(@"bridge-guest-binding", nil);
      for (NSString *key in keys) if (![key isEqual:@"nonce"] && ![key isEqual:@"targetBundle"] && ![ready[key] isKindOfClass:NSNumber.class]) fail(@"bridge-result-type", nil);
      double x = [ready[@"buttonX"] doubleValue], y = [ready[@"buttonY"] doubleValue];
      if (![ready[@"actualGuestWindowVerified"] isEqual:@YES] || [ready[@"pid"] intValue] < 2 || [ready[@"window"] intValue] < 1
        || !isfinite(x) || !isfinite(y) || x < 0 || x >= 1024 || y < 0 || y >= 768) fail(@"bridge-guest-window", nil);
      self.clicked = YES;
      if (![self capture:@"owned-guest-target.png"]) fail(@"bridge-target-capture", nil);
      report(@{@"ownedGuestTargetCaptured": @YES});
      NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSMakePoint(x, y) modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:self.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
      [self deliver:down];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        NSEvent *up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:NSMakePoint(x, y) modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
          windowNumber:self.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:0];
        [self deliver:up]; report(@{@"fixedGuestButtonActionSent": @YES});
      });
    }
    NSDictionary *result = readPrivateJSON(childURL(self.root, @"output/agent-result.json")), *stopped = readPrivateJSON(childURL(self.root, @"output/agent-stop.json"));
    if (result && stopped && [result[@"nonce"] isEqual:self.nonce] && [stopped[@"nonce"] isEqual:self.nonce]
      && [result[@"clicked"] isEqual:@YES] && [stopped[@"targetStopped"] isEqual:@YES] && [stopped[@"ownedGuestInstallRemoved"] isEqual:@YES]) {
      [timer invalidate]; report(@{@"guestTrialCompleted": @YES}); [self captureAndStop];
    }
  }];
}
- (void)boot {
  NSData *hardware = [NSData dataWithContentsOfURL:childURL(self.root, @"HardwareModel")], *identifier = [NSData dataWithContentsOfURL:childURL(self.root, @"MachineIdentifier")];
  if (!hardware.length || !identifier.length) fail(@"stored-platform-data", nil);
  VZMacPlatformConfiguration *platform = [[VZMacPlatformConfiguration alloc] init];
  platform.hardwareModel = [[VZMacHardwareModel alloc] initWithDataRepresentation:hardware];
  platform.machineIdentifier = [[VZMacMachineIdentifier alloc] initWithDataRepresentation:identifier];
  platform.auxiliaryStorage = [[VZMacAuxiliaryStorage alloc] initWithURL:childURL(self.root, @"AuxiliaryStorage")];
  if (!platform.hardwareModel.supported || !platform.machineIdentifier) fail(@"stored-platform-identity", nil);
  self.vm = [[VZVirtualMachine alloc] initWithConfiguration:[self configuration:platform]]; self.vm.delegate = self;
  [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  VZVirtualMachineView *view = [[VZVirtualMachineView alloc] initWithFrame:NSMakeRect(0, 0, 1024, 768)];
  self.view = view;
  view.virtualMachine = self.vm; view.capturesSystemKeys = NO;
  self.window = [[NSWindow alloc] initWithContentRect:view.frame styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Pipeliner · Isolated Mac qualification"; self.window.releasedWhenClosed = NO; self.window.contentView = view;
  [self.window center]; [self.window makeKeyAndOrderFront:nil]; [self.window makeFirstResponder:view];
  if (self.bridge) [NSApp activate];
  VZMacOSVirtualMachineStartOptions *options = [VZMacOSVirtualMachineStartOptions new];
  NSData *credentialData = [NSData dataWithContentsOfURL:childURL(self.root, @"guest-provisioning.json")];
  if (credentialData) {
    id credential = credentialData.length <= 1024 ? [NSJSONSerialization JSONObjectWithData:credentialData options:0 error:nil] : nil;
    if (![credential isKindOfClass:NSDictionary.class] || [credential count] != 1 || ![credential[@"password"] isKindOfClass:NSString.class] || [credential[@"password"] length] != 64) fail(@"guest-provisioning-data", nil);
    VZMacGuestProvisioningOptions *guest = [[VZMacGuestProvisioningOptions alloc] init];
    guest.fullName = @"Pipeliner Test"; guest.username = @"pipeliner"; guest.password = credential[@"password"];
    guest.logsInAutomatically = YES; guest.enablesRemoteLogin = NO; NSError *error = nil;
    if (![options setGuestProvisioningOptions:guest error:&error]) fail(@"guest-provisioning-options", error);
  }
  self.began = [NSDate date];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (self.bridge ? 240 : 180) * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (!self.finishing) { self.bootDeadlineExceeded = YES; report(@{@"bootDeadlineExceeded": @YES}); [self captureAndStop]; }
  });
  [self.vm startWithOptions:options completionHandler:^(NSError *error) {
    if (error) fail(@"guest-start", error);
    report(@{@"running": self.vm.state == VZVirtualMachineStateRunning ? @YES : @NO, @"nativeWindowCreated": self.window.windowNumber > 0 ? @YES : @NO, @"hostInputInjection": @NO});
    if (self.bridge) {
      NSDictionary *binding = readPrivateJSON(childURL(self.root, @"bridge.json"));
      if (binding.count != 1 || ![binding[@"nonce"] isKindOfClass:NSString.class] || [binding[@"nonce"] length] != 32) fail(@"bridge-host-binding", nil);
      self.nonce = binding[@"nonce"]; [self watchBridge];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 85 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ [self bridgeBootstrap]; });
    } else dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ [self captureAndStop]; });
  }];
}
- (void)guestDidStopVirtualMachine:(VZVirtualMachine *)virtualMachine {
  if (!self.finishing && !self.installer) fail(@"unexpected-guest-stop", nil);
}
- (void)virtualMachine:(VZVirtualMachine *)virtualMachine didStopWithError:(NSError *)error { fail(@"guest-runtime-stop", error); }
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    umask(077); if (argc != 3) return 2;
    NSString *mode = [NSString stringWithUTF8String:argv[1]], *root = [NSString stringWithUTF8String:argv[2]];
    struct stat info; char actual[PATH_MAX];
    if (![root.lastPathComponent hasPrefix:@"pipeliner-54-macos-worker-"] || ![root isAbsolutePath]
      || !realpath(root.fileSystemRepresentation, actual) || strcmp(root.fileSystemRepresentation, actual) != 0 || lstat(root.fileSystemRepresentation, &info) != 0
      || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 077) != 0) { report(@{@"failed": @"owned-root-validation"}); return 2; }
    MacQualification *probe = [MacQualification new]; probe.root = root; [probe armTermination];
    if ([mode isEqualToString:@"--input-shape"]) {
      [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
      NSWindow *owned = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
      owned.releasedWhenClosed = NO;
      NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:owned.windowNumber context:nil characters:@"g" charactersIgnoringModifiers:@"g" isARepeat:NO keyCode:5];
      __block NSUInteger local = 0;
      id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *received) { (void)received; local++; return nil; }];
      [owned sendEvent:event]; NSUInteger windowDispatch = local;
      [NSApp sendEvent:event]; NSUInteger appDispatch = local - windowDispatch;
      [NSApp postEvent:event atStart:NO];
      [NSApp nextEventMatchingMask:NSEventMaskKeyDown untilDate:[NSDate dateWithTimeIntervalSinceNow:0.1] inMode:NSDefaultRunLoopMode dequeue:YES];
      [NSEvent removeMonitor:monitor]; [owned close];
      report(@{@"constructedEventExists": @(event != nil), @"constructedEventHasCGEvent": @(event.CGEvent != NULL),
        @"nsKeyCode": @(event.keyCode), @"cgKeyCode": @(CGEventGetIntegerValueField(event.CGEvent,kCGKeyboardEventKeycode)),
        @"cgKeyboardType": @(CGEventGetIntegerValueField(event.CGEvent,kCGKeyboardEventKeyboardType)),
        @"windowDispatchMonitorCount": @(windowDispatch), @"appDispatchMonitorCount": @(appDispatch),
        @"queuedLocalMonitorCount": @(local - windowDispatch - appDispatch), @"ownedWindowShown": @NO, @"globalEventPosted": @NO}); return 0;
    }
    else if ([mode isEqualToString:@"--install"]) { [probe install]; CFRunLoopRun(); }
    else if ([mode isEqualToString:@"--boot"] || [mode isEqualToString:@"--bridge"]) { probe.bridge = [mode isEqualToString:@"--bridge"]; [probe boot]; [NSApp run]; }
    else return 2;
    return 1;
  }
}

#import <AppKit/AppKit.h>
#import <Virtualization/Virtualization.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <signal.h>

// Native qualification only. No host shares, network, clipboard, USB or provider sessions.
static void report(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static void fail(NSString *stage, NSError *error) { report(@{@"failed": stage, @"errorCode": @(error.code)}); exit(1); }
static NSURL *childURL(NSString *root, NSString *name) { return [NSURL fileURLWithPath:[root stringByAppendingPathComponent:name]]; }
static BOOL writePrivate(NSData *data, NSURL *url) {
  return [data writeToURL:url options:NSDataWritingWithoutOverwriting error:nil] && chmod(url.fileSystemRepresentation, 0600) == 0;
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
- (void)install;
- (void)boot;
- (void)armTermination;
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
  if (configuration.networkDevices.count || configuration.directorySharingDevices.count || configuration.audioDevices.count
      || configuration.socketDevices.count || configuration.usbControllers.count) fail(@"unexpected-host-device", nil);
  if (![configuration validateWithError:&error]) fail(@"configuration-validation", error);
  report(@{@"configurationValidated": @YES, @"cpuCount": @(configuration.CPUCount), @"memoryBytes": @(configuration.memorySize),
    @"hostShares": @0, @"networkDevices": @0, @"audioDevices": @0, @"usbDevices": @0});
  return configuration;
}
- (void)watchInstallation {
  self.monitor = [NSTimer scheduledTimerWithTimeInterval:10 repeats:YES block:^(NSTimer *timer) {
    struct statvfs disk; BOOL reserved = statvfs(self.root.fileSystemRepresentation, &disk) == 0 && (uint64_t)disk.f_bavail * disk.f_frsize >= 16ULL * 1024 * 1024 * 1024;
    report(@{@"installationFraction": @(self.installer.progress.fractionCompleted), @"storageReserve": reserved ? @YES : @NO});
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
      BOOL sized = ftruncate(fd, 64ULL * 1024 * 1024 * 1024) == 0; close(fd); if (!sized) fail(@"owned-disk-size", nil);
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
  view.virtualMachine = self.vm; view.capturesSystemKeys = NO;
  self.window = [[NSWindow alloc] initWithContentRect:view.frame styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Pipeliner · Isolated Mac qualification"; self.window.releasedWhenClosed = NO; self.window.contentView = view;
  [self.window center]; [self.window orderFront:nil];
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
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (!self.finishing) { self.bootDeadlineExceeded = YES; report(@{@"bootDeadlineExceeded": @YES}); [self stop]; }
  });
  [self.vm startWithOptions:options completionHandler:^(NSError *error) {
    if (error) fail(@"guest-start", error);
    report(@{@"running": self.vm.state == VZVirtualMachineStateRunning ? @YES : @NO, @"nativeWindowCreated": self.window.windowNumber > 0 ? @YES : @NO, @"hostInputInjection": @NO});
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
      if (bitmap) [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
      NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      BOOL saved = png && writePrivate(png, childURL(self.root, @"owned-guest-view.png"));
      report(@{@"ownedGuestViewCaptured": saved ? @YES : @NO}); [self stop];
    });
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
    if ([mode isEqualToString:@"--install"]) { [probe install]; CFRunLoopRun(); }
    else if ([mode isEqualToString:@"--boot"]) { [probe boot]; [NSApp run]; }
    else return 2;
    return 1;
  }
}

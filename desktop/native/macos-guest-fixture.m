#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>
#include <spawn.h>
#include <sys/wait.h>
#include <sys/stat.h>

// Original, synthetic qualification apps. They must never run in the host account.
static NSString *const input = @"/Volumes/My Shared Files/input";
static NSString *const output = @"/Volumes/My Shared Files/output";
static NSDictionary *configuration;
static NSURL *at(NSString *root, NSString *name) { return [NSURL fileURLWithPath:[root stringByAppendingPathComponent:name]]; }
static void save(NSString *name, NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  [data writeToURL:at(output, name) options:NSDataWritingAtomic error:nil];
}
static void guestFail(NSString *stage, int code) {
  save(@"agent-failed.json", @{@"nonce": configuration[@"nonce"], @"failed": stage}); exit(code);
}
static NSDictionary *load(NSString *name) {
  NSData *data = [NSData dataWithContentsOfURL:at(output, name)];
  id value = data.length > 0 && data.length <= 16384 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [value isKindOfClass:NSDictionary.class] && [value[@"nonce"] isEqual:configuration[@"nonce"]] ? value : nil;
}
static NSString *digest(NSData *data) {
  if (!data || data.length > 1024 * 1024) return nil;
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *text = [NSMutableString new]; for (NSUInteger i = 0; i < sizeof(hash); i++) [text appendFormat:@"%02x", hash[i]];
  return text;
}
static BOOL signature(NSURL *bundle) {
  SecStaticCodeRef code = NULL;
  OSStatus created = SecStaticCodeCreateWithPath((__bridge CFURLRef)bundle, kSecCSDefaultFlags, &code);
  BOOL valid = created == errSecSuccess && SecStaticCodeCheckValidity(code, kSecCSStrictValidate, NULL) == errSecSuccess;
  if (code) CFRelease(code); return valid;
}

@interface GuestQualification : NSObject <NSApplicationDelegate>
@property NSWindow *window;
@property NSButton *button;
@property NSRunningApplication *target;
@property NSURL *owned;
@property NSDate *began;
@property NSTimer *monitor;
@property BOOL ready;
- (void)clicked:(id)sender;
@end

@implementation GuestQualification
- (void)clicked:(id)sender {
  if (sender != self.button || self.window.windowNumber <= 0) exit(3);
  self.button.title = @"Recorded safely";
  save(@"target-clicked.json", @{@"nonce": configuration[@"nonce"], @"clicked": @YES, @"window": @(self.window.windowNumber), @"pid": @(NSProcessInfo.processInfo.processIdentifier)});
}
- (void)targetApp {
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 460, 240) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Pipeliner · Guest boundary target"; self.window.releasedWhenClosed = NO;
  NSTextField *label = [NSTextField labelWithString:@"Synthetic app in an isolated Mac. No host credentials."];
  label.frame = NSMakeRect(24, 155, 412, 48); [self.window.contentView addSubview:label];
  self.button = [[NSButton alloc] initWithFrame:NSMakeRect(24, 40, 210, 44)];
  self.button.title = @"Record safe click"; self.button.bezelStyle = NSBezelStyleRounded; self.button.target = self; self.button.action = @selector(clicked:);
  [self.window.contentView addSubview:self.button]; [self.window center]; [self.window makeKeyAndOrderFront:nil];
  [NSApp activate];
  NSRect frame = [self.window convertRectToScreen:[self.button convertRect:self.button.bounds toView:nil]];
  NSString *neighbor = configuration[@"neighbor"];
  BOOL neighborRead = [NSData dataWithContentsOfFile:[neighbor stringByAppendingPathComponent:@"seed"]] != nil;
  BOOL neighborWrite = [@"escaped" writeToFile:[neighbor stringByAppendingPathComponent:@"escaped"] atomically:NO encoding:NSUTF8StringEncoding error:nil];
  BOOL inputWrite = [@"unexpected" writeToURL:at(input, @"unexpected-write") atomically:NO encoding:NSUTF8StringEncoding error:nil];
  BOOL linkRead = [NSData dataWithContentsOfURL:at(input, @"escape-link")] != nil;
  if (![NSFileManager.defaultManager createSymbolicLinkAtURL:at(output, @"returned-link.json")
    withDestinationURL:at(neighbor, @"seed") error:nil]) exit(3);
  NSString *marker = [neighbor stringByAppendingPathComponent:@"descendant-escaped"];
  char *args[] = { "/usr/bin/touch", (char *)marker.fileSystemRepresentation, NULL }; char *environment[] = { "PATH=/usr/bin:/bin", NULL };
  pid_t child = 0; int status = 0; int spawned = posix_spawn(&child, "/usr/bin/touch", NULL, NULL, args, environment);
  if (spawned == 0) waitpid(child, &status, 0);
  save(@"target-ready.json", @{@"nonce": configuration[@"nonce"], @"pid": @(NSProcessInfo.processInfo.processIdentifier), @"window": @(self.window.windowNumber),
    @"buttonX": @(NSMidX(frame)), @"buttonY": @(NSMidY(frame)), @"neighborReadDenied": @(!neighborRead), @"neighborWriteDenied": @(!neighborWrite),
    @"readOnlyWriteDenied": @(!inputWrite), @"escapeLinkReadDenied": @(!linkRead), @"descendantDenied": @(spawned == 0 && WIFEXITED(status) && WEXITSTATUS(status) != 0)});
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:at(input, @"Escape.app") configuration:[NSWorkspaceOpenConfiguration new] completionHandler:^(NSRunningApplication *app, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      save(@"escape-launch.json", @{@"nonce": configuration[@"nonce"], @"launchedInGuest": @(app != nil && error == nil), @"pid": @(app.processIdentifier)});
    });
  }];
}
- (void)agentApp {
  save(@"agent-started.json", @{@"nonce": configuration[@"nonce"], @"started": @YES});
  NSFileManager *files = NSFileManager.defaultManager;
  self.owned = at([NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches"], [@"pipeliner-54-app-" stringByAppendingString:configuration[@"nonce"]]);
  if (![files createDirectoryAtURL:self.owned withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions: @0700} error:nil]) guestFail(@"guest-install-directory", 4);
  NSURL *target = [self.owned URLByAppendingPathComponent:@"Target.app"];
  if (![files copyItemAtURL:at(input, @"Target.app") toURL:target error:nil] || !signature(target)
    || ![digest([NSData dataWithContentsOfURL:[target URLByAppendingPathComponent:@"Contents/MacOS/fixture"]]) isEqual:configuration[@"targetSHA256"]]
    || ![[NSBundle bundleWithURL:target].bundleIdentifier isEqual:configuration[@"targetIdentifier"]]) guestFail(@"guest-install-integrity", 5);
  self.began = [NSDate date];
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:target configuration:[NSWorkspaceOpenConfiguration new] completionHandler:^(NSRunningApplication *app, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!app || error || ![app.bundleURL.path isEqual:target.path]) guestFail(@"guest-launch-identity", 6); self.target = app;
      self.monitor = [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
        NSDictionary *ready = load(@"target-ready.json"), *clicked = load(@"target-clicked.json"), *escaped = load(@"escape-witness.json");
        if (!self.ready && [ready[@"pid"] intValue] == app.processIdentifier && [ready[@"window"] intValue] > 0) {
          BOOL actualWindow = NO;
          NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
          for (NSDictionary *window in windows) if ([window[(id)kCGWindowOwnerPID] intValue] == app.processIdentifier
            && [window[(id)kCGWindowNumber] intValue] == [ready[@"window"] intValue]) actualWindow = YES;
          if (!actualWindow) return;
          NSMutableDictionary *reply = [ready mutableCopy]; reply[@"targetBundle"] = target.path; reply[@"signatureVerified"] = @YES; reply[@"actualGuestWindowVerified"] = @YES;
          save(@"agent-ready.json", reply); self.ready = YES;
        }
        if (self.ready && [clicked[@"clicked"] boolValue] && [clicked[@"pid"] intValue] == app.processIdentifier
          && [clicked[@"window"] isEqual:ready[@"window"]] && [escaped[@"hostWriteDenied"] boolValue]) {
          save(@"agent-result.json", @{@"nonce": configuration[@"nonce"], @"clicked": @YES, @"guestLaunchEscapeContained": @YES}); [timer invalidate];
          [app terminate];
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if (!app.terminated) { save(@"agent-stop.json", @{@"nonce": configuration[@"nonce"], @"targetStopped": @NO}); exit(7); }
            BOOL removed = [files removeItemAtURL:self.owned error:nil];
            save(@"agent-stop.json", @{@"nonce": configuration[@"nonce"], @"targetStopped": @YES, @"ownedGuestInstallRemoved": @(removed)}); exit(0);
          });
        } else if (-self.began.timeIntervalSinceNow > 80 || app.terminated) {
          save(@"agent-failed.json", @{@"nonce": configuration[@"nonce"], @"failed": @"guest-action-incomplete"}); [app terminate]; exit(8);
        }
      }];
    });
  }];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSString *role = [NSBundle.mainBundle objectForInfoDictionaryKey:@"PipelinerQualificationRole"];
  if ([role isEqual:@"target"]) [self targetApp];
  else if ([role isEqual:@"agent"]) [self agentApp];
  else if ([role isEqual:@"escape"]) {
    BOOL wrote = [@"escaped" writeToFile:[configuration[@"neighbor"] stringByAppendingPathComponent:@"launch-escaped"] atomically:NO encoding:NSUTF8StringEncoding error:nil];
    save(@"escape-witness.json", @{@"nonce": configuration[@"nonce"], @"hostWriteDenied": @(!wrote), @"pid": @(NSProcessInfo.processInfo.processIdentifier)}); exit(0);
  } else exit(2);
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    (void)argv;
    umask(077);
    if (argc != 1 || ![NSUserName() isEqual:@"pipeliner"] || ![NSHomeDirectory().lastPathComponent isEqual:@"pipeliner"]) return 2;
    NSData *data = [NSData dataWithContentsOfURL:at(input, @"qualification.json")];
    id value = data.length > 0 && data.length <= 4096 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![value isKindOfClass:NSDictionary.class] || [value count] != 4) return 2; configuration = value;
    for (NSString *key in @[@"nonce", @"neighbor", @"targetSHA256", @"targetIdentifier"]) if (![configuration[key] isKindOfClass:NSString.class]) return 2;
    NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
    if ([configuration[@"nonce"] length] != 32 || [configuration[@"nonce"] rangeOfCharacterFromSet:hex.invertedSet].location != NSNotFound
      || [configuration[@"targetSHA256"] length] != 64 || ![configuration[@"neighbor"] hasPrefix:@"/private/var/folders/"]
      || [configuration[@"neighbor"] length] > 2048 || ![configuration[@"targetIdentifier"] hasPrefix:@"com.pipeliner.qualification."]) return 2;
    [NSApplication sharedApplication]; GuestQualification *delegate = [GuestQualification new]; NSApp.delegate = delegate; [NSApp run]; return 1;
  }
}

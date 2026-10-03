#import <AppKit/AppKit.h>
#include <unistd.h>

// Bounded synthetic native qualification only. Never included in an application package.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *defaultMarker = [NSBundle.mainBundle objectForInfoDictionaryKey:@"PipelinerQualificationMarker"];
    if ((argc == 3 && strcmp(argv[1], "--escape") == 0) || defaultMarker) {
      NSString *markerPath = defaultMarker ?: [NSString stringWithUTF8String:argv[2]];
      if (![markerPath isAbsolutePath]) return 2;
      NSDictionary *marker = @{ @"pid": @(getpid()), @"bundle": NSBundle.mainBundle.bundlePath };
      NSData *data = [NSJSONSerialization dataWithJSONObject:marker options:0 error:nil];
      if (![data writeToFile:markerPath options:NSDataWritingAtomic error:nil]) return 2;
      usleep(2000000); return 0;
    }
    if (argc != 6 || strcmp(argv[1], "--target") != 0) return 2;
    NSString *neighbor = [NSString stringWithUTF8String:argv[2]], *writePath = [NSString stringWithUTF8String:argv[3]],
      *escape = [NSString stringWithUTF8String:argv[4]], *marker = [NSString stringWithUTF8String:argv[5]];
    if (![neighbor isAbsolutePath] || ![writePath isAbsolutePath] || ![escape isAbsolutePath] || ![marker isAbsolutePath]) return 2;
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSMutableDictionary *report = [@{ @"pid": @(getpid()), @"container": NSHomeDirectory(), @"bundle": NSBundle.mainBundle.bundlePath } mutableCopy];
    NSError *readError = nil, *writeError = nil;
    report[@"neighborReadDenied"] = [NSData dataWithContentsOfFile:neighbor options:0 error:&readError] == nil ? @YES : @NO;
    report[@"neighborWriteDenied"] = ![@"synthetic-only" writeToFile:writePath atomically:YES encoding:NSUTF8StringEncoding error:&writeError] ? @YES : @NO;
    NSTask *child = [NSTask new]; child.executableURL = [NSURL fileURLWithPath:@"/bin/cat"]; child.arguments = @[neighbor];
    child.standardOutput = [NSPipe pipe]; child.standardError = [NSPipe pipe]; NSError *childError = nil;
    @try {
      if ([child launchAndReturnError:&childError]) { [child waitUntilExit]; report[@"childReadDenied"] = child.terminationStatus != 0 ? @YES : @NO; }
      else report[@"childReadDenied"] = @YES;
    } @catch (NSException *exception) { report[@"childReadDenied"] = @YES; }
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 500, 180)
      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Pipeliner · Native boundary qualification"; window.releasedWhenClosed = NO;
    NSTextField *label = [NSTextField labelWithString:@"Synthetic app. Testing restrictions; no user data or permissions."];
    label.frame = NSMakeRect(20, 50, 460, 80); [window.contentView addSubview:label]; [window center]; [window orderFront:nil];
    report[@"nativeWindowCreated"] = window.windowNumber > 0 ? @YES : @NO;
    NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
    configuration.arguments = @[@"--escape", marker]; configuration.activates = NO; configuration.hides = YES;
    configuration.promptsUserIfNeeded = NO; configuration.createsNewApplicationInstance = YES;
    __block BOOL finished = NO;
    void (^finish)(void) = ^{
      if (finished) return; finished = YES;
      NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingSortedKeys error:nil];
      fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); [window close]; exit(0);
    };
    [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:escape] configuration:configuration
      completionHandler:^(NSRunningApplication *application, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
          report[@"launchServicesReturnedApp"] = application != nil ? @YES : @NO;
          if (application) report[@"escapePid"] = @(application.processIdentifier);
          report[@"launchServicesError"] = @(error ? error.code : 0);
          finish();
        });
      }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5000 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      if (!finished) { report[@"launchServicesTimedOut"] = @YES; finish(); }
    });
    [NSApp run]; return 0;
  }
}

#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <ServiceManagement/ServiceManagement.h>
#include <mach-o/dyld.h>

#ifndef PIPELINER_BUNDLE_ID
#define PIPELINER_BUNDLE_ID "com.zuriellabs.pipeliner.desktop"
#endif

int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc > 2 || (argc == 2 && strcmp(argv[1], "--settings") != 0)) return 64;
  uint32_t size = 0; _NSGetExecutablePath(NULL, &size); char *buffer = calloc(size, 1);
  if (!buffer || _NSGetExecutablePath(buffer, &size) != 0) { free(buffer); return 70; }
  NSString *executable = [[NSString stringWithUTF8String:buffer] stringByResolvingSymlinksInPath]; free(buffer);
  NSString *bundlePath = executable;
  for (int i = 0; i < 4; i++) bundlePath = [bundlePath stringByDeletingLastPathComponent];
  NSBundle *bundle = [NSBundle bundleWithPath:bundlePath];
  if (!bundle || ![bundle.bundleIdentifier isEqualToString:@PIPELINER_BUNDLE_ID] ||
      ![executable isEqualToString:[bundlePath stringByAppendingPathComponent:@"Contents/Library/LaunchServices/PipelinerBackground"]]) return 65;
  SecStaticCodeRef own = NULL, parent = NULL; CFDictionaryRef information = NULL; SecRequirementRef requirement = NULL;
  OSStatus result = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:executable], kSecCSDefaultFlags, &own);
  if (result == errSecSuccess) result = SecCodeCopySigningInformation(own, kSecCSSigningInformation, &information);
  NSString *team = information ? ((__bridge NSDictionary *)information)[(__bridge NSString *)kSecCodeInfoTeamIdentifier] : nil;
  if (!team || [team rangeOfString:@"^[A-Z0-9]{10}$" options:NSRegularExpressionSearch].location == NSNotFound) result = errSecCSUnsigned;
  NSString *rule = [NSString stringWithFormat:@"anchor apple generic and identifier \"%@\" and certificate leaf[subject.OU] = \"%@\"", @PIPELINER_BUNDLE_ID, team];
  if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)rule, kSecCSDefaultFlags, &requirement);
  if (result == errSecSuccess) result = SecStaticCodeCreateWithPath((__bridge CFURLRef)bundle.bundleURL, kSecCSDefaultFlags, &parent);
  if (result == errSecSuccess) result = SecStaticCodeCheckValidity(parent, kSecCSStrictValidate | kSecCSCheckNestedCode, requirement);
  if (parent) CFRelease(parent); if (requirement) CFRelease(requirement); if (information) CFRelease(information); if (own) CFRelease(own);
  if (result != errSecSuccess) return 66;
  if (argc == 2) { [SMAppService openSystemSettingsLoginItems]; return 0; }
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  configuration.activates = NO; configuration.addsToRecentItems = NO; configuration.createsNewApplicationInstance = NO;
  configuration.arguments = @[@"--background-helper"];
  __block BOOL done = NO, success = NO;
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:bundle.bundleURL configuration:configuration completionHandler:^(NSRunningApplication *application, NSError *error) { success = application != nil && error == nil; done = YES; }];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
  while (!done && [deadline timeIntervalSinceNow] > 0) [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  return success ? 0 : 69;
} }

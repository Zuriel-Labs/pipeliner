#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#include <unistd.h>
#include <sys/stat.h>

// Local qualification fixture only. This executable is never a product asset.
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc != 2) return 64;
  NSBundle *bundle = [NSBundle mainBundle]; NSString *identifier = bundle.bundleIdentifier;
  if (![identifier hasPrefix:@"com.zuriellabs.pipeliner.background-qualification."]) return 65;
  NSString *operation = [NSString stringWithUTF8String:argv[1]];
  if ([operation isEqualToString:@"--background-helper"]) {
    NSString *folder = [bundle.bundlePath stringByDeletingLastPathComponent]; struct stat info;
    if (lstat(folder.fileSystemRepresentation, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0700) return 66;
    NSData *receipt = [NSJSONSerialization dataWithJSONObject:@{ @"pid": @(getpid()), @"backgroundArgument": @YES, @"modelCalls": @0, @"githubCalls": @0 } options:0 error:nil];
    NSString *file = [folder stringByAppendingPathComponent:@"launched.json"];
    if (![receipt writeToFile:file options:NSDataWritingWithoutOverwriting error:nil] || chmod(file.fileSystemRepresentation, 0600)) return 70;
    return 0;
  }
  SMAppService *service = [SMAppService agentServiceWithPlistName:[identifier stringByAppendingString:@".background.plist"]];
  NSError *error = nil;
  if ([operation isEqualToString:@"--register"]) [service registerAndReturnError:&error];
  else if ([operation isEqualToString:@"--unregister"]) [service unregisterAndReturnError:&error];
  else if (![operation isEqualToString:@"--status"]) return 64;
  NSArray *names = @[@"not-registered", @"enabled", @"requires-approval", @"not-found"];
  NSInteger status = service.status;
  if (status < 0 || status >= (NSInteger)names.count) return 70;
  NSData *report = [NSJSONSerialization dataWithJSONObject:@{ @"status": names[status], @"errorCode": error ? @(error.code) : @0 } options:0 error:nil];
  fwrite(report.bytes, 1, report.length, stdout); fputc('\n', stdout); return 0;
} }

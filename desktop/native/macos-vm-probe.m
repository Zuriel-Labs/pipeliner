#import <Foundation/Foundation.h>
#import <Virtualization/Virtualization.h>

// Read-only host qualification. No restore download, disk, VM or guest account is created.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 1) return 2;
    __block int status = 1;
    [VZMacOSRestoreImage fetchLatestSupportedWithCompletionHandler:^(VZMacOSRestoreImage *image, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!image || error) { printf("{\"available\":false,\"errorCode\":%ld}\n", (long)error.code); }
        else {
          VZMacOSConfigurationRequirements *requirements = image.mostFeaturefulSupportedConfiguration;
          NSOperatingSystemVersion version = image.operatingSystemVersion;
          NSDictionary *report = @{ @"available": image.supported && requirements ? @YES : @NO,
            @"os": [NSString stringWithFormat:@"%ld.%ld.%ld", (long)version.majorVersion, (long)version.minorVersion, (long)version.patchVersion],
            @"build": image.buildVersion, @"restoreURL": image.URL.absoluteString,
            @"minimumCPUCount": @(requirements.minimumSupportedCPUCount), @"minimumMemoryBytes": @(requirements.minimumSupportedMemorySize) };
          NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingSortedKeys error:nil];
          fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); status = image.supported && requirements ? 0 : 1;
        }
        fflush(stdout); CFRunLoopStop(CFRunLoopGetMain());
      });
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      printf("{\"available\":false,\"timedOut\":true}\n"); fflush(stdout); CFRunLoopStop(CFRunLoopGetMain());
    });
    CFRunLoopRun(); return status;
  }
}

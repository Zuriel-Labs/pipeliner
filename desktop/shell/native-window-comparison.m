#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,600,400)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
    [window setTitle:@"Issue 15 native AppKit comparison"];
    [window makeKeyAndOrderFront:nil];
    [app activateIgnoringOtherApps:YES];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500*NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      printf("before minimize: visible=%d key=%d can=%d\n", window.visible, window.keyWindow, (window.styleMask & NSWindowStyleMaskMiniaturizable) != 0);
      [window miniaturize:nil];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2*NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        printf("after minimize: visible=%d minimized=%d\n", window.visible, window.miniaturized);
        int result = window.miniaturized ? 0 : 1;
        [window deminiaturize:nil];
        [window close];
        fflush(stdout);
        exit(result);
      });
    });
    [app run];
  }
  return 1;
}

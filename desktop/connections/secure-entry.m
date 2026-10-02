#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    if (argc == 2 && (strcmp(argv[1], "--folder-existing") == 0 || strcmp(argv[1], "--folder-parent") == 0)) {
      NSOpenPanel *panel = [NSOpenPanel openPanel];
      panel.canChooseDirectories = YES; panel.canChooseFiles = NO; panel.allowsMultipleSelection = NO; panel.resolvesAliases = YES;
      panel.title = @"Choose a project folder"; panel.prompt = @"Choose folder";
      panel.message = strcmp(argv[1], "--folder-existing") == 0 ? @"Choose your existing project. Pipeliner will inspect it without changing your work." : @"Choose where the new project folder will be created. Existing folders will be preserved.";
      [NSApp activateIgnoringOtherApps:YES];
      [panel beginWithCompletionHandler:^(NSModalResponse result) {
        NSDictionary *reply = result == NSModalResponseOK && panel.URL.isFileURL ? @{ @"path": panel.URL.path } : @{ @"cancelled": @YES };
        NSData *bytes = [NSJSONSerialization dataWithJSONObject:reply options:0 error:nil];
        fwrite(bytes.bytes, 1, bytes.length, stdout); fputc('\n', stdout); fflush(stdout);
        [NSApp stop:nil];
      }];
      [NSApp run];
      return 0;
    }
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:@"Connect Ollama Cloud"];
    [alert setInformativeText:@"Enter your API key. Pipeliner sends it only to Ollama Cloud and stores it with macOS Keychain protection. Never paste keys into chat."];
    [alert addButtonWithTitle:@"Connect"];
    [alert addButtonWithTitle:@"Cancel"];
    NSSecureTextField *field = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 0, 340, 32)];
    [field setPlaceholderString:@"Ollama Cloud API key"];
    [field setAccessibilityLabel:@"Ollama Cloud API key"];
    [alert setAccessoryView:field];
    [[alert window] setInitialFirstResponder:field];
    [NSApp activateIgnoringOtherApps:YES];
#ifdef PIPELINER_QUALIFY
    if ((argc == 2 || argc == 3) && strcmp(argv[1], "--qualify") == 0) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        [[alert window] makeFirstResponder:field];
        [[field currentEditor] insertText:@"synthetic-native-entry-only"];
        [[alert window] endEditingFor:field];
        if (argc == 3) {
          NSBitmapImageRep *bitmap = [field bitmapImageRepForCachingDisplayInRect:field.bounds];
          [field cacheDisplayInRect:field.bounds toBitmapImageRep:bitmap];
          [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithUTF8String:argv[2]] atomically:YES];
        }
        [[alert buttons][0] performClick:nil];
      });
    }
#endif
    NSModalResponse result = [alert runModal];
    NSDictionary *reply = result == NSAlertFirstButtonReturn ? @{ @"key": field.stringValue,
      @"secureField": @([field isKindOfClass:[NSSecureTextField class]]), @"accessibleName": @((BOOL)([field accessibilityLabel].length > 0)) } : @{ @"cancelled": @YES };
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:reply options:0 error:nil];
    fwrite(bytes.bytes, 1, bytes.length, stdout); fputc('\n', stdout); fflush(stdout);
    [field setStringValue:@""];
  }
  return 0;
}

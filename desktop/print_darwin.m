#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static WKWebView *findPrintWebView(NSView *view) {
    if ([view isKindOfClass:[WKWebView class]]) return (WKWebView *)view;
    for (NSView *child in view.subviews) {
        WKWebView *webView = findPrintWebView(child);
        if (webView) return webView;
    }
    return nil;
}

// Wait for the native operation, including dismissal, before the frontend
// removes its print document or enables another print request.
int printMailDocument(void) {
    // -1 means the API is unavailable; let the frontend use window.print().
    __block int presented = -1;
    void (^print)(void) = ^{
        if (@available(macOS 11.0, *)) {
            presented = 0;
            NSWindow *window = NSApp.mainWindow ?: NSApp.keyWindow;
            WKWebView *webView = findPrintWebView(window.contentView);
            if (!webView) return;
            @try {
                NSPrintInfo *info = [[NSPrintInfo sharedPrintInfo] copy];
                info.orientation = NSPaperOrientationPortrait;
                info.horizontalPagination = NSPrintingPaginationModeAutomatic;
                info.verticalPagination = NSPrintingPaginationModeAutomatic;
                info.horizontallyCentered = NO;
                info.verticallyCentered = NO;
                info.leftMargin = info.rightMargin = 15.0 * 72.0 / 25.4;
                info.topMargin = info.bottomMargin = 15.0 * 72.0 / 25.4;
                // Choose paper/margins before measuring HTML. WKWebView's native
                // print operation does not send the JavaScript beforeprint event.
                if ([[NSPrintPanel printPanel] runModalWithPrintInfo:info] != NSModalResponseOK) {
                    [info release];
                    presented = 1;
                    return;
                }
                CGFloat width = (info.paperSize.width - info.leftMargin - info.rightMargin) * 96.0 / 72.0;
                NSString *script = [NSString stringWithFormat:
                    @"document.getElementById('meron-print-document').style.setProperty('width', '%.4fpx', 'important'); window.dispatchEvent(new Event('beforeprint'));", width];
                __block BOOL measured = NO;
                __block BOOL measurementFailed = NO;
                [webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
                    measurementFailed = error != nil;
                    measured = YES;
                }];
                NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5.0];
                while (!measured && [deadline timeIntervalSinceNow] > 0) {
                    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                }
                if (!measured || measurementFailed) {
                    [info release];
                    return;
                }
                NSPrintOperation *operation = [webView printOperationWithPrintInfo:info];
                [info release];
                operation.showsPrintPanel = NO;
                operation.showsProgressPanel = YES;
                [operation runOperation];
                // A false result also means normal user cancellation.
                presented = 1;
            } @catch (NSException *exception) {
                presented = 0;
            }
        }
    };
    if ([NSThread isMainThread]) print();
    else dispatch_sync(dispatch_get_main_queue(), print);
    return presented;
}

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
int printMailDocument(const char *html) {
    // -1 means the API is unavailable; let the frontend use window.print().
    __block int presented = -1;
    void (^print)(void) = ^{
        if (@available(macOS 11.0, *)) {
            presented = -1;
            NSWindow *window = NSApp.mainWindow ?: NSApp.keyWindow;
            WKWebView *webView = findPrintWebView(window.contentView);
            if (!webView) return;
            WKWebView *printView = nil;
            @try {
                NSPrintInfo *info = [[NSPrintInfo sharedPrintInfo] copy];
                info.orientation = NSPaperOrientationPortrait;
                info.horizontalPagination = NSPrintingPaginationModeAutomatic;
                info.verticalPagination = NSPrintingPaginationModeAutomatic;
                info.horizontallyCentered = NO;
                info.verticallyCentered = NO;
                info.leftMargin = info.rightMargin = 15.0 * 72.0 / 25.4;
                info.topMargin = info.bottomMargin = 15.0 * 72.0 / 25.4;
                CGFloat width = (info.paperSize.width - info.leftMargin - info.rightMargin) * 96.0 / 72.0;
                // Retain Wails' local-media scheme handler, but not its injected
                // app scripts. Email scripts are also disabled by the print CSP.
                WKWebViewConfiguration *configuration = [webView.configuration copy];
                configuration.userContentController = [[[WKUserContentController alloc] init] autorelease];
                printView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, width, 800) configuration:configuration];
                [configuration release];
                [printView loadHTMLString:[NSString stringWithUTF8String:html] baseURL:webView.URL];
                NSDate *loadDeadline = [NSDate dateWithTimeIntervalSinceNow:30.0];
                while (printView.loading && [loadDeadline timeIntervalSinceNow] > 0) {
                    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                }
                if (printView.loading) {
                    [info release];
                    [printView stopLoading];
                    [printView release];
                    return;
                }
                NSString *script = @"for (const t of document.querySelectorAll('template[data-print-message]')) { const host = t.parentElement; const mail = new DOMParser().parseFromString(t.content.textContent, 'text/html'); host.attachShadow({mode:'open'}).append(document.importNode(mail.documentElement, true)); t.remove(); }";
                __block BOOL measured = NO;
                __block BOOL measurementFailed = NO;
                [printView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
                    measurementFailed = error != nil;
                    measured = YES;
                }];
                NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5.0];
                while (!measured && [deadline timeIntervalSinceNow] > 0) {
                    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                }
                if (!measured || measurementFailed) {
                    [info release];
                    [printView release];
                    return;
                }
                // Images in inert templates start loading only after attachment.
                NSDate *imageDeadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
                __block BOOL imagesReady = NO;
                while (!imagesReady && [imageDeadline timeIntervalSinceNow] > 0) {
                    __block BOOL checked = NO;
                    [printView evaluateJavaScript:@"Array.from(document.querySelectorAll('[data-print-body]')).every(s => s.shadowRoot && Array.from(s.shadowRoot.querySelectorAll('img')).every(i => i.complete))" completionHandler:^(id result, NSError *error) {
                        imagesReady = !error && [result boolValue];
                        checked = YES;
                    }];
                    while (!checked && [imageDeadline timeIntervalSinceNow] > 0) {
                        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                    }
                    if (!imagesReady) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
                }
                // Preparation may fall back without presenting a second dialog.
                // Once the panel is shown, failures must not trigger fallback.
                presented = 0;
                if ([[NSPrintPanel printPanel] runModalWithPrintInfo:info] != NSModalResponseOK) {
                    [info release];
                    [printView release];
                    presented = 1;
                    return;
                }
                width = (info.paperSize.width - info.leftMargin - info.rightMargin) * 96.0 / 72.0;
                [printView setFrameSize:NSMakeSize(width, 800)];
                NSPrintOperation *operation = [printView printOperationWithPrintInfo:info];
                [info release];
                operation.showsPrintPanel = NO;
                operation.showsProgressPanel = YES;
                [operation runOperation];
                [printView release];
                printView = nil;
                // A false result also means normal user cancellation.
                presented = 1;
            } @catch (NSException *exception) {
                [printView release];
                presented = 0;
            }
        }
    };
    if ([NSThread isMainThread]) print();
    else dispatch_sync(dispatch_get_main_queue(), print);
    return presented;
}

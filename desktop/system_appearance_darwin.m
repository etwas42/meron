#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

extern void goSystemAppearanceChanged(int dark);

// The system appearance is read from the AppleInterfaceStyle default rather
// than NSApp.effectiveAppearance: setAppAppearanceDark pins NSApp to the app's
// own theme, so its effective appearance no longer reflects the system. The
// default is "Dark" while the system is dark (Auto included) and absent in
// light mode; AppleInterfaceThemeChangedNotification fires when it flips.
@interface MeronAppearanceObserver : NSObject
@end

@implementation MeronAppearanceObserver
- (void)themeChanged:(NSNotification *)note {
    [self report];
}

- (void)report {
    NSString *style = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleInterfaceStyle"];
    goSystemAppearanceChanged([@"Dark" isEqualToString:style] ? 1 : 0);
}
@end

static MeronAppearanceObserver *meronAppearanceObserver = nil;

void setupAppearanceObserver() {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (meronAppearanceObserver == nil) {
            meronAppearanceObserver = [[MeronAppearanceObserver alloc] init];
        }
        [[NSDistributedNotificationCenter defaultCenter]
            addObserver:meronAppearanceObserver
               selector:@selector(themeChanged:)
                   name:@"AppleInterfaceThemeChangedNotification"
                 object:nil];
        [meronAppearanceObserver report];
    });
}

void teardownAppearanceObserver() {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (meronAppearanceObserver != nil) {
            [[NSDistributedNotificationCenter defaultCenter]
                removeObserver:meronAppearanceObserver];
        }
    });
}

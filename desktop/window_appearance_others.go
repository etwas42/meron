//go:build (!linux && !darwin && !windows) || (linux && bindings)

package main

// No native chrome to tint here.
func setNativeWindowDark(dark bool) {}

func setNativeTitlebarColors(bg, fg string) {}

func refreshNativeTitlebarCss() {}

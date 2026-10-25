//go:build !linux && !darwin && !windows

package main

// No system appearance source on this platform; the frontend falls back to
// prefers-color-scheme.
func (a *App) setupAppearanceListener() { systemAppearanceSettled() }

func (a *App) closeAppearanceListener() {}

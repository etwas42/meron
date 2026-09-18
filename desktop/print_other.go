//go:build !darwin && (!linux || !webkit2_41 || bindings)

package main

// Other platforms print directly in the frontend so JS errors reach its caller.
func printNativeMail(html string) (bool, error) {
	return false, nil
}

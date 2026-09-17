//go:build !darwin

package main

// Other platforms print directly in the frontend so JS errors reach its caller.
func printNativeMail() (bool, error) {
	return false, nil
}

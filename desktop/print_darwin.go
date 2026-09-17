//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework WebKit
int printMailDocument(void);
*/
import "C"

import "fmt"

func printNativeMail() (bool, error) {
	result := C.printMailDocument()
	if result < 0 {
		return false, nil
	}
	if result == 0 {
		return false, fmt.Errorf("could not present mail print dialog")
	}
	return true, nil
}

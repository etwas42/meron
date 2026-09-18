//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework WebKit
#include <stdlib.h>
int printMailDocument(const char *html);
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func printNativeMail(html string) (bool, error) {
	document := C.CString(html)
	defer C.free(unsafe.Pointer(document))
	result := C.printMailDocument(document)
	if result < 0 {
		return false, nil
	}
	if result == 0 {
		return false, fmt.Errorf("could not present mail print dialog")
	}
	return true, nil
}

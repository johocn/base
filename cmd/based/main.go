package main

import (
	"fmt"
	"os"
)

var version = "0.1.0"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	switch args[0] {
	case "version":
		fmt.Println("based " + version)
	case "import-md":
		must(runImportMD(args[1:]))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: based <version|import-md> [flags]")
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: "+err.Error())
		os.Exit(1)
	}
}
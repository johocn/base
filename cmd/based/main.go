package main

import (
	"fmt"
	"os"
)

var version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "version":
		fmt.Println("based " + version)
	case "import-md":
		err = runImportMD(os.Args[2:])
	case "export":
		err = runExport(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "pubkey":
		err = runPubkey(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	must(err)
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: based <version|import-md|export|serve|pubkey> [flags]")
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: "+err.Error())
		os.Exit(1)
	}
}
package main

import (
	"flag"
	"fmt"

	"github.com/johocn/base/internal/importer"
	"github.com/johocn/base/internal/store"
)

func runImportMD(args []string) error {
	fs := flag.NewFlagSet("import-md", flag.ExitOnError)
	dir := fs.String("dir", "seed", "markdown 目录")
	data := fs.String("data", "data", "数据目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := store.Open(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	res, err := importer.Run(st, *dir)
	if err != nil {
		return err
	}
	fmt.Printf("import-md: 导入 %d 篇，失败 %d 篇\n", res.Imported, res.Failed)
	for _, e := range res.Errors {
		fmt.Println("  ! " + e)
	}
	if res.Failed > 0 {
		return fmt.Errorf("import-md: %d 篇失败", res.Failed)
	}
	return nil
}
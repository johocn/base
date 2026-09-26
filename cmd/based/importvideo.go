package main

import (
	"flag"
	"fmt"

	"github.com/johocn/base/internal/importer"
	"github.com/johocn/base/internal/store"
)

// runImportVideo 把一个视频按定长 1 MiB 分块导入内容库（契约 §4.2）。
// item_id = lesson:<slug>；source=lesson、type=video、sqlite_table=media_meta、dist_class=public。
func runImportVideo(args []string) error {
	fs := flag.NewFlagSet("import-video", flag.ExitOnError)
	file := fs.String("file", "", "视频文件路径（必填）")
	slug := fs.String("slug", "", "slug（必填）；条目 id = lesson:<slug>")
	title := fs.String("title", "", "标题；空则取文件名")
	mime := fs.String("mime", "", "MIME；空则按扩展名推断")
	duration := fs.Int64("duration", 0, "时长（秒）；0 = 未知")
	data := fs.String("data", envOr("BASE_DATA", "data"), "数据目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := store.Open(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	res, err := importer.ImportVideo(st, importer.VideoOptions{
		Path: *file, Slug: *slug, Title: *title, MIME: *mime, Duration: *duration,
	})
	if err != nil {
		return err
	}
	fmt.Printf("import-video: %s 块数=%d 总字节=%d 本次写盘=%d content_hash=%s\n",
		res.ItemID, res.Chunks, res.TotalSize, res.Written, res.ContentHash)
	return nil
}

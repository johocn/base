// Command genvectors 生成协议黄金向量。用法：go run ./tools/genvectors -out vectors/v1
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/johocn/base/internal/protocol"
)

func main() {
	out := flag.String("out", filepath.Join("vectors", "v1"), "向量输出目录")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fail(err)
	}

	ids := []string{
		"00000000000000000000000000000001",
		"00000000000000000000000000000002",
		"00000000000000000000000000000003",
		"00000000000000000000000000000004",
		"00000000000000000000000000000005",
	}
	type merkleCase struct {
		Name    string   `json:"name"`
		BlobIDs []string `json:"blob_ids"`
		Root    string   `json:"merkle_root"`
	}
	cases := make([]merkleCase, 0, len(ids)+1)
	empty, err := protocol.MerkleRoot(nil)
	if err != nil {
		fail(err)
	}
	cases = append(cases, merkleCase{Name: "empty", BlobIDs: []string{}, Root: empty})
	for n := 1; n <= len(ids); n++ {
		root, err := protocol.MerkleRoot(ids[:n])
		if err != nil {
			fail(err)
		}
		cases = append(cases, merkleCase{
			Name:    fmt.Sprintf("leaves_%d", n),
			BlobIDs: ids[:n],
			Root:    root,
		})
	}
	doc := map[string]any{"version": 1, "cases": cases}
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		fail(err)
	}
	path := filepath.Join(*out, "merkle.json")
	if err := os.WriteFile(path, append(buf, '\n'), 0o644); err != nil {
		fail(err)
	}
	fmt.Println("wrote " + path)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "genvectors: "+err.Error())
	os.Exit(1)
}
// Command genvectors 生成协议黄金向量。用法：go run ./tools/genvectors -out vectors/v1
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 与 RFC 8032 §7.1 TEST 1 相同的确定性测试密钥。
const testSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func main() {
	out := flag.String("out", filepath.Join("vectors", "v1"), "向量输出目录")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fail(err)
	}
	if err := writeMerkle(*out); err != nil {
		fail(err)
	}
	if err := writeManifest(*out); err != nil {
		fail(err)
	}
	if err := writeIdentity(*out); err != nil {
		fail(err)
	}
	if err := writeRequestSig(*out); err != nil {
		fail(err)
	}
	if err := writeRelease(*out); err != nil {
		fail(err)
	}
	if err := writeSeats(*out); err != nil {
		fail(err)
	}
}

func writeMerkle(out string) error {
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
		return err
	}
	cases = append(cases, merkleCase{Name: "empty", BlobIDs: []string{}, Root: empty})
	for n := 1; n <= len(ids); n++ {
		root, err := protocol.MerkleRoot(ids[:n])
		if err != nil {
			return err
		}
		cases = append(cases, merkleCase{Name: fmt.Sprintf("leaves_%d", n), BlobIDs: ids[:n], Root: root})
	}
	return writeJSON(filepath.Join(out, "merkle.json"), map[string]any{"version": 1, "cases": cases})
}

// writeManifest 用一次确定性的真实导出产出 manifest 黄金向量。
func writeManifest(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	if kp.PubHex != "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" {
		return fmt.Errorf("测试密钥与 RFC 8032 TEST 1 不符: %s", kp.PubHex)
	}
	dir, err := os.MkdirTemp("", "genvectors-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	st, err := store.Open(dir)
	if err != nil {
		return err
	}
	defer st.Close()

	write := func(id, title, body string) error {
		return st.UpsertArticle(store.Article{
			ItemID: id, Title: title, Digest: title, PublishedAt: "2026-01-01T00:00:00Z",
			TagsJSON: `["演示","向量"]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
			SourceRev: "rev-1", UpdatedAt: "2026-01-02T03:04:05Z",
		})
	}
	if err := write("article:demo-1", "演示一", "demo body 1\n"); err != nil {
		return err
	}
	if err := write("article:demo-2", "演示二", "demo body 2\n"); err != nil {
		return err
	}
	cover := []byte("\x89PNG\r\n\x1a\n0123456789")
	if err := st.PutBlob(protocol.BlobID(cover), cover, "cover:demo-1", 0); err != nil {
		return err
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: "cover:demo-1", Source: "article", Type: "cover", Title: "封面",
		SourceRev: "rev-1", ContentHash: protocol.SHA256Hex(cover), MIME: "image/png",
		Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)}, UpdatedAt: "2026-01-02T03:04:05Z",
	}); err != nil {
		return err
	}
	if err := st.AddTombstone("article:retired", 2); err != nil {
		return err
	}

	res, err := packexport.Export(st, packexport.Options{
		Issuer: "base-node-1", SignKeyHex: testSeed, Version: 7,
		IssuedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	})
	if err != nil {
		return err
	}
	signBytes, err := res.Manifest.SignBytes()
	if err != nil {
		return err
	}
	case0 := map[string]any{
		"name":            "sample_pack_v7",
		"pack_id":         res.PackID,
		"content_version": res.ContentVersion,
		"merkle_root":     res.MerkleRoot,
		"entries":         res.Entries,
		"pack_sha256":     res.PackSHA256,
		"manifest_sha256": res.ManifestSHA256,
		"sign_bytes":      string(signBytes),
		"manifest":        res.Manifest,
	}
	return writeJSON(filepath.Join(out, "manifest.json"), map[string]any{
		"version": 1,
		"key":     map[string]any{"seed_hex": testSeed, "pub_hex": kp.PubHex},
		"cases":   []any{case0},
	})
}

// writeIdentity 产出身份 id 黄金向量：固定种子 → 期望公钥 → 期望 id。
func writeIdentity(out string) error {
	seeds := []struct{ name, seed string }{
		{"rfc8032_test1", testSeed},
		{"second_key", "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"},
	}
	type identityCase struct {
		Name    string `json:"name"`
		SeedHex string `json:"seed_hex"`
		PubHex  string `json:"pub_hex"`
		Alg     string `json:"alg"`
		ID      string `json:"id"`
	}
	cases := make([]identityCase, 0, len(seeds))
	for _, s := range seeds {
		kp, err := protocol.KeyPairFromSeed(s.seed)
		if err != nil {
			return err
		}
		id, err := protocol.IdentityID(kp.PubHex)
		if err != nil {
			return err
		}
		cases = append(cases, identityCase{
			Name: s.name, SeedHex: kp.SeedHex, PubHex: kp.PubHex, Alg: protocol.AlgEd25519, ID: id,
		})
	}
	return writeJSON(filepath.Join(out, "identity.json"), map[string]any{"version": 1, "cases": cases})
}

// writeRequestSig 产出请求签名黄金向量：固定请求元组 → 期望待签字节 + 期望签名。
func writeRequestSig(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	type reqCase struct {
		Name         string `json:"name"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		Query        string `json:"query"`
		BodySHA256   string `json:"body_sha256"`
		TS           int64  `json:"ts"`
		Nonce        string `json:"nonce"`
		SignBytes    string `json:"sign_bytes"`
		SignatureHex string `json:"signature_hex"`
	}
	metas := []struct {
		name string
		m    protocol.RequestMeta
	}{
		{"get_me_no_body", protocol.RequestMeta{
			Method: "GET", Path: "/v1/me", Query: "",
			BodySHA256: protocol.EmptyBodySHA256(),
			TS:         1790000000000, Nonce: "00112233445566778899aabbccddeeff",
		}},
		{"put_escrow_with_query_and_body", protocol.RequestMeta{
			Method: "PUT", Path: "/v1/identity/escrow/alice", Query: "force=1",
			BodySHA256: protocol.SHA256Hex([]byte(`{"id":"aa"}`)),
			TS:         1790000000123, Nonce: "ffeeddccbbaa99887766554433221100",
		}},
	}
	cases := make([]reqCase, 0, len(metas))
	for _, it := range metas {
		sb, err := protocol.RequestSignBytes(it.m)
		if err != nil {
			return err
		}
		sig, err := protocol.Sign(testSeed, sb)
		if err != nil {
			return err
		}
		cases = append(cases, reqCase{
			Name: it.name, Method: it.m.Method, Path: it.m.Path, Query: it.m.Query,
			BodySHA256: it.m.BodySHA256, TS: it.m.TS, Nonce: it.m.Nonce,
			SignBytes: string(sb), SignatureHex: sig,
		})
	}
	return writeJSON(filepath.Join(out, "reqsig.json"), map[string]any{
		"version": 1, "seed_hex": kp.SeedHex, "pub_hex": kp.PubHex, "cases": cases,
	})
}

// writeRelease 产出一份确定性的 release 文档黄金向量：固定 payload → 待签字节 → 签名。
func writeRelease(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	doc := protocol.ReleaseDoc{Payload: protocol.ReleasePayload{
		SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-09-27T00:00:00Z",
		VersionName: "0.2.0", MinVersionName: "0.1.0",
		ApkURL: "http://node.example.com/dl/base-0.2.0.apk", ApkSize: 12345678,
		ApkSHA256: strings.Repeat("ab", 32), Notes: "课程、答题与我的；四 tab 定稿",
	}}
	if err := doc.SignWith(testSeed); err != nil {
		return err
	}
	signBytes, err := doc.ReleaseSignBytes()
	if err != nil {
		return err
	}
	raw, err := doc.MarshalCanonical()
	if err != nil {
		return err
	}
	return writeJSON(filepath.Join(out, "release.json"), map[string]any{
		"version": 1,
		"key":     map[string]any{"seed_hex": testSeed, "pub_hex": kp.PubHex},
		"cases": []any{map[string]any{
			"name":          "release_0_2_0",
			"sign_bytes":    string(signBytes),
			"signature_hex": doc.Signature,
			"doc_sha256":    protocol.SHA256Hex(raw),
			"doc":           doc,
		}},
	})
}

// writeSeats 产出席位派生黄金向量：GovernorSeats / Quorums / EventWatermark / ContributionRank / DeriveSeats。
func writeSeats(out string) error {
	type govCase struct {
		Name   string `json:"name"`
		M      int    `json:"m,omitempty"`
		K      int    `json:"k,omitempty"`
		Remove int    `json:"remove,omitempty"`
		DP     int    `json:"dp,omitempty"`
		DV     int    `json:"dv,omitempty"`
		Seats  int    `json:"seats,omitempty"`
	}
	type watermarkCase struct {
		Name      string   `json:"name"`
		IDs       []string `json:"ids"`
		Watermark string   `json:"watermark"`
	}
	type rankEv struct {
		EventID   string `json:"event_id"`
		Actor     string `json:"actor"`
		CreatedAt int64  `json:"created_at"`
	}
	type rankCase struct {
		Name    string   `json:"name"`
		Members []string `json:"members"`
		Events  []rankEv `json:"events"`
		Ranked  []string `json:"ranked"`
	}
	type deriveEv struct {
		EventID   string `json:"event_id"`
		ID        string `json:"id"`
		CreatedAt int64  `json:"created_at"`
		BodyJSON  string `json:"body_json"`
	}
	type deriveCase struct {
		Name      string     `json:"name"`
		Members   []string   `json:"members"`
		Creator   string     `json:"creator"`
		RosterRev int64      `json:"roster_rev"`
		Epoch     int64      `json:"epoch"`
		Events    []deriveEv `json:"events"`
		Seats     int        `json:"seats"`
		Ranked    []string   `json:"ranked"`
		Governors []string   `json:"governors"`
		Decidable bool       `json:"decidable"`
		Watermark string     `json:"watermark"`
	}

	toRankEvs := func(in []store.RankInput) []rankEv {
		out := make([]rankEv, len(in))
		for i, e := range in {
			out[i] = rankEv{EventID: e.EventID, Actor: e.Actor, CreatedAt: e.CreatedAt}
		}
		return out
	}
	toDeriveEvs := func(in []store.Event) []deriveEv {
		out := make([]deriveEv, len(in))
		for i, e := range in {
			out[i] = deriveEv{EventID: e.EventID, ID: e.ID, CreatedAt: e.CreatedAt, BodyJSON: e.BodyJSON}
		}
		return out
	}

	// — Section 1: GovernorSeats + Quorums —
	govCases := []govCase{
		{Name: "m1_k1", M: 1, Seats: store.GovernorSeats(1)},
		{Name: "m10_k1", M: 10, Seats: store.GovernorSeats(10)},
		{Name: "m11_k3", M: 11, Seats: store.GovernorSeats(11)},
		{Name: "m30_k5", M: 30, Seats: store.GovernorSeats(30)},
		{Name: "m100_k10_cap", M: 100, Seats: store.GovernorSeats(100)},
		{Name: "m101_k10_cap", M: 101, Seats: store.GovernorSeats(101)},
		{Name: "quorum_remove_k1", K: 1, Remove: store.RemoveQuorum(1)},
		{Name: "quorum_remove_k3", K: 3, Remove: store.RemoveQuorum(3)},
		{Name: "quorum_remove_k10", K: 10, Remove: store.RemoveQuorum(10)},
		{Name: "quorum_dissolve_proposer_k1", K: 1, DP: store.DissolveProposerQuorum(1)},
		{Name: "quorum_dissolve_proposer_k2", K: 2, DP: store.DissolveProposerQuorum(2)},
		{Name: "quorum_dissolve_proposer_k10", K: 10, DP: store.DissolveProposerQuorum(10)},
		{Name: "quorum_dissolve_vote_m1", M: 1, DV: store.DissolveVoteQuorum(1)},
		{Name: "quorum_dissolve_vote_m30", M: 30, DV: store.DissolveVoteQuorum(30)},
		{Name: "quorum_dissolve_vote_m90", M: 90, DV: store.DissolveVoteQuorum(90)},
	}

	// — Section 2: EventWatermark —
	watermarkCases := []watermarkCase{
		{Name: "watermark_empty", IDs: []string{}, Watermark: store.EventWatermark(nil)},
		{Name: "watermark_single", IDs: []string{"abc"}, Watermark: store.EventWatermark([]string{"abc"})},
		{Name: "watermark_reordered", IDs: []string{"c", "a", "b"}, Watermark: store.EventWatermark([]string{"c", "a", "b"})},
		{Name: "watermark_dup_removed", IDs: []string{"a", "a", "b"}, Watermark: store.EventWatermark([]string{"a", "a", "b"})},
	}

	// — Section 3: ContributionRank —
	eqMembers := []string{"a", "b", "c", "d"}
	eqEvents := []store.RankInput{
		{EventID: "e1", Actor: "a", CreatedAt: 1_000},
		{EventID: "e2", Actor: "b", CreatedAt: 1_000},
		{EventID: "e3", Actor: "d", CreatedAt: 1_000},
		{EventID: "e4", Actor: "a", CreatedAt: 2_000},
		{EventID: "e5", Actor: "b", CreatedAt: 2_000},
	}

	brushMembers := []string{"a", "b"}
	brushEvents := make([]store.RankInput, 0, 30)
	for i := 0; i < 25; i++ {
		brushEvents = append(brushEvents, store.RankInput{
			EventID: fmt.Sprintf("ba_%02d", i), Actor: "a", CreatedAt: int64(i) * 1000,
		})
	}
	for i := 0; i < 5; i++ {
		brushEvents = append(brushEvents, store.RankInput{
			EventID: fmt.Sprintf("bb_%02d", i), Actor: "b", CreatedAt: int64(i)*1000 + 500,
		})
	}

	rmMembers := []string{"a", "b"}
	rmEvents := []store.RankInput{
		{EventID: "r1", Actor: "a", CreatedAt: 1},
		{EventID: "r2", Actor: "b", CreatedAt: 1},
		{EventID: "r3", Actor: "c", CreatedAt: 1},
	}

	zeroMembers := []string{"a", "b", "c", "d"}

	rankCases := []rankCase{
		{Name: "equal_count_tiebreak", Members: eqMembers, Events: toRankEvs(eqEvents), Ranked: store.ContributionRank(eqEvents, eqMembers)},
		{Name: "brush_window", Members: brushMembers, Events: toRankEvs(brushEvents), Ranked: store.ContributionRank(brushEvents, brushMembers)},
		{Name: "removed_member_filter", Members: rmMembers, Events: toRankEvs(rmEvents), Ranked: store.ContributionRank(rmEvents, rmMembers)},
		{Name: "all_zero_msgs", Members: zeroMembers, Events: toRankEvs(nil), Ranked: store.ContributionRank(nil, zeroMembers)},
	}

	// — Section 4: DeriveSeats —
	members3 := []string{"a", "b", "c"}
	decK1Events := []store.Event{
		{EventID: "dk1_a", ID: "a", CreatedAt: 1000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk1_b", ID: "b", CreatedAt: 2000, BodyJSON: `{"action":"msg"}`},
	}
	decK1Snap := store.DeriveSeats(members3, "a", 1, 1, decK1Events)

	members15 := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"}
	decK3Events := []store.Event{
		{EventID: "dk3_b1", ID: "b", CreatedAt: 1000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk3_b2", ID: "b", CreatedAt: 2000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk3_b3", ID: "b", CreatedAt: 3000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk3_c1", ID: "c", CreatedAt: 1000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk3_c2", ID: "c", CreatedAt: 2000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk3_d1", ID: "d", CreatedAt: 1000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dk3_a1", ID: "a", CreatedAt: 1000, BodyJSON: `{"action":"msg"}`},
	}
	decK3Snap := store.DeriveSeats(members15, "a", 1, 1, decK3Events)

	undecEvents := []store.Event{}
	undecSnap := store.DeriveSeats(members15, "a", 1, 1, undecEvents)

	members5 := []string{"a", "b", "c", "d", "e"}
	k1NoRankSnap := store.DeriveSeats(members5, "a", 1, 1, []store.Event{})

	dedupEvents := []store.Event{
		{EventID: "dup1", ID: "a", CreatedAt: 1000, BodyJSON: `{"action":"msg"}`},
		{EventID: "dup1", ID: "a", CreatedAt: 2000, BodyJSON: `{"action":"msg"}`},
		{EventID: "nomsg1", ID: "b", CreatedAt: 1000, BodyJSON: `{"action":"roster"}`},
		{EventID: "msg2", ID: "b", CreatedAt: 2000, BodyJSON: `{"action":"msg"}`},
	}
	members4 := []string{"a", "b", "c", "d"}
	dedupSnap := store.DeriveSeats(members4, "a", 1, 1, dedupEvents)

	deriveCases := []deriveCase{
		{Name: "decidable_k1", Members: members3, Creator: "a", RosterRev: 1, Epoch: 1,
			Events: toDeriveEvs(decK1Events), Seats: decK1Snap.SeatCount, Ranked: decK1Snap.Ranked,
			Governors: decK1Snap.Governors, Decidable: decK1Snap.Decidable, Watermark: decK1Snap.Watermark},
		{Name: "decidable_k3", Members: members15, Creator: "a", RosterRev: 1, Epoch: 1,
			Events: toDeriveEvs(decK3Events), Seats: decK3Snap.SeatCount, Ranked: decK3Snap.Ranked,
			Governors: decK3Snap.Governors, Decidable: decK3Snap.Decidable, Watermark: decK3Snap.Watermark},
		{Name: "undecidable_empty_msgs_k3", Members: members15, Creator: "a", RosterRev: 1, Epoch: 1,
			Events: toDeriveEvs(undecEvents), Seats: undecSnap.SeatCount, Ranked: undecSnap.Ranked,
			Governors: undecSnap.Governors, Decidable: undecSnap.Decidable, Watermark: undecSnap.Watermark},
		{Name: "k1_no_ranking_needed", Members: members5, Creator: "a", RosterRev: 1, Epoch: 1,
			Events: toDeriveEvs(nil), Seats: k1NoRankSnap.SeatCount, Ranked: k1NoRankSnap.Ranked,
			Governors: k1NoRankSnap.Governors, Decidable: k1NoRankSnap.Decidable, Watermark: k1NoRankSnap.Watermark},
		{Name: "event_dedup_by_event_id", Members: members4, Creator: "a", RosterRev: 1, Epoch: 1,
			Events: toDeriveEvs(dedupEvents), Seats: dedupSnap.SeatCount, Ranked: dedupSnap.Ranked,
			Governors: dedupSnap.Governors, Decidable: dedupSnap.Decidable, Watermark: dedupSnap.Watermark},
	}

	doc := map[string]any{
		"version": 1,
		"sections": map[string]any{
			"governor_seats_and_quorums": govCases,
			"event_watermark":            watermarkCases,
			"contribution_rank":          rankCases,
			"derive_seats":               deriveCases,
		},
	}
	return writeJSON(filepath.Join(out, "seats.json"), doc)
}

func writeJSON(path string, doc any) error {
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(buf, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Println("wrote " + path)
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "genvectors: "+err.Error())
	os.Exit(1)
}

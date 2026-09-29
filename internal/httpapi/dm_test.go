package httpapi

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// dmPeerOf 造一个 32 hex 的收件人身份 id（形状与契约一致）。
func dmPeerOf(n int) string { return fmt.Sprintf("%032x", n) }

// newDmNode 复用既有测试节点，并登记 testSeed 身份（写事件必须先登记）。
func newDmNode(t *testing.T) (*store.Store, string) {
	t.Helper()
	st, _, ts := newTestServer(t)
	registerIdentitySeed(t, ts.URL, testSeed)
	return st, ts.URL
}

// dmEventBody 造一条 dm.v1 事件体并签内容签名，与 groupEventBody 同口径。
func dmEventBody(t *testing.T, seed, eventID string, body map[string]any) string {
	t.Helper()
	payload := map[string]any{
		"event_id": eventID, "type": "dm.v1",
		"created_at": time.Now().UnixMilli(), "body": body,
	}
	canon, err := protocol.Canonicalize(payload)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	sig, err := protocol.Sign(seed, canon)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	payload["sig"] = sig
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func postDmBody(t *testing.T, seed, baseURL, eventID string, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw := dmEventBody(t, seed, eventID, body)
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, baseURL+"/v1/event", raw))
}

func postDmMsg(t *testing.T, seed, baseURL, eventID, to, cipher string) string {
	t.Helper()
	status, out := postDmBody(t, seed, baseURL, eventID, map[string]any{"to": to, "text_cipher": cipher})
	if status != http.StatusOK {
		t.Fatalf("dm 事件 status=%d out=%v", status, out)
	}
	cid, _ := out["payload_cid"].(string)
	if !protocol.IsBlobID(cid) {
		t.Fatalf("payload_cid 不合法: %v", out)
	}
	return cid
}

// 验收 3：节点侧无明文——块里存的就是客户端密文，事件行与块目录原始字节都不含明文。
func TestDMMsgStoresCipherNotPlaintext(t *testing.T) {
	st, base := newDmNode(t)
	to := dmPeerOf(1)
	plain := "私信明文-绝不出现在节点"
	// 密文形态照 §3.3（base64url），确保既不等于也不包含明文
	cipher := "AbC-_" + hex.EncodeToString([]byte(plain))
	if cipher == plain || strings.Contains(cipher, plain) {
		t.Fatal("测试自身有误：密文不得等于或包含明文")
	}

	cid := postDmMsg(t, testSeed, base, eventIDOf(1), to, cipher)

	// 块内容等于客户端给的密文（节点不解密、不解释）
	got, err := st.GetBlobBytes(cid)
	if err != nil || string(got) != cipher {
		t.Fatalf("块内容应等于客户端密文 err=%v got=%q", err, got)
	}
	rawBlob, err := os.ReadFile(st.BlobPath(cid))
	if err != nil {
		t.Fatalf("读块文件: %v", err)
	}
	if strings.Contains(string(rawBlob), plain) {
		t.Fatal("块目录原始字节里出现了私信明文")
	}
	// 事件行：target_id 由 to 拼出，body_json 只留 payload_cid
	ev, ok, err := st.GetEventByID(eventIDOf(1))
	if err != nil || !ok {
		t.Fatalf("读事件行 err=%v ok=%v", err, ok)
	}
	if strings.Contains(ev.BodyJSON, cipher) || strings.Contains(ev.BodyJSON, plain) {
		t.Fatalf("events.body_json 泄漏了密文或明文: %s", ev.BodyJSON)
	}
	if ev.Type != "dm.v1" || ev.TargetID != "dm/"+to || ev.PayloadCID != cid {
		t.Fatalf("事件行投影异常: %+v", ev)
	}
}

// 验收 7：严格键集 / to 形态 / 密文长度，一律 400 event_param_invalid。
func TestDMContractValidation(t *testing.T) {
	_, base := newDmNode(t)
	to := dmPeerOf(2)

	// 多一个未知键（action / reply_to 都不属于 dm.v1）
	status, out := postDmBody(t, testSeed, base, eventIDOf(1), map[string]any{
		"to": to, "text_cipher": "aaa", "action": "msg",
	})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("未知键 status=%d out=%v, want 400/event_param_invalid", status, out)
	}

	// to 非 32 hex（31 位 / 非 hex 字符各一例）
	for _, bad := range []string{"0000000000000000000000000000000", "zz000000000000000000000000000000"} {
		status, out = postDmBody(t, testSeed, base, eventIDOf(2), map[string]any{
			"to": bad, "text_cipher": "aaa",
		})
		if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
			t.Fatalf("to=%q status=%d out=%v, want 400/event_param_invalid", bad, status, out)
		}
	}

	// 密文空 / 超 8192 字节（客户端明文上限 4096 是客户端自己的事，节点只看密文长度）
	for _, cipher := range []string{"", strings.Repeat("a", maxDMCipherBytes+1)} {
		status, out = postDmBody(t, testSeed, base, eventIDOf(3), map[string]any{
			"to": to, "text_cipher": cipher,
		})
		if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
			t.Fatalf("密文长度 status=%d out=%v, want 400/event_param_invalid", status, out)
		}
	}
}

// 验收 7 的次序：验签失败一律不落块（先验签、后落块，与 comment / group 同一次序）。
func TestDMSigInvalidDoesNotStoreBlob(t *testing.T) {
	st, base := newDmNode(t)
	seedB := strings.Repeat("ab", 32)
	registerIdentitySeed(t, base, seedB)
	cipher := "vv-" + hex.EncodeToString([]byte("不该落块的密文"))

	// 内容签名来自 B，请求头却用 A 的私钥 ⇒ actor=A 与内容签名不符
	raw := dmEventBody(t, seedB, eventIDOf(1), map[string]any{"to": dmPeerOf(3), "text_cipher": cipher})
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, base+"/v1/event", raw))
	if status != http.StatusForbidden || out["code"] != "event_sig_invalid" {
		t.Fatalf("错签名 status=%d out=%v, want 403/event_sig_invalid", status, out)
	}
	if ok, _, err := st.HasBlob(protocol.BlobID([]byte(cipher))); err != nil || ok {
		t.Fatalf("验签失败不得落块 ok=%v err=%v", ok, err)
	}
}

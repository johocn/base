package httpapi

import (
	"net/http"
	"testing"

	"github.com/johocn/base/internal/store"
)

// AC 1 / AC 8 / AC 9：节点读权按形态分支。
func TestGroupReadClosedCircleDenied(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(201)
	ids := seedGroupV2(t, st, ts.URL, gid, testSeed, 3, 1) // encrypted=1，ids[0] 是创建者
	url := ts.URL + "/v1/group/" + gid

	// 匿名读封闭圈 → 404 group_read_denied（不泄露存在性）。
	if status, out := doJSONMap(t, http.MethodGet, url, "", nil); status != http.StatusNotFound || out["code"] != "group_read_denied" {
		t.Fatalf("匿名读封闭圈 want 404 group_read_denied, got %d %v", status, out)
	}

	// 已登记但非成员：同样 404（不区分「不存在」与「无权」）。
	outsiderSeed := memberSeed(500)
	registerIdentitySeed(t, ts.URL, outsiderSeed)
	if status, out := sendAuth(t, signedRequest(t, outsiderSeed, http.MethodGet, url, "")); status != http.StatusNotFound || out["code"] != "group_read_denied" {
		t.Fatalf("非成员签名读封闭圈 want 404 group_read_denied, got %d %v", status, out)
	}

	// 成员：200，且名单与席位字段齐备。
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodGet, url, ""))
	if status != http.StatusOK {
		t.Fatalf("成员签名读 want 200, got %d %v", status, out)
	}
	grp, ok := out["group"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺 group: %v", out)
	}
	members, _ := grp["member_ids"].([]any)
	if len(members) != 3 || members[0] != ids[0] {
		t.Fatalf("member_ids 异常: %v (ids=%v)", members, ids)
	}
	if grp["encrypted"].(float64) != 1 || grp["roster_rev"].(float64) != 1 {
		t.Fatalf("形态字段异常: %v", grp)
	}
	if grp["seat_count"].(float64) != 1 {
		t.Fatalf("seat_count want 1(m=3), got %v", grp["seat_count"])
	}
	govs, _ := grp["governors"].([]any)
	if len(govs) < 1 {
		t.Fatalf("governors 应至少 1 个: %v", grp["governors"])
	}
	if envs, isArr := grp["envelopes"].([]any); !isArr || grp["envelopes"] == nil {
		t.Fatalf("envelopes 应为非 null 数组: %v", grp["envelopes"])
	} else if len(envs) != 0 {
		t.Fatalf("无信封时应为空数组: %v", envs)
	}
}

func TestGroupReadOpenCircleAnonymous(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(202)
	seedGroupV2(t, st, ts.URL, gid, testSeed, 3, 0) // encrypted=0

	status, out := doJSONMap(t, http.MethodGet, ts.URL+"/v1/group/"+gid, "", nil)
	if status != http.StatusOK {
		t.Fatalf("匿名读开放圈 want 200, got %d %v", status, out)
	}
	grp, _ := out["group"].(map[string]any)
	if grp["encrypted"].(float64) != 0 || grp["seat_count"].(float64) != 1 {
		t.Fatalf("开放圈形态字段错: %v", grp)
	}
	govs, _ := grp["governors"].([]any)
	if len(govs) != 1 {
		t.Fatalf("开放圈 governors want 1, got %v", grp["governors"])
	}
}

// 补充 11：解散后 member_ids 为空数组 ⇒ 读接口按「已解散」渲染，匿名也 200（内容已无意义）。
func TestGroupReadDissolved(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(203)
	ids := seedGroupV2(t, st, ts.URL, gid, testSeed, 3, 1)
	if err := st.PutGroupRosterV2(store.GroupRoster{
		GroupID: gid, CreatorID: ids[0], Epoch: 9, RosterRev: 9,
		Encrypted: 1, MemberIDsJSON: "[]", EventID: eventIDOf(902),
	}); err != nil {
		t.Fatalf("PutGroupRosterV2: %v", err)
	}
	if status, out := doJSONMap(t, http.MethodGet, ts.URL+"/v1/group/"+gid, "", nil); status != http.StatusOK {
		t.Fatalf("已解散圈 want 200, got %d %v", status, out)
	}
}

// 存量 0.9.3 用 v1 路径建的圈：body 不带 encrypted ⇒ 缺省封闭（1）⇒ 匿名读 404；显式 encrypted:0 ⇒ 200。
func TestGroupReadLegacyRowDefaultsEncrypted(t *testing.T) {
	_, _, ts := newTestServer(t)
	creatorID := registerIdentitySeed(t, ts.URL, testSeed)

	legacy := groupIDOf(204)
	if status, out := postGroupBody(t, testSeed, ts.URL, eventIDOf(4001), map[string]any{
		"group_id": legacy, "action": "roster", "epoch": 1, "member_ids": []string{creatorID},
	}); status != http.StatusOK {
		t.Fatalf("v1 建圈(缺省封闭) status=%d out=%v", status, out)
	}
	if status, out := doJSONMap(t, http.MethodGet, ts.URL+"/v1/group/"+legacy, "", nil); status != http.StatusNotFound || out["code"] != "group_read_denied" {
		t.Fatalf("存量圈默认封闭，匿名读应 404 group_read_denied，得 %d %v", status, out)
	}

	open := groupIDOf(205)
	if status, out := postGroupBody(t, testSeed, ts.URL, eventIDOf(4002), map[string]any{
		"group_id": open, "action": "roster", "epoch": 1, "member_ids": []string{creatorID}, "encrypted": 0,
	}); status != http.StatusOK {
		t.Fatalf("v1 建开放圈 status=%d out=%v", status, out)
	}
	if status, out := doJSONMap(t, http.MethodGet, ts.URL+"/v1/group/"+open, "", nil); status != http.StatusOK {
		t.Fatalf("显式 encrypted:0 应匿名可读，得 %d %v", status, out)
	}
}

// optionalAuth 不做静默匿名降级：只带一个签名头仍按 auth_missing_header 拒。
func TestGroupReadPartialAuthHeaderRejected(t *testing.T) {
	_, _, ts := newTestServer(t)
	id, _ := identityFromSeed(t, testSeed)
	url := ts.URL + "/v1/group/" + groupIDOf(206)
	status, out := doJSONMap(t, http.MethodGet, url, "", map[string]string{"X-Base-Id": id})
	if status != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("半带签名头 want 400 auth_missing_header, got %d %v", status, out)
	}
}

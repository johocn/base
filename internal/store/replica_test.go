package store

import "testing"

func TestBlobReplicaUpsertAndCount(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "块-A", "lesson:a", 0)

	n, err := st.CountBlobsWithoutReplica()
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("无副本块数 = %d, want 1", n)
	}

	if err := st.UpsertBlobReplica(id, "https://p1", 100); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := st.UpsertBlobReplica(id, "https://p1", 200); err != nil { // 幂等：同 (blob,peer) 只刷 seen_at
		t.Fatalf("upsert again: %v", err)
	}
	if err := st.UpsertBlobReplica(id, "https://p2", 100); err != nil {
		t.Fatalf("upsert p2: %v", err)
	}
	peers, err := st.ReplicaPeers(id)
	if err != nil {
		t.Fatalf("peers: %v", err)
	}
	if len(peers) != 2 || peers[0] != "https://p1" || peers[1] != "https://p2" {
		t.Fatalf("peers = %v, want [p1 p2]", peers)
	}
	if n, _ := st.CountBlobsWithoutReplica(); n != 0 {
		t.Fatalf("无副本块数 = %d, want 0", n)
	}
}

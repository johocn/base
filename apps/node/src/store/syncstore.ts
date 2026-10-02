// 出站端口：把既有 store 层（peersync.ts 的 D1 原子函数 + packimport.ts）聚合成 Go `*store.Store` 的形状，
// 让 peersync/packimport.ts、sync.ts 能逐行照抄 Go 的 `st.XXX(...)` 调用。
// 开库 recipe 照抄 store/store.ts 的 openStore（openHostDb + loadStoreKey + normalizeJournalMode）。
//
// 与 Go 的**有意差异**：Go 的 `ForceGroupRoster` 用 `res.RowsAffected() > 0` 判定是否实际写入；
// node-sqlite3-wasm 的 `run` 不返回变更行数，故改为「先 SELECT epoch，再决定是否执行 INSERT...ON CONFLICT」。
// SQL 文本与 Go 逐字一致（含换行与制表符）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { UPSERT_PACK_SQL } from "@base/core-ts";
import type { PackRecord } from "@base/core-ts";
import { openHostDb, normalizeJournalMode, type HostDb, type SqlValue } from "../host/sqlite";
import { loadStoreKey, type StoreKeyOptions } from "../host/storekey";
import { migrate, schemaStatements } from "./schema";
import { importPack, type ImportResult, type PackEntry } from "./packimport";
import {
  putEvent as putEventOf,
  putProgressProjection as putProgressProjectionOf,
  type EventRow,
  type ProgressProjection,
} from "./events";
import type { GroupRoster } from "./group";
import {
  projectGovernProposal as projectGovernProposalOf,
  projectGovernVote as projectGovernVoteOf,
  settleGovernProposal as settleGovernProposalOf,
  type GovernProposalEvent,
  type GovernVoteEvent,
} from "./governProjection";
import { contributorRoster as contributorRosterOf, type Contributor } from "../routes/derived";
import {
  contentVersion,
  countBlobsWithoutReplica,
  deleteBlob as deleteBlobOf,
  deleteBlobFile as deleteBlobFileRow,
  eventBlobIndex as eventBlobIndexOf,
  getBlobBytes as getBlobBytesOf,
  getPeerCursor as getPeerCursorOf,
  hasBlob as hasBlobOf,
  hostDbAsDb,
  isRevokedPayload as isRevokedPayloadOf,
  listAllBlobIDs as listAllBlobIDsOf,
  listBlobsPage as listBlobsPageOf,
  listEventsAfter as listEventsAfterOf,
  listRevokedPayloads as listRevokedPayloadsOf,
  listTombstonesAfter as listTombstonesAfterOf,
  mediaChunkIndex as mediaChunkIndexOf,
  putCommentTombstone as putCommentTombstoneOf,
  putPeerCursor as putPeerCursorOf,
  putBlob as putBlobOf,
  replicaPeers as replicaPeersOf,
  upsertBlobReplica as upsertBlobReplicaOf,
  verifyBlobs as verifyBlobsOf,
  type BadBlob,
  type BlobRef,
  type CommentTombstone,
} from "./peersync";
import type { Tombstone } from "@base/protocol-ts";

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * ForceGroupRoster（group.go:107-125）的反熵接收侧写入：不校验 owner，只接受**更大的 epoch**，
 * 旧值静默忽略。SQL 逐字照抄 Go；返回值 = 是否实际写入（Go 用 RowsAffected，此处先查后写模拟）。
 */
function forceGroupRosterHost(db: HostDb, r: GroupRoster): boolean {
  let updatedAt = r.updatedAt;
  if (updatedAt === 0) updatedAt = Date.now();
  const cur = db.get(`SELECT epoch FROM groups WHERE group_id=?`, [r.groupId]);
  const curEpoch = cur === undefined ? null : Number(cur.epoch ?? 0);
  if (curEpoch !== null && r.epoch <= curEpoch) return false;
  db.run(
    `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
\t\t\tVALUES(?,?,?,?,?,?,?,?,?)
\t\t\tON CONFLICT(group_id) DO UPDATE SET
\t\t\t\tepoch=excluded.epoch, roster_rev=excluded.roster_rev, encrypted=excluded.encrypted,
\t\t\t\tmember_ids_json=excluded.member_ids_json, key_envelopes=excluded.key_envelopes,
\t\t\t\tevent_id=excluded.event_id, updated_at=excluded.updated_at
\t\t\tWHERE excluded.epoch > groups.epoch`,
    [
      r.groupId,
      r.creatorId,
      r.epoch,
      r.rosterRev,
      r.encrypted,
      r.memberIdsJson,
      r.keyEnvelopesJson,
      r.eventId,
      updatedAt,
    ] as SqlValue[],
  );
  return true;
}

/** 出站侧需要的 `*store.Store` 被调用面（对齐 Go peersync 里用到的全部方法）。 */
export interface SyncStore {
  readonly dataDir: string;
  packsDir(): string;
  contentVersion(): number;
  listAllBlobIDs(): string[];
  listBlobsPage(cursor: string, limit: number): { refs: BlobRef[]; next: string };
  mediaChunkIndex(): Record<string, BlobRef>;
  eventBlobIndex(): Record<string, BlobRef>;
  upsertBlobReplica(blobId: string, peer: string, seenAt: number): void;
  countBlobsWithoutReplica(): number;
  isRevokedPayload(cid: string): boolean;
  putBlob(blobId: string, data: Uint8Array, itemId: string, seq: number): void;
  getBlobBytes(blobId: string): Uint8Array;
  deleteBlobFile(blobId: string): void;
  verifyBlobs(ids: readonly string[]): { checked: number; bad: BadBlob[] };
  listEventsAfter(ts: number, id: string, limit: number): EventRow[];
  listTombstonesAfter(ts: number, id: string, limit: number): CommentTombstone[];
  getPeerCursor(peer: string, kind: string): { ts: number; id: string };
  putPeerCursor(peer: string, kind: string, ts: number, id: string): void;
  putCommentTombstone(t: CommentTombstone): void;
  putEvent(e: EventRow): void;
  forceGroupRoster(r: GroupRoster): boolean;
  putProgressProjection(e: ProgressProjection): void;
  projectGovernProposal(e: GovernProposalEvent): boolean;
  projectGovernVote(e: GovernVoteEvent): void;
  settleGovernProposal(proposalId: number, roster: Set<string>, rosterReady: boolean): void;
  contributorRoster(): Contributor[];
  listRevokedPayloads(): Set<string>;
  replicaPeers(blobId: string): string[];
  deleteBlob(blobId: string): void;
  hasBlob(blobId: string): { exists: boolean; size: number };
  importPack(version: number, entries: PackEntry[], tombstones: Tombstone[]): ImportResult;
  insertPack(rec: PackRecord): void;
  close(): void;
}

class SyncStoreImpl implements SyncStore {
  constructor(
    private readonly db: HostDb,
    readonly dataDir: string,
    private readonly storeKey: Uint8Array,
  ) {}

  close(): void {
    this.db.close();
  }

  packsDir(): string {
    return join(this.dataDir, "packs");
  }

  contentVersion(): number {
    return contentVersion(this.db);
  }

  listAllBlobIDs(): string[] {
    return listAllBlobIDsOf(this.db);
  }

  listBlobsPage(cursor: string, limit: number): { refs: BlobRef[]; next: string } {
    return listBlobsPageOf(this.db, cursor, limit);
  }

  mediaChunkIndex(): Record<string, BlobRef> {
    return mediaChunkIndexOf(this.db);
  }

  eventBlobIndex(): Record<string, BlobRef> {
    return eventBlobIndexOf(this.db);
  }

  upsertBlobReplica(blobId: string, peer: string, seenAt: number): void {
    upsertBlobReplicaOf(this.db, blobId, peer, seenAt);
  }

  countBlobsWithoutReplica(): number {
    return countBlobsWithoutReplica(this.db);
  }

  isRevokedPayload(cid: string): boolean {
    return isRevokedPayloadOf(this.db, cid);
  }

  putBlob(blobId: string, data: Uint8Array, itemId: string, seq: number): void {
    putBlobOf(hostDbAsDb(this.db), this.dataDir, this.storeKey, blobId, data, itemId, seq);
  }

  getBlobBytes(blobId: string): Uint8Array {
    return getBlobBytesOf(this.db, this.dataDir, this.storeKey, blobId);
  }

  deleteBlobFile(blobId: string): void {
    deleteBlobFileRow(this.db, this.dataDir, blobId);
  }

  verifyBlobs(ids: readonly string[]): { checked: number; bad: BadBlob[] } {
    return verifyBlobsOf(this.db, this.dataDir, this.storeKey, ids);
  }

  listEventsAfter(ts: number, id: string, limit: number): EventRow[] {
    return listEventsAfterOf(this.db, ts, id, limit);
  }

  listTombstonesAfter(ts: number, id: string, limit: number): CommentTombstone[] {
    return listTombstonesAfterOf(this.db, ts, id, limit);
  }

  getPeerCursor(peer: string, kind: string): { ts: number; id: string } {
    return getPeerCursorOf(this.db, peer, kind);
  }

  putPeerCursor(peer: string, kind: string, ts: number, id: string): void {
    putPeerCursorOf(this.db, peer, kind, ts, id);
  }

  putCommentTombstone(t: CommentTombstone): void {
    putCommentTombstoneOf(this.db, t);
  }

  putEvent(e: EventRow): void {
    putEventOf(hostDbAsDb(this.db), e);
  }

  forceGroupRoster(r: GroupRoster): boolean {
    return forceGroupRosterHost(this.db, r);
  }

  putProgressProjection(e: ProgressProjection): void {
    putProgressProjectionOf(hostDbAsDb(this.db), e);
  }

  projectGovernProposal(e: GovernProposalEvent): boolean {
    return projectGovernProposalOf(hostDbAsDb(this.db), e);
  }

  projectGovernVote(e: GovernVoteEvent): void {
    projectGovernVoteOf(hostDbAsDb(this.db), e);
  }

  settleGovernProposal(proposalId: number, roster: Set<string>, rosterReady: boolean): void {
    settleGovernProposalOf(hostDbAsDb(this.db), this.storeKey, proposalId, roster, rosterReady);
  }

  contributorRoster(): Contributor[] {
    return contributorRosterOf(hostDbAsDb(this.db), this.storeKey);
  }

  listRevokedPayloads(): Set<string> {
    return listRevokedPayloadsOf(this.db);
  }

  replicaPeers(blobId: string): string[] {
    return replicaPeersOf(this.db, blobId);
  }

  deleteBlob(blobId: string): void {
    deleteBlobOf(this.db, this.dataDir, blobId);
  }

  hasBlob(blobId: string): { exists: boolean; size: number } {
    return hasBlobOf(hostDbAsDb(this.db), this.dataDir, blobId);
  }

  importPack(version: number, entries: PackEntry[], tombstones: Tombstone[]): ImportResult {
    return importPack(this.db, this.dataDir, this.storeKey, version, entries, tombstones);
  }

  insertPack(rec: PackRecord): void {
    const createdAt = rec.createdAt === "" ? nowUTC() : rec.createdAt;
    this.db.run(UPSERT_PACK_SQL, [
      rec.packId,
      rec.contentVersion,
      rec.dir,
      rec.merkleRoot,
      rec.signature,
      rec.issuedAt,
      rec.itemCount,
      createdAt,
    ]);
  }
}

export interface OpenSyncStoreOptions extends StoreKeyOptions {
  /** true = 只读打开且不建目录/不建表、不写 pragma。仍会做一次性的 WAL→rollback 头归一化。 */
  readOnly?: boolean;
}

/** 打开/创建数据目录下的内容库出站端口（对齐 Go store.Open + openStore recipe）。 */
export function openSyncStore(dataDir: string, opts: OpenSyncStoreOptions = {}): SyncStore {
  const readOnly = opts.readOnly === true;
  if (!readOnly) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    mkdirSync(join(dataDir, "packs"), { recursive: true });
  }
  const { key } = loadStoreKey(dataDir, opts);
  const dbPath = join(dataDir, "base.db");
  // node-sqlite3-wasm 打不开 WAL 库，先把 Go 建的库头归一为 rollback。
  normalizeJournalMode(dbPath);
  const db = openHostDb(dbPath, { readOnly });
  if (readOnly) {
    db.exec("PRAGMA busy_timeout=5000");
    return new SyncStoreImpl(db, dataDir, key);
  }
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=DELETE");
  db.exec("PRAGMA foreign_keys=1");
  try {
    for (const stmt of schemaStatements) db.exec(stmt);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new SyncStoreImpl(db, dataDir, key);
}
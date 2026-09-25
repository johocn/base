import { describe, expect, it } from 'vitest';

import {
  blobId,
  derivePackId,
  manifestBlobIds,
  merkleRoot,
  sha256Hex,
  signManifest,
  utf8,
  type Entry,
  type Manifest,
  type Tombstone,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { syncOnce, type Catalog, type SyncOptions } from './sync';
import type { ArticleRow } from './types';

const BASE = 'https://node.test';

// 与 Go 侧、vectors/v1/ed25519.json 相同的 RFC 8032 §7.1 TEST 1 密钥
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

const COVER_TEXT = 'PNGCOVERBYTES';
const COVER = utf8(COVER_TEXT);

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function makeArticle(itemId: string, title: string, body: string): ArticleRow {
  return {
    itemId,
    title,
    digest: `${title}摘要`,
    publishedAt: '2026-01-01T00:00:00Z',
    tagsJson: '["演示"]',
    bodyMd: body,
    contentHash: sha256Hex(utf8(body)),
    rev: 'rev-1',
  };
}

interface NodeFixture {
  http: FakeHttp;
  pack: FakePackReader;
  catalog: Catalog;
  manifest: Manifest;
}

interface NodeOptions {
  tombstones?: Tombstone[];
  /** 从目录与条目中剔除的条目（模拟「已下架」） */
  omitArticles?: string[];
  withCover?: boolean;
  http?: FakeHttp;
}

function buildNode(version: number, options: NodeOptions = {}): NodeFixture {
  const http = options.http ?? new FakeHttp();
  const all = [
    makeArticle('article:aaa', '甲', '甲正文\n'),
    makeArticle('article:bbb', '乙', '乙正文\n'),
  ];
  const omitted = new Set(options.omitArticles ?? []);
  const articles = all.filter((a) => !omitted.has(a.itemId));

  const entries: Entry[] = all
    .filter((a) => !omitted.has(a.itemId))
    .map((a) => ({
      item_id: a.itemId,
      source: 'article',
      type: 'article',
      title: a.title,
      source_rev: a.rev,
      content_hash: a.contentHash,
      sqlite_table: 'articles',
      dist_class: 'public',
    }));

  const blobs = new Map<string, Uint8Array>();
  if (options.withCover) {
    const id = blobId(COVER);
    blobs.set(id, COVER);
    entries.push({
      item_id: 'cover:aaa',
      source: 'article',
      type: 'cover',
      title: '甲封面',
      source_rev: 'rev-1',
      content_hash: sha256Hex(COVER),
      sqlite_table: 'media_meta',
      chunks: [{ blob_id: id, size: COVER.length, seq: 0 }],
      dist_class: 'public',
    });
  }

  const merkle = merkleRoot(manifestBlobIds(entries));
  const packId = derivePackId('base-node-1', version, merkle);
  const manifest = signManifest(
    {
      pack_id: packId,
      schema_version: 1,
      issuer: 'base-node-1',
      issued_at: '2026-01-02T00:00:00Z',
      content_version: version,
      entries,
      tombstone: options.tombstones ?? [],
      merkle_root: merkle,
      signature: '',
    },
    SEED,
  );
  const catalog: Catalog = {
    pack_id: packId,
    content_version: version,
    items: entries
      .filter((e) => e.type === 'article')
      .map((e) => ({
        item_id: e.item_id,
        source: e.source,
        type: e.type,
        title: e.title,
        content_hash: e.content_hash,
        source_rev: e.source_rev,
      })),
    next_cursor: null,
  };

  http.routes.set(`${BASE}/v1/catalog`, json(catalog));
  http.routes.set(`${BASE}/v1/manifest/${packId}`, json(manifest));
  http.routes.set(`${BASE}/v1/pack/${packId}`, { status: 200, body: utf8('FAKEPACK') });
  for (const [id, data] of blobs) http.routes.set(`${BASE}/v1/blob/${id}`, { status: 200, body: data });

  const pack = new FakePackReader();
  pack.set(`/work/pack-${packId}.sqlite`, articles);
  return { http, pack, catalog, manifest };
}

function setup(fx: NodeFixture) {
  const repo = new MemoryRepo();
  const fs = new MemoryFs();
  const adapters: Adapters = fakeAdapters(fx.http, fs, fx.pack);
  const opts: SyncOptions = { adapters, repo, nodeBaseUrl: BASE, workDir: '/work' };
  return { repo, fs, adapters, opts };
}

describe('syncOnce', () => {
  it('首次同步：条目、正文、封面块全部落地并记住版本', async () => {
    const fx = buildNode(7, { withCover: true });
    const { repo, fs, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);

    const res = await syncOnce(opts);

    expect(res).toEqual({ status: 'updated', contentVersion: 7, items: 2, blobs: 1 });
    expect(await repo.getConfig('content_version')).toBe('7');
    expect(await repo.getConfig('pack_id')).toBe(fx.catalog.pack_id);
    expect((await repo.getArticle('article:aaa'))?.bodyMd).toBe('甲正文\n');
    expect((await repo.getItem('article:aaa'))?.state).toBe('active');
    expect(await repo.hasBlob(blobId(COVER))).toBe(true);
    expect(fs.files.has(`/work/blobs/${blobId(COVER)}`)).toBe(true);
  });

  it('版本未递增：noop，不再发起任何下载', async () => {
    const fx = buildNode(7, { withCover: true });
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);
    await syncOnce(opts);

    // 把块与 pack 路由都摘掉：noop 路径若还在请求就会 404 报错
    fx.http.routes.delete(`${BASE}/v1/blob/${blobId(COVER)}`);
    fx.http.routes.delete(`${BASE}/v1/pack/${fx.catalog.pack_id}`);

    expect(await syncOnce(opts)).toEqual({ status: 'noop', contentVersion: 7 });
  });

  it('未配置节点公钥：直接拒绝，不碰网络', async () => {
    const fx = buildNode(7);
    const { repo, opts } = setup(fx);
    await expect(syncOnce(opts)).rejects.toThrow(/公钥/);
    expect(await repo.getConfig('content_version')).toBeNull();
  });

  it('manifest 被篡改：整包拒收，本地不留痕', async () => {
    const fx = buildNode(7);
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);

    const bad = JSON.parse(JSON.stringify(fx.manifest)) as Manifest;
    bad.entries[0].title = '被篡改的标题';
    fx.http.routes.set(`${BASE}/v1/manifest/${fx.catalog.pack_id}`, json(bad));

    await expect(syncOnce(opts)).rejects.toThrow(/验签失败/);
    expect(await repo.getConfig('content_version')).toBeNull();
    expect(await repo.listItems()).toHaveLength(0);
  });

  it('pack 行级 content_hash 不符：拒绝写入', async () => {
    const fx = buildNode(7);
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);
    fx.pack.set(`/work/pack-${fx.catalog.pack_id}.sqlite`, [makeArticle('article:aaa', '甲', '被换过的正文\n')]);

    await expect(syncOnce(opts)).rejects.toThrow(/行级 hash 不符/);
    expect(await repo.getConfig('content_version')).toBeNull();
    expect(await repo.listItems()).toHaveLength(0);
  });

  it('块内容与 blob_id 不符：拒收且不登记', async () => {
    const fx = buildNode(7, { withCover: true });
    const { repo, fs, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);
    const id = blobId(COVER);
    fx.http.routes.set(`${BASE}/v1/blob/${id}`, { status: 200, body: utf8('tampered!') });

    await expect(syncOnce(opts)).rejects.toThrow(/块内容哈希不符/);
    expect(await repo.hasBlob(id)).toBe(false);
    expect(fs.files.has(`/work/blobs/${id}`)).toBe(false);
    expect(await repo.getConfig('content_version')).toBeNull();
  });

  it('墓碑：命中条目连同正文一起从本地删除', async () => {
    const fx1 = buildNode(7);
    const { repo, opts } = setup(fx1);
    await repo.setConfig('pubkey_hex', PUB);
    await syncOnce(opts);
    expect(await repo.getItem('article:aaa')).not.toBeNull();

    buildNode(
      8,
      {
        tombstones: [{ item_id: 'article:aaa', revoked_rev: 2 }],
        omitArticles: ['article:aaa'],
        http: fx1.http,
      },
    );

    const res = await syncOnce(opts);
    expect(res).toEqual({ status: 'updated', contentVersion: 8, items: 1, blobs: 0 });
    expect(await repo.getItem('article:aaa')).toBeNull();
    expect(await repo.getArticle('article:aaa')).toBeNull();
    expect(await repo.getItem('article:bbb')).not.toBeNull();
    expect(await repo.listTombstones()).toEqual([{ itemId: 'article:aaa', revokedRev: 2 }]);
  });

  it('目录分页：按 cursor 翻页收集全部条目', async () => {
    const fx = buildNode(7);
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);

    const cat = fx.catalog;
    const first = cat.items[0].item_id;
    fx.http.routes.delete(`${BASE}/v1/catalog`);
    fx.http.routes.set(`${BASE}/v1/catalog`, json({ ...cat, items: [cat.items[0]], next_cursor: first }));
    fx.http.routes.set(`${BASE}/v1/catalog?cursor=${first}`, json({ ...cat, items: [cat.items[1]], next_cursor: null }));

    const res = await syncOnce(opts);
    expect(res.status).toBe('updated');
    expect((await repo.listItems()).map((i) => i.itemId).sort()).toEqual(['article:aaa', 'article:bbb']);
  });
});
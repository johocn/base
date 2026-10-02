import { describe, expect, it } from 'vitest';

import { utf8 } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import {
  displayOf,
  loadDirectory,
  normalizeTermKey,
  pullDirectory,
  termState,
  type DirectoryOptions,
  type DirectorySnapshot,
} from './directory';

const BASE = 'https://node.test';

const VERSION_KEY = 'directory_version';
const TERMS_KEY = 'directory_terms_json';

function res(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function opts(http: FakeHttp, repo: MemoryRepo): DirectoryOptions {
  return { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
}

const APPROVED = [
  { kind: 'category', term_key: '数学', display_name: '数学' },
  { kind: 'instructor', term_key: 'abc', display_name: 'ＡＢＣ' },
];
const PENDING = [{ kind: 'category', term_key: '代数', display_name: '代数', votes: 1, threshold: 2 }];

describe('termState 三态', () => {
  it('空字段 empty / 未命中 pending / 命中 approved', () => {
    const s: DirectorySnapshot = {
      version: 1,
      approved: new Map([['category\x00数学', '数学']]),
      pending: new Map(),
    };
    expect(termState(s, 'category', '')).toBe('empty');
    expect(termState(s, 'category', '代数')).toBe('pending');
    expect(termState(s, 'category', '数学')).toBe('approved');
  });
});

describe('loadDirectory 缓存缺失', () => {
  it('干净仓储不崩，返回 version:0 与空集，任意非空词条 pending', async () => {
    const s = await loadDirectory(new MemoryRepo());
    expect(s.version).toBe(0);
    expect(s.approved.size).toBe(0);
    expect(s.pending.size).toBe(0);
    expect(termState(s, 'tag', '数学')).toBe('pending');
  });
});

describe('pullDirectory', () => {
  it('首次拉取：返回 changed 且写入两个缓存键、可无损还原', async () => {
    const http = new FakeHttp();
    http.routes.set(`${BASE}/v1/directory?version=0`, res({ version: 3, approved: APPROVED, pending: PENDING }));
    const repo = new MemoryRepo();

    const r = await pullDirectory(opts(http, repo));
    expect(r).toEqual({ version: 3, unchanged: false });
    expect(repo.config.get(VERSION_KEY)).toBe('3');
    expect(repo.config.get(TERMS_KEY)).toBe(JSON.stringify({ approved: APPROVED, pending: PENDING }));

    const s = await loadDirectory(repo);
    expect(s.version).toBe(3);
    expect(s.approved.get('category\x00数学')).toBe('数学');
    expect(s.approved.get('instructor\x00abc')).toBe('ＡＢＣ');
    const p = s.pending.get('category\x00代数');
    expect(p?.displayName).toBe('代数');
    expect(p?.votes).toBe(1);
    expect(p?.threshold).toBe(2);
  });

  it('version 未变短路：不改缓存（逐字节等于旧值）', async () => {
    const http = new FakeHttp();
    http.routes.set(`${BASE}/v1/directory?version=3`, res({ version: 3, unchanged: true }));
    const repo = new MemoryRepo();
    const oldJson = JSON.stringify({ approved: [{ kind: 'tag', term_key: '旧', display_name: '旧' }], pending: [] });
    repo.config.set(VERSION_KEY, '3');
    repo.config.set(TERMS_KEY, oldJson);

    const r = await pullDirectory(opts(http, repo));
    expect(r).toEqual({ version: 3, unchanged: true });
    expect(repo.config.get(TERMS_KEY)).toBe(oldJson);
  });

  it('非 200 ⇒ reject，且缓存未被改动', async () => {
    const http = new FakeHttp();
    http.routes.set(`${BASE}/v1/directory?version=0`, {
      status: 429,
      body: utf8(JSON.stringify({ error: 'govern_rate_limited' })),
    });
    const repo = new MemoryRepo();
    await expect(pullDirectory(opts(http, repo))).rejects.toThrow('HTTP 429');
    expect(repo.config.has(VERSION_KEY)).toBe(false);
    expect(repo.config.has(TERMS_KEY)).toBe(false);
  });
});

describe('normalizeTermKey 与 Go 同构', () => {
  it('六步规范化', () => {
    expect(normalizeTermKey('  数学  ')).toBe('数学');
    expect(normalizeTermKey('ＡＢＣ')).toBe('abc');
    expect(normalizeTermKey('a\t\nb')).toBe('a b');
    expect(normalizeTermKey('Ａb C')).toBe('ab c');
    expect(normalizeTermKey('\u0000\u0007X')).toBe('x');
    expect(normalizeTermKey('')).toBeNull();
    expect(normalizeTermKey('   \t\n ')).toBeNull();
    expect(normalizeTermKey('a'.repeat(65))).toBeNull();
    expect(normalizeTermKey('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('空白集对齐 Go unicode.IsSpace（与 JS 正则 \\s 的差异点）', () => {
    // U+0085 NEL：Go 算空白（被折叠/裁掉），JS 正则 \s 不算
    expect(normalizeTermKey('\u0085x')).toBe('x');
    // U+FEFF：JS 正则 \s 算空白，Go **不**算——须原样保留
    expect(normalizeTermKey('x\uFEFF')).toBe('x\uFEFF');
  });
});

describe('displayOf', () => {
  it('pending 与 approved 都取 display_name，未知回退 key', async () => {
    const repo = new MemoryRepo();
    repo.config.set(VERSION_KEY, '1');
    repo.config.set(TERMS_KEY, JSON.stringify({ approved: APPROVED, pending: PENDING }));
    const s = await loadDirectory(repo);
    expect(displayOf(s, 'category', '数学')).toBe('数学');
    expect(displayOf(s, 'category', '代数')).toBe('代数');
    expect(displayOf(s, 'instructor', 'abc')).toBe('ＡＢＣ');
    expect(displayOf(s, 'tag', '未知')).toBe('未知');
  });
});

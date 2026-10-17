// mesh 六接口客户端（spec §3.3）。HttpAdapter 明文局域网请求（manifest cleartext 放行）。
// HEAD 语义执行期定案 5：HttpAdapter 只有 get/post——headBlob 用 probe=1 的 GET 轻量探测，
// server 侧识别 probe=1 只回 200/404 不带 body。
import { blobId, utf8 } from '@base/protocol-ts';
import type { MeshCatalogDoc, MeshCatalogEntry } from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import { decodeUtf8 } from '../sync';
import { verifyCatalogPubs } from './catalog';

export interface MeshHello {
  node_id: string;
  sign_pubkey: string;
  protocol_version: number;
  catalog_version: number;
  gossip_cursor: string;
}

export class MeshClient {
  constructor(private readonly http: Adapters['http']) {}

  async hello(baseUrl: string, token: string): Promise<MeshHello> {
    const res = await this.http.get(`${baseUrl}/mesh/v1/hello?token=${encodeURIComponent(token)}`);
    if (res.status === 403) throw new Error('mesh_token_rejected');
    if (res.status !== 200) throw new Error(`mesh_hello_failed: HTTP ${res.status}`);
    const h = JSON.parse(decodeUtf8(res.body)) as MeshHello;
    if (h.protocol_version !== 1) throw new Error('mesh_protocol_version_unsupported');
    return h;
  }

  /** 分页拉全 entries（cursor=最后 item_id，体例沿用 /v1/catalog），拉完用全量验签（执行期定案 3）。 */
  async pullCatalog(baseUrl: string, token: string, verifyPubs: string[]): Promise<MeshCatalogDoc> {
    const entries: MeshCatalogEntry[] = [];
    let catalogVersion = 0;
    let signedAt = '';
    let nodeId = '';
    let signature = '';
    let cursor: string | null = null;
    for (;;) {
      const q = [`token=${encodeURIComponent(token)}`];
      if (cursor !== null) q.push(`cursor=${encodeURIComponent(cursor)}`);
      const res = await this.http.get(`${baseUrl}/mesh/v1/catalog?${q.join('&')}`);
      if (res.status !== 200) throw new Error(`mesh_catalog_failed: HTTP ${res.status}`);
      const page = JSON.parse(decodeUtf8(res.body)) as {
        node_id: string; catalog_version: number; signed_at: string; signature: string;
        entries: MeshCatalogEntry[]; next_cursor: string | null;
      };
      nodeId = page.node_id; catalogVersion = page.catalog_version;
      signedAt = page.signed_at; signature = page.signature;
      entries.push(...(page.entries ?? []));
      const next = page.next_cursor ?? null;
      if (next === null) break;
      if (next === cursor) throw new Error('mesh_catalog_pagination_stuck');
      cursor = next;
    }
    const doc: MeshCatalogDoc = {
      type: 'mesh-catalog', v: 1, node_id: nodeId, catalog_version: catalogVersion,
      entries, signed_at: signedAt, signature,
    };
    if (!verifyCatalogPubs(doc, verifyPubs)) throw new Error('mesh_catalog_sig_invalid');
    return doc;
  }

  async headBlob(baseUrl: string, token: string, blobIdHex: string): Promise<boolean> {
    const res = await this.http.get(`${baseUrl}/mesh/v1/blob/${blobIdHex}?token=${encodeURIComponent(token)}&probe=1`);
    return res.status === 200;
  }

  /** 取块 + 内容哈希自证（blob_id = hex(sha256)[0:32]，总纲 §3.2 铁律）；失败重拉一次，再失败抛错（调用方标记坏块跳过）。 */
  async fetchBlob(baseUrl: string, token: string, blobIdHex: string): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.http.get(`${baseUrl}/mesh/v1/blob/${blobIdHex}?token=${encodeURIComponent(token)}`);
      if (res.status === 200 && blobId(res.body) === blobIdHex) return res.body;
    }
    throw new Error(`mesh_blob_invalid: ${blobIdHex}`);
  }

  async postGossip(baseUrl: string, token: string, messages: unknown[]): Promise<void> {
    const body = utf8(JSON.stringify({ messages }));
    const res = await this.http.post(`${baseUrl}/mesh/v1/gossip?token=${encodeURIComponent(token)}`, body, {
      'Content-Type': 'application/json',
    });
    if (res.status !== 200) throw new Error(`mesh_gossip_post_failed: HTTP ${res.status}`);
  }

  /** 增量拉 gossip：since=<received_at>_<event_id>（体例同 event-sync）。 */
  async fetchGossip(baseUrl: string, token: string, since: string): Promise<unknown[]> {
    const res = await this.http.get(
      `${baseUrl}/mesh/v1/gossip?token=${encodeURIComponent(token)}&since=${encodeURIComponent(since)}`,
    );
    if (res.status !== 200) throw new Error(`mesh_gossip_fetch_failed: HTTP ${res.status}`);
    const page = JSON.parse(decodeUtf8(res.body)) as { messages?: unknown[]; next_cursor?: string | null };
    return page.messages ?? [];
  }
}

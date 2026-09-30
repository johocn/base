/**
 * 投稿编排（本册 §5）：本地校验 → 身份登记 → 客户端算 content_hash → 作者签名 → POST /v1/submit。
 *
 * 有网即直发；**只有网络不可达**才留在台账 `pending` 等补发；其余失败按 §9.3 转 `failed`。
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'，因此可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import { authorSignBytes, bytesToHex, randomBytes, sha256Hex, sign, utf8 } from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import { segmentsContentHash, type SubmitSegmentRow } from './attrs';
import { CommentError, ensureRegistered, type CommentErrorCode, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { signRequestHeaders, type Identity } from './identity';
import { parseQuestionDoc } from './quiz';
import type { LocalRepo } from './repo';
import { decodeUtf8 } from './sync';
import type { MySubmissionRow, TagLinkRow } from './types';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type SubmitOptions = CommentOptions;

/** 容器载体的两种类型（本册 §2.3）。 */
export type ContainerSubmitType = 'course' | 'lesson';

/** 一条待投内容：与台账行的可编辑字段一一对应。 */
export interface SubmitDraft {
  itemId: string;
  type: 'article' | 'quiz' | 'tag' | ContainerSubmitType;
  title: string;
  bodyMd: string;
  /** quiz 专有；其余恒为空串 */
  questionJson: string;
  /** tag 专有：本次直打要建立的关联集（其余载体不传）。 */
  links?: TagLinkRow[];
  /** course / lesson 专有：完整 segments 行集（含 seq<0 属性行与 seq>=1 清单行，本册 §4.1）。 */
  segments?: SubmitSegmentRow[];
}

/** 发表失败的用户可读错误。码沿用评论队列的词汇，避免两套同义词。 */
export class SubmitError extends Error {
  constructor(
    readonly code: CommentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}

/** 生成一个新条目的 id：`<type>/<16 位 hex>`（恒满足 `[a-z0-9][a-z0-9-]{0,63}`，本册 §3）。 */
export function newItemID(type: 'article' | 'quiz' | 'course'): string {
  return `${type}/${bytesToHex(randomBytes(8))}`;
}

/** 课时 id：`course/<cid>/lesson/<16 位 hex>`——课时不独立存在，必须挂在课程下（本册 §6）。 */
export function newLessonID(courseId: string): string {
  return `${courseId}/lesson/${bytesToHex(randomBytes(8))}`;
}

/** kind 固定序：与 `core/tags.ts` 的 `TAG_KIND_ORDER`、节点 `store.tagKindRank` 同序。 */
const TAG_KIND_RANK: Record<string, number> = { course: 0, lesson: 1, article: 2, comment: 3 };

/** 按 (kind 固定序, target_id 升序) 排序——物化与请求体都用这一份。 */
function sortTagLinks(links: TagLinkRow[]): TagLinkRow[] {
  return [...links].sort((a, b) => {
    const d = (TAG_KIND_RANK[a.kind] ?? 99) - (TAG_KIND_RANK[b.kind] ?? 99);
    if (d !== 0) return d;
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });
}

/** 物化文本：`"<kind>\t<target_id>\n"`——与节点 `store.MaterializeTagSegments` 逐字同构。 */
export function materializeTagText(links: TagLinkRow[]): string {
  return sortTagLinks(links)
    .map((l) => `${l.kind}\t${l.targetId}\n`)
    .join('');
}

/** `content_hash` 与 #25 §2.2 同一口径：article 取 `body_md`、quiz 取 `question_json`、tag 取物化 segments 的 UTF-8 字节 sha256。 */
export function contentHashOf(draft: SubmitDraft): string {
  if (draft.type === 'tag') {
    // 容器口径（#14 §3.3）：哈希只看物化的 segments 行，与 article/quiz 的「取正文」口径不同。
    return sha256Hex(utf8(materializeTagText(draft.links ?? [])));
  }
  if (draft.type === 'course' || draft.type === 'lesson') {
    // 容器口径（本册 §2.3）：哈希看**完整行集**，含 seq<0 属性行——与 #37 的 tag 口径同源。
    return segmentsContentHash(draft.segments ?? []);
  }
  return sha256Hex(utf8(draft.type === 'quiz' ? draft.questionJson : draft.bodyMd));
}

/** `article` 请求体字节。键序固定：type → item_id → title → body_md → question_json → author_sig。 */
export function buildArticlePayload(itemId: string, title: string, bodyMd: string, authorSig: string): Uint8Array {
  return utf8(
    JSON.stringify({
      type: 'article',
      item_id: itemId,
      title,
      body_md: bodyMd,
      question_json: '',
      author_sig: authorSig,
    }),
  );
}

/** `quiz` 请求体字节。键序同上。 */
export function buildQuizPayload(itemId: string, title: string, questionJson: string, authorSig: string): Uint8Array {
  return utf8(
    JSON.stringify({
      type: 'quiz',
      item_id: itemId,
      title,
      body_md: '',
      question_json: questionJson,
      author_sig: authorSig,
    }),
  );
}

/** `tag` 请求体字节。键序固定：type → item_id → title → links → author_sig。 */
export function buildTagPayload(itemId: string, title: string, links: TagLinkRow[], authorSig: string): Uint8Array {
  return utf8(
    JSON.stringify({
      type: 'tag',
      item_id: itemId,
      title,
      links: sortTagLinks(links).map((l) => ({ target_id: l.targetId, kind: l.kind })),
      author_sig: authorSig,
    }),
  );
}

/** `course` / `lesson` 请求体字节。键序固定：type → item_id → title → segments → author_sig。 */
export function buildContainerPayload(
  type: ContainerSubmitType,
  itemId: string,
  title: string,
  segments: SubmitSegmentRow[],
  authorSig: string,
): Uint8Array {
  return utf8(
    JSON.stringify({
      type,
      item_id: itemId,
      title,
      segments: [...segments].sort((a, b) => a.seq - b.seq).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text })),
      author_sig: authorSig,
    }),
  );
}

/** 本地校验；`ok=false` 时 `message` 即可直接展示的提示。 */
export interface DraftValidation {
  ok: boolean;
  message: string;
}

/**
 * 本地校验（本册 §5.2 要求题组必须先过本地校验，才序列化为字符串随请求发送）。
 * **只拦「客户端一定能判断」的东西**：标题非空、正文非空、题组能过 `parseQuestionDoc`。
 * 长度上限与控制字符一律交服务端裁决（本册 §2.3 的同一口径）。
 */
export function validateDraft(draft: SubmitDraft): DraftValidation {
  if (draft.type === 'tag') {
    // 三段的逐段文案（「请填写章」）在 `core/tags.ts` 的 submitTag 里给；这里只兜「有目标」这条兜底，
    // 节点还会做完整的形态 + 存在性 + 资格校验（册子 §3.4）。
    if ((draft.links ?? []).length === 0) return { ok: false, message: '缺少打标目标' };
    return { ok: true, message: '' };
  }
  if (draft.type === 'course' || draft.type === 'lesson') {
    // 容器只拦「客户端一定判断得了」的这一条：标题非空。行集的三区间铁律交服务端裁决（本册 §4.1）。
    if (draft.title.trim() === '') return { ok: false, message: '请填写标题' };
    return { ok: true, message: '' };
  }
  if (draft.title.trim() === '') return { ok: false, message: '请填写标题' };
  if (draft.type === 'quiz') {
    if (parseQuestionDoc(draft.questionJson) === null) return { ok: false, message: '题组内容不合法：每题需题干、至少 2 个选项并选定正确项' };
    return { ok: true, message: '' };
  }
  if (draft.bodyMd.trim() === '') return { ok: false, message: '请填写正文' };
  return { ok: true, message: '' };
}

/** 把本地步骤（随机数 / 签名 / 编码）的裸错误包成可读错误。 */
function localStep<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new SubmitError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
  }
}

/** 身份准备：投稿走 `requireAuth`，未登记身份会被节点回 `403 identity_unregistered`（本册 §3）。 */
async function ensureIdentity(o: SubmitOptions): Promise<Identity> {
  try {
    return await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) throw new SubmitError(e.code, e.message);
    throw new SubmitError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }
}

/** 按载体构造请求体（签名在内部现算，不落盘——本册 §4.1 取舍 1）。 */
export function buildSubmitBody(draft: SubmitDraft, ident: Identity): Uint8Array {
  const title = draft.title.trim();
  const contentHash = contentHashOf(draft);
  const sig = localStep('签名', () => sign(ident.seedHex, utf8(authorSignBytes(draft.itemId, contentHash, ident.id))));
  if (draft.type === 'tag') return buildTagPayload(draft.itemId, title, draft.links ?? [], sig);
  if (draft.type === 'course' || draft.type === 'lesson') {
    return buildContainerPayload(draft.type, draft.itemId, title, draft.segments ?? [], sig);
  }
  return draft.type === 'quiz'
    ? buildQuizPayload(draft.itemId, title, draft.questionJson, sig)
    : buildArticlePayload(draft.itemId, title, draft.bodyMd, sig);
}

/** 节点错误码 → 用户可读错误；`code` 决定它是「暂时」还是「永久」（本册 §9.3）。 */
function mapSubmitFailure(status: number, raw: string, itemId: string): SubmitError {
  const code = errorCodeOf(raw);
  if (status === 429 || code === 'item_rate_limited') {
    return new SubmitError('rate_limited', errorText(code, '提交过于频繁，请稍后再试'));
  }
  const message = errorText(code, `提交失败（HTTP ${status}）`);
  // 4xx（除 429）= 永久失败；5xx = 节点侧问题，视为暂时（本计划口径填空 4）
  return new SubmitError(status >= 400 && status < 500 ? 'rejected' : 'server', message);
}

/** 永久失败：节点明确拒绝，重发无意义。`rejected` 即 4xx（除 429）。 */
export function isPermanentSubmitFailure(e: unknown): boolean {
  return e instanceof SubmitError && e.code === 'rejected';
}

export interface SubmitResult {
  itemId: string;
  created: boolean;
  contentHash: string;
}

/**
 * 直接发送一条投稿：登记 → 算 hash → 签名 → POST。失败抛 `SubmitError`，**不落台账**。
 * 本函数是补发与直发共用的唯一发送入口。
 */
export async function submitItem(o: SubmitOptions, draft: SubmitDraft): Promise<SubmitResult> {
  const v = validateDraft(draft);
  if (!v.ok) throw new SubmitError('client', v.message);
  const ident = await ensureIdentity(o);
  const bytes = buildSubmitBody(draft, ident);
  const headers = localStep('签名请求', () =>
    signRequestHeaders(ident, { method: 'POST', path: '/v1/submit', body: bytes }),
  );

  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/submit`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new SubmitError('network', '无法连接节点，已保存，联网后自动发送');
  }
  if (res.status !== 200) throw mapSubmitFailure(res.status, decodeUtf8(res.body), draft.itemId);

  const out = localStep('解析响应', () => JSON.parse(decodeUtf8(res.body)) as { item_id?: string; content_hash?: string; created?: boolean });
  return {
    itemId: String(out.item_id ?? draft.itemId),
    created: out.created === true,
    contentHash: String(out.content_hash ?? contentHashOf(draft)),
  };
}

/**
 * 写台账（`item_id` 为键的 upsert）。**保留已有的 `created` 回填值**：
 * 一次重投失败不该把「这是我新建的条目」这个事实擦掉。
 */
async function writeLedger(o: SubmitOptions, draft: SubmitDraft, patch: Partial<MySubmissionRow>): Promise<void> {
  const prev = await o.repo.getSubmission(draft.itemId);
  const isContainer = draft.type === 'course' || draft.type === 'lesson';
  await o.repo.saveSubmission({
    itemId: draft.itemId,
    type: draft.type,
    title: draft.title.trim(),
    bodyMd: draft.type === 'article' ? draft.bodyMd : '',
    questionJson: draft.type === 'quiz' ? draft.questionJson : '',
    linksJson: draft.type === 'tag' ? JSON.stringify(sortTagLinks(draft.links ?? []).map((l) => ({ target_id: l.targetId, kind: l.kind }))) : '',
    segmentsJson: isContainer ? JSON.stringify([...(draft.segments ?? [])].sort((a, b) => a.seq - b.seq)) : '',
    state: 'pending',
    reason: null,
    created: prev?.created ?? 0,
    queuedAt: new Date().toISOString(),
    sentAt: '',
    ...patch,
  });
}

export interface SubmitOutcome {
  itemId: string;
  /** 服务端 `created` 回填；未送达恒为 false */
  created: boolean;
  /** 台账最终状态：`sent` 已送达 / `pending` 待发 / `failed` 永久失败 */
  ledgerState: 'sent' | 'pending' | 'failed';
  /** 未送达时可展示的提示文案 */
  message: string;
}

/**
 * 投一条：成功 → 台账 `sent`；网络失败 / 429 / 5xx → 台账 `pending`（联网后自动补发）；
 * 其余 4xx → 台账 `failed`（只可删，不自动重试）。三种结果都**会**留下台账行——
 * 「我的条目」的列表本体就是它（本册 §4.1）。
 */
export async function enqueueOrSend(o: SubmitOptions, draft: SubmitDraft): Promise<SubmitOutcome> {
  if (o.nodeBaseUrl === '') throw new SubmitError('client', '未配置节点地址，无法投稿');
  const v = validateDraft(draft);
  if (!v.ok) throw new SubmitError('client', v.message);

  try {
    const r = await submitItem(o, draft);
    await writeLedger(o, draft, {
      state: 'sent',
      reason: null,
      created: r.created ? 1 : 0,
      sentAt: new Date().toISOString(),
    });
    return { itemId: r.itemId, created: r.created, ledgerState: 'sent', message: '' };
  } catch (e) {
    if (!(e instanceof SubmitError)) throw e;
    const permanent = isPermanentSubmitFailure(e);
    await writeLedger(o, draft, permanent ? { state: 'failed', reason: e.message } : { state: 'pending', reason: e.message });
    return { itemId: draft.itemId, created: false, ledgerState: permanent ? 'failed' : 'pending', message: e.message };
  }
}

/** `flushSubmissions` 的结果。**只经返回值体现，绝不抛错**。 */
export interface FlushSubmissionsResult {
  sent: number;
  failed: number;
  remaining: number;
  error: string;
}

/** 进行中的补发：并发调用复用同一轮（进页面与「重试」可能撞在一起）。 */
let inflightFlush: Promise<FlushSubmissionsResult> | null = null;

/**
 * 补发台账里全部 `pending`：逐条串行、按 `queued_at ASC`（先入队先补发）。
 * **暂时失败即中止本轮**——网络刚断或已被限速时后续条目必然同错；已 `failed` 的行永不自动重试。
 */
export function flushSubmissions(o: SubmitOptions): Promise<FlushSubmissionsResult> {
  if (o.nodeBaseUrl === '') return Promise.resolve({ sent: 0, failed: 0, remaining: 0, error: '' });
  if (!inflightFlush) {
    inflightFlush = (async () => {
      try {
        return await runFlushSubmissions(o);
      } finally {
        inflightFlush = null;
      }
    })();
  }
  return inflightFlush;
}

async function runFlushSubmissions(o: SubmitOptions): Promise<FlushSubmissionsResult> {
  const rows = await o.repo.listSubmissions('pending');
  let sent = 0;
  let failed = 0;
  let remaining = 0;
  let error = '';
  for (const row of rows) {
    const draft: SubmitDraft = {
      itemId: row.itemId,
      type: row.type,
      title: row.title,
      bodyMd: row.bodyMd,
      questionJson: row.questionJson,
      links: row.type === 'tag' ? decodeLedgerLinks(row.itemId, row.linksJson) : undefined,
      segments: row.type === 'course' || row.type === 'lesson' ? decodeLedgerSegments(row.segmentsJson) : undefined,
    };
    try {
      const r = await submitItem(o, draft);
      await o.repo.markSubmissionSent(row.itemId, r.created ? 1 : 0, new Date().toISOString());
      sent += 1;
    } catch (e) {
      const msg = e instanceof SubmitError ? e.message : `补发失败：${(e as Error).message ?? String(e)}`;
      if (isPermanentSubmitFailure(e)) {
        await o.repo.markSubmissionFailed(row.itemId, msg);
        failed += 1;
      } else {
        // 剩余待发 = 本轮总条数 − 已送达 − 已永久失败
        remaining = rows.length - sent - failed;
        error = msg;
        break;
      }
    }
  }
  return { sent, failed, remaining, error };
}

/** 台账 `links_json` → 草稿 `links`；空串或解析失败按空数组（节点会拒，不会写出错数据）。 */
function decodeLedgerLinks(tagId: string, raw: string): TagLinkRow[] {
  if (raw === '') return [];
  try {
    const arr = JSON.parse(raw) as Array<{ target_id?: string; kind?: string }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((l) => ({ tagId, targetId: String(l.target_id ?? ''), kind: String(l.kind ?? '') }));
  } catch {
    return [];
  }
}

/** 台账 `segments_json` → 草稿 `segments`；空串或解析失败按空数组（节点会拒，不会写出错数据）。 */
function decodeLedgerSegments(raw: string): SubmitSegmentRow[] {
  if (raw === '') return [];
  try {
    const arr = JSON.parse(raw) as Array<{ seq?: number; kind?: string; text?: string }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => ({ seq: Number(s.seq ?? 0), kind: String(s.kind ?? ''), text: String(s.text ?? '') }));
  } catch {
    return [];
  }
}
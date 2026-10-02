// 逐行对齐 internal/httpapi/submit.go 的 handleSubmitPost（:181-352）与纯校验段
// （splitSubmitItemID / containerShapeOf / validateSubmitSegments / validItemTitle /
// validQuestionJSON / submissionContentHash / normalizeSubmitTagLinks / checkTagTargetsExist）。
//
// 判定顺序**原样保留**（含限速在查库之前、`||` 短路）：顺序影响限速令牌消耗与错误码优先级。
import type { ServerResponse } from "@base/core-ts";
import {
  DIGEST_KIND,
  attrSeqsCanonical,
  decodeTagPath,
  isAttrKind,
  isValidSlug,
  sha256Hex,
  tagKindOfTarget,
  tagTitle,
  utf8,
  verifyAuthorSig,
  type AttrSlot,
} from "@base/protocol-ts";
import type { Db } from "../db";
import { hasCommentEvent } from "../store/events";
import {
  materializeTagSegments,
  segmentsContentHash,
  type TagLink,
} from "../store/governProjection";
import { governorSet } from "../store/governorset";
import {
  ItemTakenError,
  TagTargetTaggedError,
  upsertSegmentSubmission,
  upsertSubmission,
  upsertTagSubmission,
  type SegmentRow,
} from "../store/submission";
import { type AuthedHandler, writeAuthErr } from "./authmw";
import { decodeStrict, jsonObjectField, listOf, parseJSONDocument, type StrictSpec } from "./decode";
import {
  type IpLimiter,
  isHexN,
  parseGoInt64,
  toStr,
  trimGoSpace,
  validItemTitle,
} from "./derived";
import { jsonResponse } from "./json";

// —— 本册的文档级常量（submit.go:16-37） ——

/** maxSubmitBytes：单条投稿正文的 UTF-8 字节上限。 */
export const MAX_SUBMIT_BYTES = 32768;

/** 写限速：按已验签身份与客户端 IP 双维度（submit.go:21-24）。 */
export const SUBMIT_PER_MINUTE_PER_ID = 6;
export const SUBMIT_BURST_PER_ID = 3;
export const SUBMIT_PER_MINUTE_PER_IP = 30;
export const SUBMIT_BURST_PER_IP = 10;

/** 客户端 IP 维度的退化单桶键（与 routes/event.ts 同口径；ServerRequest 未暴露远端地址）。 */
const CLIENT_BUCKET_KEY = "";

const ITEM_TYPE_ARTICLE = "article";
const ITEM_TYPE_QUIZ = "quiz";
const ITEM_TYPE_TAG = "tag";
const ITEM_TYPE_COURSE = "course";
const ITEM_TYPE_LESSON = "lesson";

/** childKindsByContainer（submit.go:71-76）：容器清单行（seq>=1）的合法 kind 取值域。 */
const CHILD_KINDS_BY_CONTAINER: Record<string, Record<string, boolean>> = {
  [ITEM_TYPE_COURSE]: { [ITEM_TYPE_LESSON]: true },
  [ITEM_TYPE_LESSON]: {
    [ITEM_TYPE_ARTICLE]: true,
    video: true,
    audio: true,
    [ITEM_TYPE_QUIZ]: true,
  },
};

/** submitReq（submit.go:161-171）的字段规格；author_id 用 raw（出现即禁止，含 null）。 */
const SUBMIT_SPEC: StrictSpec = {
  type: "string",
  item_id: "string",
  title: "string",
  body_md: "string",
  question_json: "string",
  author_sig: "string",
  links: listOf({ target_id: "string", kind: "string" }),
  segments: listOf({ seq: "int64", kind: "string", text: "string" }),
  author_id: "raw",
};

/** submitLink（submit.go:174-177）的解码形态（字段名与请求体一致）。 */
export interface SubmitLink {
  target_id: string;
  kind: string;
}

/** submitSegment（submit.go:79-83）。 */
interface SubmitSegment {
  seq: number;
  kind: string;
  text: string;
}

export interface SubmitDeps {
  db: Db;
  storeKey: Uint8Array | null;
  byID: IpLimiter;
  byIP: IpLimiter;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * splitSubmitItemID（submit.go:41-50）：校验 item_id 形态并返回 code（非空即失败）。
 * code 取值 item_id_invalid（形态/前缀/slug 不合法，含 course/ 前缀）或 item_type_mismatch。
 */
function splitSubmitItemId(itemId: string, typ: string): string {
  const slash = itemId.indexOf("/");
  const ok = slash !== -1;
  const prefix = ok ? itemId.slice(0, slash) : "";
  const rest = ok ? itemId.slice(slash + 1) : "";
  if (!ok || (prefix !== ITEM_TYPE_ARTICLE && prefix !== ITEM_TYPE_QUIZ) || !isValidSlug(rest)) {
    return "item_id_invalid";
  }
  if (prefix !== typ) return "item_type_mismatch";
  return "";
}

/**
 * containerShapeOf（submit.go:54-68）：course/<cid> → course；course/<cid>/lesson/<lid> → lesson。
 * 各段都须是合法 slug；其余一律不识别，返回空串表示失败。
 */
function containerShapeOf(itemId: string): string {
  const parts = itemId.split("/");
  if (parts.length === 2) {
    if (parts[0] === ITEM_TYPE_COURSE && isValidSlug(parts[1])) return ITEM_TYPE_COURSE;
  } else if (parts.length === 4) {
    if (
      parts[0] === ITEM_TYPE_COURSE &&
      isValidSlug(parts[1]) &&
      parts[2] === ITEM_TYPE_LESSON &&
      isValidSlug(parts[3])
    ) {
      return ITEM_TYPE_LESSON;
    }
  }
  return "";
}

/**
 * validateSubmitSegments（submit.go:91-123）：按册子 §2.1 三区间铁律校验容器行集。
 * 返回可落库的行；不合规返回 null（调用方回 item_segments_invalid）。
 */
function validateSubmitSegments(
  itemId: string,
  typ: string,
  input: SubmitSegment[],
): SegmentRow[] | null {
  const ordered = input.slice();
  ordered.sort((a, b) => a.seq - b.seq);
  const childKinds = CHILD_KINDS_BY_CONTAINER[typ];
  const attrs: AttrSlot[] = [];
  const out: SegmentRow[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    if (i > 0 && s.seq === ordered[i - 1].seq) return null; // seq 不得重复
    if (s.seq < 0) {
      if (!isAttrKind(s.kind)) return null;
      attrs.push({ seq: s.seq, kind: s.kind, text: s.text });
    } else if (s.seq === 0) {
      if (s.kind !== DIGEST_KIND) return null;
    } else {
      if (!childKinds[s.kind]) return null;
    }
    out.push({ itemId, seq: s.seq, kind: s.kind, text: s.text });
  }
  // 属性行必须与导出端逐字节同构，否则双端 content_hash 会静默漂移（本册 §8 风险 2）。
  if (!attrSeqsCanonical(attrs)) return null;
  return out;
}

/**
 * validQuestionJSON（submit.go:141-150）：Go 是 `json.Unmarshal(raw, &struct{SchemaVersion int;
 * Questions []json.RawMessage})` —— 要求**整段文本**恰含一个 JSON 值（拒尾随内容），顶层须是对象，
 * schema_version 若存在必须能解进 int（`1.0` / `"1"` / 越界一律失败；`null` 取零值），
 * questions 须是非空数组（`null` → nil → 长度 0）。只认这两个键，其余键不参与判定。
 */
function validQuestionJSON(raw: string): boolean {
  const doc = parseJSONDocument(raw);
  if (doc === null || doc.t !== "obj") return false;
  let schemaVersion = 0;
  const sv = jsonObjectField(doc, "schema_version");
  if (sv !== undefined) {
    if (sv.t === "num") {
      const n = parseGoInt64(sv.raw);
      if (n === null) return false;
      schemaVersion = n;
    } else if (sv.t !== "null") {
      return false; // 非数字（含字符串）解进 int 字段即失败
    }
  }
  if (schemaVersion !== 1) return false;
  const questions = jsonObjectField(doc, "questions");
  return questions !== undefined && questions.t === "arr" && questions.v.length > 0;
}

/**
 * normalizeSubmitTagLinks（submit.go:356-368）：kind 必须与 target_id 形态自洽，
 * 同一 target_id 不得重复；规范化的 kind 取自 tagKindOfTarget 的返回值。
 */
export function normalizeSubmitTagLinks(inLinks: SubmitLink[]): TagLink[] | null {
  const out: TagLink[] = [];
  const seen = new Set<string>();
  for (const l of inLinks) {
    const kind = tagKindOfTarget(l.target_id);
    if (kind === "" || kind !== l.kind || seen.has(l.target_id)) return null;
    seen.add(l.target_id);
    out.push({ tagId: "", targetId: l.target_id, kind });
  }
  return out;
}

/**
 * checkTagTargetsExist（submit.go:372-393）：条目必须在本节点且 state='active'；
 * 评论必须是一条本节点已收到的 comment.v1 事件。任一无 → false。
 */
function checkTagTargetsExist(db: Db, links: TagLink[]): boolean {
  for (const l of links) {
    if (l.kind === "comment") {
      const prefix = "comment/";
      const eventId = l.targetId.startsWith(prefix) ? l.targetId.slice(prefix.length) : l.targetId;
      if (!hasCommentEvent(db, eventId)) return false;
      continue;
    }
    const rows = db.select(`SELECT state FROM items WHERE item_id=?`, [l.targetId]);
    if (rows.length === 0 || toStr(rows[0].state) !== "active") return false;
  }
  return true;
}

/**
 * handleSubmitPost（submit.go:181-352）：已登记身份的作者把独立 article / quiz / tag /
 * course / lesson 直投本节点，验签通过即生效；任何失败都不写入。
 */
export function submitPostHandler(deps: SubmitDeps): AuthedHandler {
  return async (req, actor) => {
    const dec = decodeStrict(req, SUBMIT_SPEC);
    if (!dec.ok) return dec.resp;
    const v = dec.value;
    // author_id 只能取自鉴权身份：请求体携带即等于替他人署名（册子 §2.1 硬约束）。
    if (v.author_id === true) return writeAuthErr(400, "author_id_forbidden");
    const itemType = v.type as string;
    if (
      itemType !== ITEM_TYPE_ARTICLE &&
      itemType !== ITEM_TYPE_QUIZ &&
      itemType !== ITEM_TYPE_TAG &&
      itemType !== ITEM_TYPE_COURSE &&
      itemType !== ITEM_TYPE_LESSON
    ) {
      return writeAuthErr(400, "item_type_unsupported");
    }
    const itemId = v.item_id as string;
    let containerSegs: SegmentRow[] = [];
    switch (itemType) {
      case ITEM_TYPE_TAG:
        if (decodeTagPath(itemId) === null) return writeAuthErr(400, "item_id_invalid");
        break;
      case ITEM_TYPE_COURSE:
      case ITEM_TYPE_LESSON: {
        const shape = containerShapeOf(itemId);
        if (shape === "") return writeAuthErr(400, "item_id_invalid");
        if (shape !== itemType) return writeAuthErr(400, "item_type_mismatch");
        const segs = validateSubmitSegments(itemId, itemType, v.segments as SubmitSegment[]);
        if (segs === null) return writeAuthErr(400, "item_segments_invalid");
        containerSegs = segs;
        break;
      }
      default: {
        const code = splitSubmitItemId(itemId, itemType);
        if (code !== "") return writeAuthErr(400, code);
      }
    }
    const rawTitle = v.title as string;
    const title = trimGoSpace(rawTitle);
    if (!validItemTitle(rawTitle)) return writeAuthErr(400, "item_title_invalid");
    if (itemType === ITEM_TYPE_TAG) {
      const parsed = decodeTagPath(itemId);
      // title 不是自由字段：它由 item_id 三段重建而来（册子 §3.1）；decodeTagPath 已在上文确认非 null。
      const want = parsed === null ? "" : tagTitle(parsed.name, parsed.chapter, parsed.section);
      if (trimGoSpace(rawTitle) !== want) return writeAuthErr(400, "item_title_invalid");
    }
    const bodyMD = v.body_md as string;
    const questionJSON = v.question_json as string;
    const content = itemType === ITEM_TYPE_QUIZ ? questionJSON : bodyMD;
    if (Buffer.byteLength(content, "utf8") > MAX_SUBMIT_BYTES) {
      return writeAuthErr(413, "item_body_too_large");
    }
    if (itemType === ITEM_TYPE_QUIZ && !validQuestionJSON(questionJSON)) {
      return writeAuthErr(400, "item_question_invalid");
    }
    let tagLinks: TagLink[] = [];
    if (itemType === ITEM_TYPE_TAG) {
      const links = normalizeSubmitTagLinks(v.links as SubmitLink[]);
      if (links === null) return writeAuthErr(400, "tag_links_invalid");
      tagLinks = links;
    }
    // 限速在这之后、查库之前；必须保留 `||` 短路序（byID 拒绝时不得消耗 byIP 的令牌）。
    if (!deps.byID.allow(actor) || !deps.byIP.allow(CLIENT_BUCKET_KEY)) {
      return writeAuthErr(429, "item_rate_limited");
    }
    // content_hash 一律由服务端算（册子 §2.2）：请求体带的那个全程被忽略。
    let contentHash: string;
    switch (itemType) {
      case ITEM_TYPE_TAG:
        // 容器口径（#14 §3.3）：哈希只看物化的 segments 行。
        contentHash = segmentsContentHash(materializeTagSegments(tagLinks));
        break;
      case ITEM_TYPE_COURSE:
      case ITEM_TYPE_LESSON:
        // 容器口径（本册 §2.3）：按 seq 升序拼 "<kind>\t<text>\n"。
        contentHash = segmentsContentHash(containerSegs);
        break;
      default:
        contentHash = sha256Hex(utf8(itemType === ITEM_TYPE_ARTICLE ? bodyMD : questionJSON));
    }

    let pubKey: string;
    try {
      const rows = deps.db.select(
        `SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`,
        [actor],
      );
      if (rows.length === 0) return writeAuthErr(403, "identity_unregistered");
      pubKey = toStr(rows[0].pubkey);
    } catch (err) {
      return errResponse(err);
    }
    if (itemType === ITEM_TYPE_TAG) {
      // 资格（册子 §3.4）：验签通过但仍可能无权写——判定不可省略、不可配置。
      let governors: Set<string>;
      try {
        governors = governorSet(deps.db, deps.storeKey);
      } catch (err) {
        return errResponse(err);
      }
      if (!governors.has(actor)) return writeAuthErr(403, "tag_not_governor");
      let exists: boolean;
      try {
        exists = checkTagTargetsExist(deps.db, tagLinks);
      } catch (err) {
        return errResponse(err);
      }
      if (!exists) return writeAuthErr(400, "tag_target_not_found");
    }
    const authorSig = v.author_sig as string;
    if (!isHexN(authorSig, 64)) return writeAuthErr(400, "author_sig_invalid");
    // 作者公钥取本节点 identities 表；内容被搬到别的节点后，验签改走包内 contributors。
    if (!verifyAuthorSig(pubKey, itemId, contentHash, actor, authorSig)) {
      return writeAuthErr(400, "author_sig_invalid");
    }
    // tag 的 UpsertTagSubmission 返回值被 Go 丢弃（`_, err =`），故 tag 的响应恒 created:false。
    let created = false;
    try {
      switch (itemType) {
        case ITEM_TYPE_TAG:
          upsertTagSubmission(deps.db, {
            tagId: itemId,
            title,
            links: tagLinks,
            authorId: actor,
            authorSig,
          });
          break;
        case ITEM_TYPE_COURSE:
        case ITEM_TYPE_LESSON:
          created = upsertSegmentSubmission(deps.db, {
            itemId,
            type: itemType,
            title,
            segments: containerSegs,
            authorId: actor,
            authorSig,
          });
          break;
        default:
          created = upsertSubmission(deps.db, deps.storeKey, {
            itemId,
            type: itemType,
            title,
            bodyMd: bodyMD,
            questionJson: questionJSON,
            contentHash,
            authorId: actor,
            authorSig,
          });
      }
    } catch (err) {
      if (err instanceof ItemTakenError) return writeAuthErr(403, "item_id_taken");
      if (err instanceof TagTargetTaggedError) return writeAuthErr(403, "tag_target_tagged");
      return errResponse(err);
    }
    // 键序与 Go `map[string]any` 的字典序一致：author_id, content_hash, created, item_id, type。
    return jsonResponse(200, {
      author_id: actor,
      content_hash: contentHash,
      created,
      item_id: itemId,
      type: itemType,
    });
  };
}
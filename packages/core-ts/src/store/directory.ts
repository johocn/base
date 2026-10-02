/**
 * 目录 seed（开库引导）的**纯**派生与 SQL 文本：SQL 字面量逐字对齐
 * `internal/store/directory.go:304-446`，派生只做「三源名称 → 词条行序列」的搬运，
 * 不含驱动、不含事务。事务与幂等短路在宿主层（`apps/node/src/store/directory.ts`）。
 */
import { cleanDisplayName, normalizeTermKey } from "../directory";
import { compareGoString } from "../importer/container";

/** 目录词条的 kind 三值（`directory.go:17-21`）。 */
export type DirectorySeedKind = "category" | "instructor" | "tag";

/** seed 已完成标记的 meta 键（`directory.go:33`）。 */
export const META_DIRECTORY_SEEDED = "directory_seeded";

/** 目录版本水位的 meta 键（`store.go:23`）。 */
export const META_DIRECTORY_VERSION = "directory_version";

/** seed 短路读取（与 `GET_META_SQL` 同形，独立常量便于宿主层自洽）。 */
export const GET_DIRECTORY_SEEDED_SQL = "SELECT value FROM meta WHERE key=?";

export const SELECT_DIRECTORY_SEED_ATTRS_SQL =
  "SELECT DISTINCT kind,text FROM segments WHERE seq<0 AND kind IN ('attr.category','attr.instructor')";

export const SELECT_DIRECTORY_SEED_CATEGORY_SQL = "SELECT item_id FROM items WHERE source='category'";

export const SELECT_DIRECTORY_SEED_TAG_SQL = "SELECT item_id FROM items WHERE item_id LIKE 'tag/%'";

/**
 * 写词条（`directory.go:256-260`）：`first_author_id` 保留首次值（冲突时不覆盖），
 * `display_name` / `state` / `updated_at` 以本次为准。
 */
export const UPSERT_DIRECTORY_TERM_SQL = `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(kind,term_key) DO UPDATE SET
			display_name=excluded.display_name, state=excluded.state, updated_at=excluded.updated_at`;

/** seed 的三组来源（`directory.go:343-411`）。 */
export interface DirectorySeedSources {
  /** `SELECT_DIRECTORY_SEED_ATTRS_SQL` 的行。 */
  attrs: ReadonlyArray<{ kind: string; text: string }>;
  /** `SELECT_DIRECTORY_SEED_CATEGORY_SQL` 的行。 */
  categoryItemIds: readonly string[];
  /** `SELECT_DIRECTORY_SEED_TAG_SQL` 的行。 */
  tagItemIds: readonly string[];
}

/** 待写词条的一行（`directory.go:431` 的 `approveDirectoryTermExec` 入参前三项）。 */
export interface DirectorySeedTerm {
  kind: DirectorySeedKind;
  termKey: string;
  displayName: string;
}

/**
 * 归并三源为待写词条序列（`directory.go:325-434`）：
 *
 * 1. `attr.category` / `attr.instructor` 的属性取值，名称取 `text`；
 * 2. `source='category'` 的容器 slug（`item_id` 去 `category/` 前缀）；
 * 3. `item_id LIKE 'tag/%'` 的第二段。
 *
 * 按 (kind, term_key) 归并去重（**先到先得**，同键只写一次）；归一化非法或展示名清洗后
 * 为空的名称丢弃；最后按 (kind, term_key) 升序，抵消 map 迭代无序。空结果返回 `[]`。
 */
export function deriveDirectorySeedTerms(src: DirectorySeedSources): DirectorySeedTerm[] {
  const seen = new Map<string, DirectorySeedTerm>();
  const add = (kind: DirectorySeedKind, raw: string): void => {
    const termKey = normalizeTermKey(raw);
    if (termKey === null) return;
    const displayName = cleanDisplayName(raw);
    if (displayName === "") return;
    const k = kind + "\x00" + termKey;
    if (seen.has(k)) return;
    seen.set(k, { kind, termKey, displayName });
  };

  for (const a of src.attrs) {
    if (a.kind === "attr.category") add("category", a.text);
    else if (a.kind === "attr.instructor") add("instructor", a.text);
  }
  for (const itemId of src.categoryItemIds) {
    const name = stringsTrimPrefix(itemId, "category/");
    if (name === "") continue;
    add("category", name);
  }
  for (const itemId of src.tagItemIds) {
    const parts = itemId.split("/");
    if (parts.length < 2 || parts[1] === "") continue;
    add("tag", parts[1]!);
  }

  const out = [...seen.values()];
  out.sort((x, y) =>
    x.kind !== y.kind ? compareGoString(x.kind, y.kind) : compareGoString(x.termKey, y.termKey),
  );
  return out;
}

/** 对应 Go `strings.TrimPrefix`。 */
function stringsTrimPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}
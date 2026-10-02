/**
 * 编辑面失败日志出口（#47）：把选图 / 读文件 / 上传三类失败的现场追加到
 * `${workDir}/edit-surface.log`，供自检页只读回看。
 *
 * 只依赖注入的 `FsAdapter`（type-only import），不 import 'uni' / 'plus'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/blob.ts 同一约定）。
 */
import { utf8 } from '@base/protocol-ts';

import type { FsAdapter } from './platform/adapter';
import { decodeUtf8 } from './sync';

/** 日志文件名（自检页与编辑页共用同一常量）。 */
export const EDIT_LOG_NAME = 'edit-surface.log';

/** 上限 64 KiB：超出从头部截断，保留最新现场。 */
export const EDIT_LOG_MAX_BYTES = 64 * 1024;

/** 编辑面四个失败阶段（`submit` 为册子 #63 §4.2.2 新增）。 */
export type EditStage = 'pick' | 'read' | 'upload' | 'submit';

/** 追加一条失败日志；任何 IO 失败都静默（日志本身不得影响主流程）。 */
export async function recordEditFailure(
  fs: FsAdapter,
  workDir: string,
  stage: EditStage,
  detail: string,
): Promise<void> {
  try {
    const path = `${workDir}/${EDIT_LOG_NAME}`;
    let old = '';
    try {
      old = decodeUtf8(await fs.readFile(path));
    } catch {
      old = ''; // 不存在 / 读失败一律当空串
    }
    const line = `${JSON.stringify({ at: new Date().toISOString(), stage, detail })}\n`;
    let all = old + line;
    if (all.length > EDIT_LOG_MAX_BYTES) {
      all = all.slice(all.length - EDIT_LOG_MAX_BYTES);
      const nl = all.indexOf('\n');
      if (nl >= 0) all = all.slice(nl + 1); // 丢弃被截断的半行 JSON
    }
    await fs.writeFile(path, utf8(all));
  } catch {
    // 静默：日志写失败不能拖垮选图 / 读文件 / 上传主流程
  }
}

/** 读取日志尾部（自检页只读展示用）：文件不存在回 ''，超长只回尾部 maxBytes。 */
export async function readEditLog(fs: FsAdapter, workDir: string, maxBytes: number): Promise<string> {
  let all: string;
  try {
    all = decodeUtf8(await fs.readFile(`${workDir}/${EDIT_LOG_NAME}`));
  } catch {
    return '';
  }
  return all.length <= maxBytes ? all : all.slice(all.length - maxBytes);
}
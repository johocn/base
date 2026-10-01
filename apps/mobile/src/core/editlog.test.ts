import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import type { FsAdapter } from '../platform/adapter';
import { EDIT_LOG_MAX_BYTES, EDIT_LOG_NAME, readEditLog, recordEditFailure } from './editlog';
import { MemoryFs } from './fakes';
import { decodeUtf8 } from './sync';

const WORK_DIR = '/work';
const LOG_PATH = `${WORK_DIR}/${EDIT_LOG_NAME}`;

function logText(fs: MemoryFs): string {
  return decodeUtf8(fs.files.get(LOG_PATH)!);
}

/** writeFile 恒抛的匿名适配器：验证日志出口不得把 IO 失败冒泡给主流程。 */
const failingFs: FsAdapter = {
  rootDir: async () => WORK_DIR,
  writeFile: async () => {
    throw new Error('disk full');
  },
  readFile: async () => {
    throw new Error('no such file');
  },
  exists: async () => false,
  remove: async () => {},
  size: async () => 0,
};

describe('editlog：追加失败现场', () => {
  it('首次写入产生一行含 at / stage / detail 的 JSON Line', async () => {
    const fs = new MemoryFs();
    await recordEditFailure(fs, WORK_DIR, 'pick', '相册不可用');
    const lines = logText(fs).split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as { at: string; stage: string; detail: string };
    expect(row.stage).toBe('pick');
    expect(row.detail).toBe('相册不可用');
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
  });

  it('三次失败追加而非覆盖（含 submit 阶段，册子 #63 §4.2.2）', async () => {
    const fs = new MemoryFs();
    await recordEditFailure(fs, WORK_DIR, 'read', '读文件失败');
    await recordEditFailure(fs, WORK_DIR, 'upload', '上传失败');
    await recordEditFailure(fs, WORK_DIR, 'submit', '条目 id 不合法（item_id_invalid）');
    const lines = logText(fs).split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0]!) as { stage: string }).stage).toBe('read');
    expect((JSON.parse(lines[1]!) as { stage: string }).stage).toBe('upload');
    expect((JSON.parse(lines[2]!) as { stage: string }).stage).toBe('submit');
  });

  it('超上限从头部截断：文件 ≤ 64 KiB 且最新一行仍在', async () => {
    const fs = new MemoryFs();
    const detail = 'd'.repeat(2000);
    for (let i = 0; i < 80; i++) await recordEditFailure(fs, WORK_DIR, 'upload', `${detail}-${i}`);
    const text = logText(fs);
    expect(utf8(text).length).toBeLessThanOrEqual(EDIT_LOG_MAX_BYTES);
    const lines = text.split('\n').filter((l) => l !== '');
    const last = JSON.parse(lines[lines.length - 1]!) as { detail: string };
    expect(last.detail.endsWith('-79')).toBe(true);
  });

  it('写失败时 resolve 而非 reject', async () => {
    await expect(recordEditFailure(failingFs, WORK_DIR, 'upload', 'x')).resolves.toBeUndefined();
  });
});

describe('editlog：只读回看', () => {
  it('文件不存在回空串', async () => {
    const fs = new MemoryFs();
    expect(await readEditLog(fs, WORK_DIR, 4096)).toBe('');
  });

  it('超长只回尾部 maxBytes', async () => {
    const fs = new MemoryFs();
    await fs.writeFile(LOG_PATH, utf8('AAAA\nBBBB\nCCCC\n'));
    expect(await readEditLog(fs, WORK_DIR, 5)).toBe('CCCC\n');
    expect(await readEditLog(fs, WORK_DIR, 100)).toBe('AAAA\nBBBB\nCCCC\n');
  });
});
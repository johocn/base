import { describe, expect, it } from 'vitest';

import { PlusFs, pickCapabilityOf, toPlusUrl, type PlusEntry, type PlusRuntime } from './uni';

describe('选文件能力探针（本册 §3）', () => {
  it('App 端（有 plus）优先相册（chooseImage）', () => {
    expect(pickCapabilityOf(true, { chooseImage: () => undefined })).toBe('album');
    expect(pickCapabilityOf(true, { chooseImage: () => undefined, chooseFile: () => undefined })).toBe('album');
  });

  it('无相册时：有 chooseFile 走 chooseFile，都没有则 none', () => {
    expect(pickCapabilityOf(true, { chooseFile: () => undefined })).toBe('chooseFile');
    expect(pickCapabilityOf(true, {})).toBe('none');
  });

  it('无 plus（H5 / 老内核）不选相册，只认 chooseFile', () => {
    expect(pickCapabilityOf(false, { chooseImage: () => undefined })).toBe('none');
    expect(pickCapabilityOf(false, { chooseFile: () => undefined })).toBe('chooseFile');
  });
});

/** 假 io：'_doc' → 平台文档根；'file://…' → 去掉 scheme 的平台路径；其余原样。 */
function fakeIo(): PlusRuntime['io'] {
  return {
    convertLocalFileSystemURL(path: string): string {
      if (path === '_doc') return '/storage/emulated/0/Android/data/base/doc';
      if (path.startsWith('file://')) return path.slice('file://'.length);
      return path;
    },
    resolveLocalFileSystemURL(): void {
      throw new Error('测试不调 resolve');
    },
    FileReader: class {},
  } as unknown as PlusRuntime['io'];
}

describe('toPlusUrl：路径 → plus.io URL（册子 #63 §3.1 / §3.3）', () => {
  const io = fakeIo();

  it('file:// 绝对路径（不在 _doc 下）保留 file:// 交整串 resolve —— 不再丢 scheme', () => {
    expect(toPlusUrl(io, 'file:///storage/emulated/0/DCIM/a.jpg')).toBe('file:///storage/emulated/0/DCIM/a.jpg');
  });

  it('file:// 形态落在 _doc 下 ⇒ 折成 _doc/…（相册临时图走这条）', () => {
    expect(toPlusUrl(io, 'file:///storage/emulated/0/Android/data/base/doc/uniapp_temp/a.jpg')).toBe(
      '_doc/uniapp_temp/a.jpg',
    );
  });

  it('file://x（无第三个斜杠）也归一成绝对路径', () => {
    expect(toPlusUrl(io, 'file://storage/emulated/0/DCIM/b.jpg')).toBe('file:///storage/emulated/0/DCIM/b.jpg');
  });

  it('_doc 平台路径折成 _doc/…', () => {
    expect(toPlusUrl(io, '/storage/emulated/0/Android/data/base/doc/base/pack')).toBe('_doc/base/pack');
  });

  it('其余绝对路径补 file:// 前缀，避免被当相对 URL', () => {
    expect(toPlusUrl(io, '/storage/other/x')).toBe('file:///storage/other/x');
  });

  it('已是相对形态（_doc/…）原样返回', () => {
    expect(toPlusUrl(io, '_doc/base/x')).toBe('_doc/base/x');
  });
});

/** 假目录树：目录 / 文件都用绝对路径集合表示；`_doc` 固定折到 `/doc`。 */
function fakeTree(dirs: string[], files: string[] = []) {
  const D = new Set(dirs);
  const F = new Set(files);
  const entryOf = (path: string): PlusEntry =>
    ({
      getDirectory: (name: string, o: { create?: boolean }, ok: (e: PlusEntry) => void, err: (e: unknown) => void) => {
        const child = `${path}/${name}`;
        if (D.has(child)) return ok(entryOf(child));
        if (o.create === true) {
          D.add(child);
          return ok(entryOf(child));
        }
        err({ code: 15 });
      },
      getFile: (name: string, o: { create?: boolean }, ok: (e: unknown) => void, err: (e: unknown) => void) => {
        const child = `${path}/${name}`;
        if (F.has(child)) return ok({});
        if (o.create === true) {
          F.add(child);
          return ok({});
        }
        err({ code: 1 });
      },
    }) as unknown as PlusEntry;
  const io = {
    convertLocalFileSystemURL: (p: string) =>
      p === '_doc' ? '/doc' : p.startsWith('file://') ? p.slice('file://'.length) : p,
    resolveLocalFileSystemURL: (url: string, ok: (e: PlusEntry) => void, err: (e: unknown) => void) => {
      const path = url === '_doc' ? '/doc' : url.startsWith('file://') ? url.slice('file://'.length) : null;
      if (path !== null && D.has(path)) return ok(entryOf(path));
      err({ code: 5 });
    },
    FileReader: class {},
  } as unknown as PlusRuntime['io'];
  return { io, D, F };
}

describe('PlusFs 目录下钻（册子 #63 §3.2 / §3.3）', () => {
  function fsOf(t: { io: PlusRuntime['io'] }): PlusFs {
    return new PlusFs({ io: t.io } as unknown as PlusRuntime);
  }

  it('写路径逐段建目录（create:true 语义不变）', async () => {
    const t = fakeTree(['/doc', '/doc/base']);
    await fsOf(t).ensureDir('/doc/base/selfcheck');
    expect(t.D.has('/doc/base/selfcheck')).toBe(true);
  });

  it('读路径不建目录：exists 假且不留半截目录（AC 3 反面）', async () => {
    const t = fakeTree(['/doc', '/doc/base']);
    expect(await fsOf(t).exists('/doc/base/missing/x.bin')).toBe(false);
    expect(t.D.has('/doc/base/missing')).toBe(false);
  });

  it('file:// 绝对路径从已存在的祖先逐段建（候选 ① 落盘根探测就靠这条）', async () => {
    const t = fakeTree(['/data/user/0/pkg/files']);
    await fsOf(t).ensureDir('/data/user/0/pkg/files/base/.rootprobe');
    expect(t.D.has('/data/user/0/pkg/files/base/.rootprobe')).toBe(true);
  });
});

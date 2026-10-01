import { describe, expect, it } from 'vitest';

import { pickCapabilityOf, toPlusUrl, type PlusRuntime } from './uni';

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

describe('toPlusUrl：路径 → plus.io URL（本册 §3 附带修）', () => {
  const io = fakeIo();

  it('file:// 前缀统一过 convertLocalFileSystemURL（真机相册 / 附件给的绝对 URL）', () => {
    expect(toPlusUrl(io, 'file:///storage/emulated/0/DCIM/a.jpg')).toBe('/storage/emulated/0/DCIM/a.jpg');
  });

  it('_doc 平台路径折成 _doc/…', () => {
    expect(toPlusUrl(io, '/storage/emulated/0/Android/data/base/doc/base/pack')).toBe('_doc/base/pack');
  });

  it('其余绝对路径补 file:// 前缀，避免被当相对 URL', () => {
    expect(toPlusUrl(io, '/storage/other/x')).toBe('file:///storage/other/x');
  });
});

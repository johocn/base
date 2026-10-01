import { describe, expect, it } from 'vitest';

import { pickCapabilityOf } from './uni';

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

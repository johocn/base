import { describe, expect, it } from "vitest";

import {
  BLOB_FRAME_HEADER_SIZE,
  FETCH_MAX_BYTES,
  MAX_BLOB_FRAME_SIZE,
  readBlobFrame,
  writeBlobFrame,
} from "./blobpack";
import { blobId, utf8 } from "./hash";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("blobpack", () => {
  it("双帧往返：写两帧后按游标顺序读回", () => {
    const a = utf8("第一块");
    const b = new Uint8Array(1024).fill(7);
    const idA = blobId(a);
    const idB = blobId(b);
    const buf = concat(writeBlobFrame(idA, a), writeBlobFrame(idB, b));

    const fA = readBlobFrame(buf, 0);
    expect(fA).not.toBeNull();
    expect(fA!.blobId).toBe(idA);
    expect(Array.from(fA!.payload)).toEqual(Array.from(a));

    const fB = readBlobFrame(buf, fA!.next);
    expect(fB).not.toBeNull();
    expect(fB!.blobId).toBe(idB);
    expect(Array.from(fB!.payload)).toEqual(Array.from(b));

    expect(readBlobFrame(buf, fB!.next)).toBeNull();
  });

  it("流干净结束返回 null", () => {
    expect(readBlobFrame(new Uint8Array(0), 0)).toBeNull();
  });

  it("非法 blob_id 写入即抛错", () => {
    expect(() => writeBlobFrame("NOT-HEX", utf8("x"))).toThrow();
  });

  it("半截帧头抛错", () => {
    expect(() => readBlobFrame(new Uint8Array(10), 0)).toThrow();
  });

  it("帧头声明 size 超上限抛错", () => {
    const hdr = new Uint8Array(BLOB_FRAME_HEADER_SIZE);
    const id = blobId(utf8("x"));
    for (let i = 0; i < 32; i++) hdr[i] = id.charCodeAt(i);
    let size = MAX_BLOB_FRAME_SIZE + 1;
    for (let i = 7; i >= 0; i--) {
      hdr[32 + i] = size & 0xff;
      size = Math.floor(size / 256);
    }
    expect(() => readBlobFrame(hdr, 0)).toThrow();
  });

  it("FETCH_MAX_BYTES 是共享契约（64 MiB）", () => {
    expect(FETCH_MAX_BYTES).toBe(64 << 20);
  });
});

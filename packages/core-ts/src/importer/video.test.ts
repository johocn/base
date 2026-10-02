import { describe, expect, it } from "vitest";
import { sha256Hex, utf8 } from "@base/protocol-ts";

import {
  VIDEO_CHUNK_SIZE,
  chunkSizes,
  guessVideoMime,
  videoContentHash,
  videoItemId,
  videoTitleFromPath,
} from "./video";

describe("VIDEO_CHUNK_SIZE", () => {
  it("= 1 MiB", () => {
    expect(VIDEO_CHUNK_SIZE).toBe(1048576);
  });
});

describe("guessVideoMime", () => {
  it("按扩展名（大小写不敏感）映射，未知回落 octet-stream", () => {
    expect(guessVideoMime("clip.mp4")).toBe("video/mp4");
    expect(guessVideoMime("CLIP.M4V")).toBe("video/mp4");
    expect(guessVideoMime("dir/sub/x.webm")).toBe("video/webm");
    expect(guessVideoMime("x.mkv")).toBe("video/x-matroska");
    expect(guessVideoMime("x.mov")).toBe("video/quicktime");
    expect(guessVideoMime("x.avi")).toBe("application/octet-stream");
    expect(guessVideoMime("noext")).toBe("application/octet-stream");
    expect(guessVideoMime("dir.d/clip")).toBe("application/octet-stream");
  });
});

describe("videoItemId", () => {
  it("course/<course>/lesson/<lesson>/video/<slug>", () => {
    expect(videoItemId("c1", "l1", "v1")).toBe("course/c1/lesson/l1/video/v1");
  });
});

describe("videoContentHash", () => {
  it("= sha256Hex(utf8(块 id 按序拼接))", () => {
    expect(videoContentHash(["a", "b"])).toBe(sha256Hex(utf8("ab")));
    expect(videoContentHash(["abcdef"])).toBe(sha256Hex(utf8("abcdef")));
  });
});

describe("chunkSizes", () => {
  it("满块 + 末块可短；0 字节为空", () => {
    expect(chunkSizes(0)).toEqual([]);
    expect(chunkSizes(VIDEO_CHUNK_SIZE)).toEqual([VIDEO_CHUNK_SIZE]);
    expect(chunkSizes(VIDEO_CHUNK_SIZE + 3)).toEqual([VIDEO_CHUNK_SIZE, 3]);
    expect(chunkSizes(2 * VIDEO_CHUNK_SIZE + 1)).toEqual([
      VIDEO_CHUNK_SIZE,
      VIDEO_CHUNK_SIZE,
      1,
    ]);
  });

  it("自定义粒度", () => {
    expect(chunkSizes(10, 4)).toEqual([4, 4, 2]);
    expect(chunkSizes(8, 4)).toEqual([4, 4]);
  });
});

describe("videoTitleFromPath", () => {
  it("去目录与扩展名", () => {
    expect(videoTitleFromPath("dir/clip.mp4")).toBe("clip");
    expect(videoTitleFromPath("clip.MP4")).toBe("clip");
    expect(videoTitleFromPath("noext")).toBe("noext");
  });
});
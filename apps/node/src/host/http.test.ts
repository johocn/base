import { describe, expect, it } from "vitest";
import type { ServerHandler } from "@base/core-ts";
import { createRouter, matchPattern } from "./http";

const noop: ServerHandler = async () => ({ status: 200 });

describe("matchPattern：段语法", () => {
  it("{name} 匹配单段并提取 params", () => {
    expect(matchPattern("/a/{id}", "GET", "/a/42")).toEqual({ id: "42" });
    expect(matchPattern("/a/{id}/b", "GET", "/a/42/b")).toEqual({ id: "42" });
  });

  it("{name} 不跨段、不匹配长度不符", () => {
    expect(matchPattern("/a/{id}", "GET", "/a/42/b")).toBeNull();
    expect(matchPattern("/a/{id}", "GET", "/b/42")).toBeNull();
    expect(matchPattern("/a/{id}", "GET", "/a")).toBeNull();
  });

  it("{name...} 匹配剩余全部（含空）", () => {
    expect(matchPattern("/a/{rest...}", "GET", "/a/x/y.z")).toEqual({ rest: "x/y.z" });
    expect(matchPattern("/a/{rest...}", "GET", "/a/x")).toEqual({ rest: "x" });
    expect(matchPattern("/a/{rest...}", "GET", "/a/")).toEqual({ rest: "" });
  });

  it("无方法 pattern 匹配任意方法", () => {
    expect(matchPattern("/healthz", "POST", "/healthz")).toEqual({});
  });
});

describe("matchPattern：方法语义", () => {
  it("GET pattern 同时命中 HEAD", () => {
    expect(matchPattern("GET /healthz", "GET", "/healthz")).toEqual({});
    expect(matchPattern("GET /healthz", "HEAD", "/healthz")).toEqual({});
    expect(matchPattern("GET /healthz", "POST", "/healthz")).toBeNull();
  });
});

describe("createRouter：具体度优先", () => {
  it("字面段多者胜出", () => {
    const router = createRouter();
    const wild: ServerHandler = async () => ({ status: 200 });
    const literal: ServerHandler = async () => ({ status: 201 });
    router.handle("/a/{id}", wild);
    router.handle("/a/x", literal);
    expect(router.match("GET", "/a/x")?.handler).toBe(literal);
    expect(router.match("GET", "/a/y")?.handler).toBe(wild);
  });

  it("同具体度时方法限定者胜出", () => {
    const router = createRouter();
    const any: ServerHandler = async () => ({ status: 200 });
    const get: ServerHandler = async () => ({ status: 201 });
    router.handle("/v1/catalog", any);
    router.handle("GET /v1/catalog", get);
    expect(router.match("GET", "/v1/catalog")?.handler).toBe(get);
    expect(router.match("POST", "/v1/catalog")?.handler).toBe(any);
  });
});

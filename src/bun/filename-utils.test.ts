import { describe, expect, test } from "bun:test";
import { deriveTabFilename, resolveSaveTarget } from "./filename-utils";

describe("deriveTabFilename", () => {
  test("appends .tab when missing", () => {
    expect(deriveTabFilename("galliard")).toBe("galliard.tab");
  });
  test("keeps an existing .tab extension", () => {
    expect(deriveTabFilename("galliard.tab")).toBe("galliard.tab");
  });
  test("matches .tab case-insensitively, preserving the typed case", () => {
    expect(deriveTabFilename("Song.TAB")).toBe("Song.TAB");
  });
  test("trims surrounding whitespace", () => {
    expect(deriveTabFilename("  pavane  ")).toBe("pavane.tab");
  });
  test("rejects path separators and parent refs", () => {
    expect(deriveTabFilename("../secret")).toBeNull();
    expect(deriveTabFilename("a/b")).toBeNull();
    expect(deriveTabFilename("a\\b")).toBeNull();
  });
  test("rejects an embedded double-dot even when not a path component", () => {
    expect(deriveTabFilename("foo..bar")).toBeNull();
  });
  test("rejects empty and hidden names", () => {
    expect(deriveTabFilename("")).toBeNull();
    expect(deriveTabFilename("   ")).toBeNull();
    expect(deriveTabFilename(".tab")).toBeNull();
  });
});

const PROJECT = "/Users/test/Documents/Tabbo";

describe("resolveSaveTarget", () => {
  test("new document → project dir, isNew", () => {
    expect(resolveSaveTarget("galliard.tab", null, PROJECT)).toEqual({
      path: "/Users/test/Documents/Tabbo/galliard.tab",
      isNew: true,
    });
  });
  test("unchanged name → round-trip to currentPath, not new", () => {
    expect(resolveSaveTarget("galliard.tab", "/Users/test/scores/galliard.tab", PROJECT)).toEqual({
      path: "/Users/test/scores/galliard.tab",
      isNew: false,
    });
  });
  test("renamed → same directory as current, isNew", () => {
    expect(resolveSaveTarget("pavane.tab", "/Users/test/scores/galliard.tab", PROJECT)).toEqual({
      path: "/Users/test/scores/pavane.tab",
      isNew: true,
    });
  });
  test("comparison is exact-string (case-only change → Save As)", () => {
    expect(resolveSaveTarget("Galliard.tab", "/Users/test/scores/galliard.tab", PROJECT)).toEqual({
      path: "/Users/test/scores/Galliard.tab",
      isNew: true,
    });
  });
});

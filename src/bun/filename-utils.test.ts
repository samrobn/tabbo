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

const PROJECT = "/u/test/Documents/Tabbo";

describe("resolveSaveTarget", () => {
  test("new document → project dir, isNew", () => {
    expect(resolveSaveTarget("galliard.tab", null, PROJECT)).toEqual({
      path: "/u/test/Documents/Tabbo/galliard.tab",
      isNew: true,
    });
  });
  test("unchanged name → round-trip to currentPath, not new", () => {
    expect(resolveSaveTarget("galliard.tab", "/u/test/scores/galliard.tab", PROJECT)).toEqual({
      path: "/u/test/scores/galliard.tab",
      isNew: false,
    });
  });
  test("renamed → same directory as current, isNew", () => {
    expect(resolveSaveTarget("pavane.tab", "/u/test/scores/galliard.tab", PROJECT)).toEqual({
      path: "/u/test/scores/pavane.tab",
      isNew: true,
    });
  });
  test("comparison is exact-string (case-only change → Save As)", () => {
    expect(resolveSaveTarget("Galliard.tab", "/u/test/scores/galliard.tab", PROJECT)).toEqual({
      path: "/u/test/scores/Galliard.tab",
      isNew: true,
    });
  });
  test("targetDir override → joins name onto targetDir, isNew when path differs", () => {
    expect(resolveSaveTarget("galliard.tab", "/u/test/scores/galliard.tab", PROJECT, "/u/test/Desktop")).toEqual({
      path: "/u/test/Desktop/galliard.tab",
      isNew: true,
    });
  });
  test("targetDir equal to current dir → round-trip, not new", () => {
    expect(resolveSaveTarget("galliard.tab", "/u/test/scores/galliard.tab", PROJECT, "/u/test/scores")).toEqual({
      path: "/u/test/scores/galliard.tab",
      isNew: false,
    });
  });
  test("null targetDir → unchanged default behaviour", () => {
    expect(resolveSaveTarget("galliard.tab", null, PROJECT, null)).toEqual({
      path: "/u/test/Documents/Tabbo/galliard.tab",
      isNew: true,
    });
  });
});

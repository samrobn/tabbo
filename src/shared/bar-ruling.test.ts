import { describe, expect, test } from "bun:test";
import { computeBarRuling } from "./bar-ruling";

describe("computeBarRuling", () => {
  test("numbers barlines sequentially and marks even bars alt", () => {
    const lines = ["-R9", "{title}", "1 ea c", "b", "2acd a", "b"];
    const r = computeBarRuling(lines);
    expect(r.barNumberByLine).toEqual([null, null, null, 1, null, 2]);
    // bar 1 content + its barline: not alt; bar 2 content + its barline: alt
    expect(r.altByLine).toEqual([false, false, false, false, true, true]);
  });

  test("matches every tokenizer barline form, trailing content allowed", () => {
    // mirrors tab-language.ts:83: /^\.?[bB]+\.?(?![a-z])/
    const r = computeBarRuling(["b", "bb", ".bb.", "B", "bQ", "bbX", "b1", "b  "]);
    expect(r.barNumberByLine).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a fret-letter line starting with b is not a barline", () => {
    const r = computeBarRuling(["baac", "1 ea c"]);
    expect(r.barNumberByLine).toEqual([null, null]);
    expect(r.altByLine).toEqual([false, false]);
  });

  test("empty doc and no-barline doc", () => {
    expect(computeBarRuling([])).toEqual({ barNumberByLine: [], altByLine: [] });
    expect(computeBarRuling(["-N", "{x}"])).toEqual({
      barNumberByLine: [null, null],
      altByLine: [false, false],
    });
  });
});

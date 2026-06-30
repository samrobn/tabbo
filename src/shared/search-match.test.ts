import { test, expect, describe } from "bun:test";
import { currentMatchIndex, matchToSelect, type MatchRange } from "./search-match";

const tiling: MatchRange[] = [
  { from: 0, to: 2 },
  { from: 2, to: 4 },
  { from: 4, to: 6 },
];

describe("currentMatchIndex", () => {
  test("empty match list returns 0", () => {
    expect(currentMatchIndex([], { from: 0, to: 2 })).toBe(0);
  });
  test("selection on the second match returns 1-based index 2", () => {
    expect(currentMatchIndex(tiling, { from: 2, to: 4 })).toBe(2);
  });
  test("selection with matching from but different to returns 0", () => {
    expect(currentMatchIndex(tiling, { from: 2, to: 3 })).toBe(0);
  });
  test("selection outside the canonical tiling returns 0", () => {
    // doc '------', query '--' tiles to {0,2,4}; a selection at 1-3 is not a tile
    expect(currentMatchIndex(tiling, { from: 1, to: 3 })).toBe(0);
  });
  test("selection on the last match returns the last index", () => {
    expect(currentMatchIndex(tiling, { from: 4, to: 6 })).toBe(3);
  });
});

describe("matchToSelect", () => {
  test("empty match list returns -1", () => {
    expect(matchToSelect([], 0)).toBe(-1);
  });
  test("anchor before all matches selects the first", () => {
    expect(matchToSelect(tiling, 0)).toBe(0);
  });
  test("anchor between matches selects the first at/after it", () => {
    expect(matchToSelect(tiling, 3)).toBe(2);
  });
  test("anchor exactly on a match start selects that match", () => {
    expect(matchToSelect(tiling, 2)).toBe(1);
  });
  test("anchor past the last match wraps to the first", () => {
    expect(matchToSelect(tiling, 99)).toBe(0);
  });
});

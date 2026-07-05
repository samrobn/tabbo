import { test, expect, describe } from "bun:test";
import { computeScrollbarMarkers, type MatchLine } from "./scrollbar-markers";

describe("computeScrollbarMarkers", () => {
  test("empty match list returns no markers", () => {
    expect(computeScrollbarMarkers([], 100, 400)).toEqual([]);
  });

  test("zero total lines returns no markers", () => {
    expect(computeScrollbarMarkers([{ line: 1, active: false }], 0, 400)).toEqual([]);
  });

  test("zero rail height returns no markers", () => {
    expect(computeScrollbarMarkers([{ line: 1, active: false }], 100, 0)).toEqual([]);
  });

  test("a single match near the top of a short document maps to a low row", () => {
    const markers = computeScrollbarMarkers([{ line: 1, active: false }], 100, 400);
    expect(markers).toEqual([{ top: 4, active: false }]);
  });

  test("a match at the last line maps near the bottom of the rail", () => {
    const markers = computeScrollbarMarkers([{ line: 100, active: false }], 100, 400);
    expect(markers).toEqual([{ top: 399, active: false }]);
  });

  test("a match halfway through the document maps to the middle of the rail", () => {
    const markers = computeScrollbarMarkers([{ line: 50, active: false }], 100, 400);
    expect(markers).toEqual([{ top: 200, active: false }]);
  });

  test("markers are sorted by document order (top to bottom)", () => {
    const matches: MatchLine[] = [
      { line: 80, active: false },
      { line: 10, active: false },
      { line: 40, active: false },
    ];
    const markers = computeScrollbarMarkers(matches, 100, 400);
    expect(markers.map((marker) => marker.top)).toEqual([40, 160, 320]);
  });

  test("the active match is flagged distinct from the rest", () => {
    const matches: MatchLine[] = [
      { line: 10, active: false },
      { line: 90, active: true },
    ];
    const markers = computeScrollbarMarkers(matches, 100, 400);
    expect(markers.find((marker) => marker.top === 360)?.active).toBe(true);
    expect(markers.find((marker) => marker.top === 40)?.active).toBe(false);
  });

  test("dense matches landing on the same pixel row collapse into one marker", () => {
    // A 2000-line document rendered on an 8px rail: many lines share a row.
    const matches: MatchLine[] = Array.from({ length: 500 }, (_, index) => ({
      line: index + 1,
      active: false,
    }));
    const markers = computeScrollbarMarkers(matches, 2000, 8);
    // Collapsed to at most one marker per rail pixel, never one per match.
    expect(markers.length).toBeLessThanOrEqual(8);
    expect(markers.length).toBeGreaterThan(0);
  });

  test("a collapsed row is active if any contributing match is active", () => {
    // Two matches on adjacent lines of a huge document land on the same
    // rail row at a small rail height; the row must report active even
    // though only one of the two matches is the current one. The active
    // match comes FIRST so an overwrite-instead-of-OR bug (last write wins)
    // would flip the row inactive and fail this test.
    const matches: MatchLine[] = [
      { line: 500, active: true },
      { line: 501, active: false },
    ];
    const markers = computeScrollbarMarkers(matches, 100000, 8);
    expect(markers).toHaveLength(1);
    expect(markers[0].active).toBe(true);
  });
});

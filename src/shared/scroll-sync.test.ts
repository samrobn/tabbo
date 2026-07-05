import { describe, expect, test } from "bun:test";
import { scrollFraction, scrollTopForFraction, clampScrollTop, buildLineOffsetMap } from "./scroll-sync";

describe("scrollFraction", () => {
  test("0 at the top", () => {
    expect(scrollFraction(0, 2000, 500)).toBe(0);
  });

  test("1 at the bottom", () => {
    expect(scrollFraction(1500, 2000, 500)).toBe(1);
  });

  test("proportional partway through", () => {
    expect(scrollFraction(750, 2000, 500)).toBe(0.5);
  });

  test("clamps above 1 (scrollTop past the max, e.g. mid-resize)", () => {
    expect(scrollFraction(9999, 2000, 500)).toBe(1);
  });

  test("clamps below 0 (negative scrollTop, e.g. rubber-band overscroll)", () => {
    expect(scrollFraction(-50, 2000, 500)).toBe(0);
  });

  test("content shorter than the pane -> 0, never NaN", () => {
    expect(scrollFraction(0, 300, 500)).toBe(0);
    expect(scrollFraction(0, 500, 500)).toBe(0);
  });
});

describe("scrollTopForFraction", () => {
  test("0 -> top", () => {
    expect(scrollTopForFraction(0, 2000, 500)).toBe(0);
  });

  test("1 -> bottom", () => {
    expect(scrollTopForFraction(1, 2000, 500)).toBe(1500);
  });

  test("proportional partway through", () => {
    expect(scrollTopForFraction(0.5, 2000, 500)).toBe(750);
  });

  test("content shorter than the pane -> 0, never NaN", () => {
    expect(scrollTopForFraction(0.5, 300, 500)).toBe(0);
    expect(scrollTopForFraction(0.5, 500, 500)).toBe(0);
  });
});

describe("clampScrollTop", () => {
  test("passes through an in-range value", () => {
    expect(clampScrollTop(750, 2000, 500)).toBe(750);
  });

  test("clamps above the max scrollTop", () => {
    expect(clampScrollTop(9999, 2000, 500)).toBe(1500);
  });

  test("clamps below 0", () => {
    expect(clampScrollTop(-50, 2000, 500)).toBe(0);
  });

  test("content shorter than the pane -> 0", () => {
    expect(clampScrollTop(100, 300, 500)).toBe(0);
  });

  test("never returns NaN or Infinity", () => {
    expect(clampScrollTop(NaN, 2000, 500)).toBe(0);
    expect(clampScrollTop(Infinity, 2000, 500)).toBe(1500);
    expect(clampScrollTop(-Infinity, 2000, 500)).toBe(0);
  });
});

describe("buildLineOffsetMap", () => {
  test("degenerate: 0 points -> null", () => {
    expect(buildLineOffsetMap([])).toBeNull();
  });

  test("degenerate: 1 point -> null", () => {
    expect(buildLineOffsetMap([{ line: 10, offset: 100 }])).toBeNull();
  });

  test("degenerate: all points share the same line -> null", () => {
    expect(buildLineOffsetMap([{ line: 5, offset: 0 }, { line: 5, offset: 50 }])).toBeNull();
  });

  test("interpolates linearly between two consecutive anchors", () => {
    const map = buildLineOffsetMap([{ line: 10, offset: 100 }, { line: 20, offset: 300 }])!;
    expect(map.lineToOffset(15)).toBe(200);
    expect(map.offsetToLine(200)).toBe(15);
  });

  test("interpolates across three anchors, picking the right segment", () => {
    const map = buildLineOffsetMap([
      { line: 1, offset: 0 },
      { line: 10, offset: 100 },
      { line: 30, offset: 500 },
    ])!;
    expect(map.lineToOffset(5)).toBeCloseTo((5 - 1) / (10 - 1) * 100, 5);
    expect(map.lineToOffset(20)).toBeCloseTo(100 + (20 - 10) / (30 - 10) * (500 - 100), 5);
    expect(map.offsetToLine(300)).toBeCloseTo(20, 5);
  });

  test("before the first anchor ramps linearly from (line 1, offset 0)", () => {
    const map = buildLineOffsetMap([{ line: 11, offset: 200 }, { line: 21, offset: 400 }])!;
    // Line 1 -> offset 0, line 11 -> offset 200: line 6 is halfway.
    expect(map.lineToOffset(1)).toBeCloseTo(0, 5);
    expect(map.lineToOffset(6)).toBeCloseTo(100, 5);
    expect(map.offsetToLine(0)).toBeCloseTo(1, 5);
    expect(map.offsetToLine(100)).toBeCloseTo(6, 5);
  });

  test("first anchor already at line 1 - no synthetic ramp segment", () => {
    const map = buildLineOffsetMap([{ line: 1, offset: 50 }, { line: 11, offset: 250 }])!;
    expect(map.lineToOffset(1)).toBe(50);
  });

  test("extrapolates past the last anchor using the final segment's slope", () => {
    const map = buildLineOffsetMap([{ line: 10, offset: 100 }, { line: 20, offset: 300 }])!;
    // Slope is 20px/line; line 30 -> offset 500.
    expect(map.lineToOffset(30)).toBeCloseTo(500, 5);
    expect(map.offsetToLine(500)).toBeCloseTo(30, 5);
  });

  test("extrapolates before line 1 using the leading segment's slope (defensive, not a real caller input)", () => {
    const map = buildLineOffsetMap([{ line: 11, offset: 200 }, { line: 21, offset: 400 }])!;
    expect(map.lineToOffset(-4)).toBeCloseTo(-100, 5);
  });

  test("flat segment (zero slope) never divides by zero", () => {
    const map = buildLineOffsetMap([
      { line: 1, offset: 0 },
      { line: 10, offset: 100 },
      { line: 20, offset: 100 },
    ])!;
    expect(map.lineToOffset(15)).toBe(100);
    expect(Number.isFinite(map.offsetToLine(100))).toBe(true);
    expect(map.offsetToLine(100)).toBeGreaterThanOrEqual(10);
    expect(map.offsetToLine(100)).toBeLessThanOrEqual(20);
  });

  test("duplicate line entries collapse to one point (first occurrence wins)", () => {
    const map = buildLineOffsetMap([
      { line: 10, offset: 100 },
      { line: 10, offset: 999 },
      { line: 20, offset: 300 },
    ])!;
    expect(map.lineToOffset(10)).toBe(100);
  });

  test("unsorted input points are sorted before mapping", () => {
    const map = buildLineOffsetMap([
      { line: 20, offset: 300 },
      { line: 10, offset: 100 },
    ])!;
    expect(map.lineToOffset(15)).toBe(200);
  });

  test("non-monotonic offsets (two systems close in y) are flattened so forward/inverse agree", () => {
    const map = buildLineOffsetMap([
      { line: 1, offset: 0 },
      { line: 10, offset: 100 },
      { line: 20, offset: 90 },
      { line: 30, offset: 300 },
    ])!;
    const offset = map.lineToOffset(15);
    const roundTripLine = map.offsetToLine(offset);
    expect(roundTripLine).toBeGreaterThanOrEqual(1);
    expect(roundTripLine).toBeLessThanOrEqual(30);
    // Re-mapping the round-tripped line back to an offset must reproduce the
    // same offset - forward and inverse agree on the flattened segment,
    // rather than offsetToLine skipping it and returning a value from an
    // unrelated bracket.
    expect(map.lineToOffset(roundTripLine)).toBeCloseTo(offset, 5);
  });
});

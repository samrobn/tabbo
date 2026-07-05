import { describe, expect, test } from "bun:test";
import { pageDisplayWidthPx, stepZoom } from "./zoom";

// Container width chosen so fit width (containerWidth - 32) comes out to a
// round number, keeping percentage arithmetic exact in the tests below.
const CONTAINER_WIDTH = 532; // fit width = 500

describe("pageDisplayWidthPx", () => {
  test("100% fills the panel's fit width exactly", () => {
    expect(pageDisplayWidthPx(100, 532)).toBe(500);
    expect(pageDisplayWidthPx(100, 1232)).toBe(1200);
  });

  test("scales linearly with percent at a fixed container width", () => {
    expect(pageDisplayWidthPx(50, CONTAINER_WIDTH)).toBe(250);
    expect(pageDisplayWidthPx(200, CONTAINER_WIDTH)).toBe(1000);
  });

  test("sticky/panel-relative: at a fixed percent, rendered width scales linearly with the container as it resizes", () => {
    // 50% stays half the panel's fit width no matter how the panel resizes
    expect(pageDisplayWidthPx(50, 532)).toBe(250); // fit width 500 -> 250
    expect(pageDisplayWidthPx(50, 1032)).toBe(500); // fit width 1000 -> 500
    expect(pageDisplayWidthPx(50, 232)).toBe(100); // fit width 200 -> 100
  });

  test("rounds to the nearest pixel", () => {
    expect(pageDisplayWidthPx(33, CONTAINER_WIDTH)).toBe(Math.round(500 * 0.33));
  });
});

describe("stepZoom", () => {
  test("steps up/down by the given step", () => {
    expect(stepZoom(100, 1, 25, 50, 200)).toBe(125);
    expect(stepZoom(100, -1, 25, 50, 200)).toBe(75);
  });

  test("clamps to max", () => {
    expect(stepZoom(200, 1, 25, 50, 200)).toBe(200);
    expect(stepZoom(175, 1, 25, 50, 200)).toBe(200);
  });

  test("clamps to min", () => {
    expect(stepZoom(50, -1, 25, 50, 200)).toBe(50);
    expect(stepZoom(75, -1, 25, 50, 200)).toBe(50);
  });

  test("reset to 100 (the default) then fills the panel exactly", () => {
    const reset = 100;
    expect(pageDisplayWidthPx(reset, 532)).toBe(500);
  });
});

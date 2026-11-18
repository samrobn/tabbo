import { describe, expect, test } from "bun:test";
import { DEFAULT_WINDOW_FRAME, fillsADisplay, frameToRestore, isRestorable, usableFrame } from "./window-frame";

const laptop = { x: 0, y: 0, width: 1512, height: 944 };
const external = { x: 1512, y: 0, width: 2560, height: 1440 };

describe("frameToRestore", () => {
	test("restores a saved frame that lands on a connected display", () => {
		const saved = { x: 200, y: 60, width: 1300, height: 860 };
		expect(frameToRestore(saved, [laptop])).toEqual(saved);
	});

	test("restores a frame on a second display while it is connected", () => {
		const saved = { x: 1700, y: 100, width: 1400, height: 1000 };
		expect(frameToRestore(saved, [laptop, external])).toEqual(saved);
	});

	test("falls back when the display the window was on has gone", () => {
		const saved = { x: 1700, y: 100, width: 1400, height: 1000 };
		expect(frameToRestore(saved, [laptop])).toEqual(DEFAULT_WINDOW_FRAME);
	});

	test("falls back when nothing was saved, or the saved value is malformed or tiny", () => {
		expect(frameToRestore(undefined, [laptop])).toEqual(DEFAULT_WINDOW_FRAME);
		expect(frameToRestore({ x: 0, y: 0, width: "wide", height: 800 }, [laptop])).toEqual(DEFAULT_WINDOW_FRAME);
		expect(frameToRestore({ x: 0, y: 0, width: 50, height: 40 }, [laptop])).toEqual(DEFAULT_WINDOW_FRAME);
	});

	test("usableFrame keeps a sane saved frame whatever display it is on, and rejects the rest", () => {
		const offScreen = { x: 9000, y: 9000, width: 1300, height: 860 };
		expect(usableFrame(offScreen)).toBe(offScreen);
		expect(usableFrame({ x: 0, y: 0, width: 50, height: 40 })).toBeNull();
		expect(usableFrame(undefined)).toBeNull();
	});

	test("isRestorable answers the same question as frameToRestore, without object identity", () => {
		expect(isRestorable({ x: 200, y: 60, width: 1300, height: 860 }, [laptop])).toBe(true);
		expect(isRestorable({ x: 1700, y: 100, width: 1400, height: 1000 }, [laptop])).toBe(false);
	});

	test("fillsADisplay spots a fullscreen frame even when it is reachable", () => {
		const fullscreen = { ...laptop };
		expect(isRestorable(fullscreen, [laptop])).toBe(true);
		expect(fillsADisplay(fullscreen, [laptop])).toBe(true);
		expect(fillsADisplay({ x: 200, y: 60, width: 1300, height: 860 }, [laptop])).toBe(false);
	});
});

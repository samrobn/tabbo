export interface WindowFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const DEFAULT_WINDOW_FRAME: WindowFrame = { x: 100, y: 100, width: 1200, height: 800 };

const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;
// How much of the title bar must land on a display for the frame to count as reachable.
const MIN_VISIBLE = 80;

/**
 * The frame to open the window at: the saved one when it is a sane size and
 * still lands on a connected display (a monitor unplugged since last run would
 * otherwise open the window off-screen), else the default.
 */
export function frameToRestore(saved: unknown, displays: WindowFrame[]): WindowFrame {
	return isRestorable(saved, displays) ? saved : DEFAULT_WINDOW_FRAME;
}

/** Whether a frame is a sane size and lands on one of the displays' work areas. */
export function isRestorable(saved: unknown, displays: WindowFrame[]): saved is WindowFrame {
	const frame = usableFrame(saved);
	return frame !== null && displays.some((display) =>
		overlap(frame.x, frame.width, display.x, display.width) >= MIN_VISIBLE &&
		frame.y >= display.y &&
		frame.y < display.y + display.height,
	);
}

/**
 * Whether a frame exactly covers a whole display - a fullscreen window. Its
 * top edge can sit inside the work area when the menu bar auto-hides, so
 * reachability alone doesn't rule it out.
 */
export function fillsADisplay(frame: WindowFrame, displayBounds: WindowFrame[]): boolean {
	return displayBounds.some((bounds) =>
		frame.x === bounds.x && frame.y === bounds.y && frame.width === bounds.width && frame.height === bounds.height,
	);
}

/** The saved frame if it is well-formed and a sane size, whatever display it is on. */
export function usableFrame(saved: unknown): WindowFrame | null {
	return isFrame(saved) && saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT ? saved : null;
}

function isFrame(value: unknown): value is WindowFrame {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as Record<string, unknown>;
	return ["x", "y", "width", "height"].every((key) => Number.isFinite(frame[key]));
}

function overlap(start: number, length: number, otherStart: number, otherLength: number): number {
	return Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart);
}

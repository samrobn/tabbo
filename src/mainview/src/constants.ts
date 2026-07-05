export const DEFAULT_TAB_CONTENT = `% Simple lute tablature example
b
1-abc dDo
2-efg hG
Y-
e`;

export const COMPILE_MESSAGES = {
	COMPILING: "Compiling...",
	COMPILATION_FAILED: "Compilation failed",
	EMPTY_PREVIEW: "Preview will appear here",
} as const;

export const STORAGE_KEYS = {
	DRAFT: "tabbo:draft",
	FILENAME: "tabbo:filename",
	FILEPATH: "tabbo:filepath",
	TARGETDIR: "tabbo:targetdir",
	SPLIT: "tabbo:split",
	SCROLL_SYNC: "tabbo:scroll-sync",
	UPDATE_SNOOZED_VERSION: "tabbo:update-snoozed-version",
} as const;

export const AUTO_SAVE_INTERVAL_MS = 30_000;

// Realistic release cadence is days-to-weeks; 6h catches every plausible
// release with at most one re-check per day without hammering the feed.
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const EXPORT_STATUS_DISPLAY_MS = 4_000;

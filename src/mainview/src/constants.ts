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
	UPDATE_SNOOZED_VERSION: "tabbo:update-snoozed-version",
} as const;

export const AUTO_SAVE_INTERVAL_MS = 30_000;

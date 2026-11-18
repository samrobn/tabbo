/**
 * Most-recent-first history (save folders, opened files): prepend `item`, drop
 * any earlier occurrence, cap the length. Pure and dependency-free so both bun
 * and the webview import it.
 */
export function addRecent(list: string[], item: string, cap = 5): string[] {
	return [item, ...list.filter((existing) => existing !== item)].slice(0, cap);
}

export interface RecentLists {
	recentFiles: string[];
	recentSaveDirs: string[];
}

const RECENT_FILES_CAP = 8;
const RECENT_DIRS_CAP = 5;

/** The stored recent lists after one change: a file opened or saved, a file found missing, a save folder used. */
export function applyRecentsChange(
	current: RecentLists,
	change: { addFile?: string; removeFile?: string; addSaveDir?: string },
): RecentLists {
	let recentFiles = current.recentFiles;
	if (change.removeFile) recentFiles = recentFiles.filter((file) => file !== change.removeFile);
	if (change.addFile) recentFiles = addRecent(recentFiles, change.addFile, RECENT_FILES_CAP);
	const recentSaveDirs = change.addSaveDir
		? addRecent(current.recentSaveDirs, change.addSaveDir, RECENT_DIRS_CAP)
		: current.recentSaveDirs;
	return { recentFiles, recentSaveDirs };
}

/**
 * Settings saved before recent files kept only `lastOpenedFile`, which launch
 * reopened. Carry it into an empty recent list once, and drop the old key.
 */
export function migrateLastOpened(raw: Record<string, unknown>): Record<string, unknown> {
	const { lastOpenedFile, ...rest } = raw;
	const recent = Array.isArray(rest.recentFiles) ? rest.recentFiles : [];
	if (typeof lastOpenedFile === "string" && recent.length === 0) rest.recentFiles = [lastOpenedFile];
	return rest;
}

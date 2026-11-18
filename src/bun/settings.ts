import { join } from "path";
import { mkdirSync, existsSync, renameSync } from "fs";
import { Utils } from "electrobun/main";
import type { RecentsChange, Settings } from "../shared/rpc-types";
import { applyRecentsChange, migrateLastOpened } from "../shared/recent-list";

const SETTINGS_FILENAME = "settings.json";

const DEFAULT_SETTINGS: Settings = {
	fontSize: 12,
	theme: "light",
	recentSaveDirs: [],
	recentFiles: [],
};

function getSettingsPath(): string {
	const dir = Utils.paths.userData;
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return join(dir, SETTINGS_FILENAME);
}

export async function loadSettings(): Promise<Settings> {
	try {
		const path = getSettingsPath();
		const file = Bun.file(path);
		if (!(await file.exists())) return { ...DEFAULT_SETTINGS };
		return { ...DEFAULT_SETTINGS, ...migrateLastOpened(await file.json()) };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

// Write to a temporary file and rename it over the settings, so a read never
// sees a half-written file (which would parse as invalid and fall back to the
// defaults, losing every setting on the next write).
export async function saveSettings(settings: Settings): Promise<void> {
	const path = getSettingsPath();
	const temporary = `${path}.tmp`;
	await Bun.write(temporary, JSON.stringify(settings, null, "\t"));
	renameSync(temporary, path);
}

// The webview and the window-frame save both update settings; chaining the
// read-modify-writes stops one overwriting the other with a stale copy.
let pendingUpdate: Promise<unknown> = Promise.resolve();

export function updateSettings(partial: Partial<Settings>): Promise<Settings> {
	return updateSettingsWith(() => partial);
}

// The recent lists are updated here, inside the serialised read-modify-write,
// so the webview never sends a whole list it may hold a stale or empty copy of.
export function updateRecents(change: RecentsChange): Promise<Settings> {
	return updateSettingsWith((current) => applyRecentsChange(current, change));
}

function updateSettingsWith(change: (current: Settings) => Partial<Settings>): Promise<Settings> {
	const update = pendingUpdate.then(async () => {
		const current = await loadSettings();
		const updated: Settings = { ...current, ...change(current) };
		await saveSettings(updated);
		return updated;
	});
	pendingUpdate = update.catch(() => {});
	return update;
}

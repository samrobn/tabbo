import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { Utils } from "electrobun/bun";
import type { Settings } from "../shared/rpc-types";

const SETTINGS_FILENAME = "settings.json";

const DEFAULT_SETTINGS: Settings = {
	fontSize: 12,
	theme: "light",
	lastOpenedFile: null,
	recentSaveDirs: [],
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
		const raw = await file.json();
		return { ...DEFAULT_SETTINGS, ...raw };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: Settings): Promise<void> {
	await Bun.write(getSettingsPath(), JSON.stringify(settings, null, "\t"));
}

export async function updateSettings(
	partial: Partial<Settings>,
): Promise<Settings> {
	const current = await loadSettings();
	const updated: Settings = { ...current, ...partial };
	await saveSettings(updated);
	return updated;
}

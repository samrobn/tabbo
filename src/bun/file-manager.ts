import { join, basename } from "path";
import { mkdirSync, existsSync } from "fs";
import { deriveTabFilename, resolveSaveTarget } from "./filename-utils";
import { tmpdir } from "os";
import { Utils } from "electrobun/bun";
import type { FileInfo, SaveResult, PdfExportResult } from "../shared/rpc-types";
import { exportPdfToDir } from "./pdf-export";

function getProjectDir(): string {
	const dir = join(Utils.paths.documents, "Tabbo");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function getCapturesDir(): string {
	const dir = join(tmpdir(), "tabbo-captures");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export async function openTabFile(): Promise<FileInfo | null> {
	const paths = await Utils.openFileDialog({
		startingFolder: getProjectDir(),
		allowedFileTypes: "tab,txt",
		canChooseFiles: true,
		canChooseDirectory: false,
		allowsMultipleSelection: false,
	});

	if (!paths || paths.length === 0) return null;

	const filePath = paths[0];
	const content = await Bun.file(filePath).text();
	return {
		content,
		filename: basename(filePath),
		path: filePath,
	};
}

export async function saveTabFile(
	content: string,
	filename: string,
	currentPath: string | null,
	confirmOverwrite: boolean,
	targetDir: string | null = null,
): Promise<SaveResult> {
	const name = deriveTabFilename(filename);
	if (!name) return { ok: false, reason: "error", message: `Invalid filename: "${filename}"` };
	const target = resolveSaveTarget(name, currentPath, getProjectDir(), targetDir);
	if (target.isNew && !confirmOverwrite && existsSync(target.path)) {
		return { ok: false, reason: "needs-overwrite-confirm", path: target.path };
	}
	try {
		await Bun.write(target.path, content);
		return { ok: true, path: target.path };
	} catch (err) {
		return { ok: false, reason: "error", message: String(err) };
	}
}

export function fileExists(path: string): boolean {
	return existsSync(path);
}

/**
 * Resolve where a save would write, without writing - drives the "Save a copy"
 * confirm so the user sees the real destination. Mirrors saveTabFile's
 * resolution exactly (same deriveTabFilename + resolveSaveTarget), so the path
 * shown is the path used. Returns null when the filename is invalid.
 */
export function previewSaveTarget(
	filename: string,
	currentPath: string | null,
	targetDir: string | null = null,
): string | null {
	const name = deriveTabFilename(filename);
	if (!name) return null;
	return resolveSaveTarget(name, currentPath, getProjectDir(), targetDir).path;
}

export async function chooseFolder(): Promise<string | null> {
	const paths = await Utils.openFileDialog({
		startingFolder: getProjectDir(),
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});
	return paths && paths.length > 0 ? paths[0] : null;
}

export async function readTabFile(
	path: string,
): Promise<{ content: string; filename: string } | null> {
	try {
		const content = await Bun.file(path).text();
		return { content, filename: basename(path) };
	} catch {
		return null;
	}
}

/**
 * Run the full compile pipeline and write the resulting PDF to ~/Documents/Tabbo.
 * Delegates to `exportPdfToDir` in pdf-export.ts, which owns the pipeline and
 * filename-normalisation logic and is directly testable without the Electrobun runtime.
 */
export async function exportPdfFromContent(
	content: string,
	filename: string,
): Promise<PdfExportResult> {
	return exportPdfToDir(content, filename, getProjectDir());
}

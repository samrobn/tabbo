import { join, basename } from "path";
import { mkdirSync } from "fs";
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
): Promise<SaveResult> {
	const filePath = join(getProjectDir(), filename);
	await Bun.write(filePath, content);
	return { path: filePath };
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

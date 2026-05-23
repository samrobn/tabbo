import { join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { parseTabErrors } from "./error-parser";
import { getTabBinary, getFontsDir } from "./engine-worker";
import { derivePdfFilename } from "./filename-utils";
import type { CompilationError, PdfExportResult } from "../shared/rpc-types";

/** Internal result type — not exposed on the RPC boundary. */
interface PdfPipelineResult {
	success: boolean;
	/** Base64-encoded PDF bytes, or null when the pipeline failed before gs. */
	pdf: string | null;
	errors: CompilationError[];
}

const GS_TIMEOUT_MS = 3_000;
const TAB_TIMEOUT_MS = 5_000;

/**
 * Resolve a resource path, trying the built app location first, then dev fallback.
 * Duplicated here to keep pdf-export self-contained without coupling it to engine-worker
 * internals beyond the already-exported getTabBinary/getFontsDir.
 */
function resolveResource(builtRelative: string, devRelative: string): string {
	const builtPath = join(import.meta.dir, builtRelative);
	if (existsSync(builtPath)) return builtPath;

	const devPath = resolve(devRelative);
	if (existsSync(devPath)) return devPath;

	throw new Error(
		`Resource not found. Tried:\n  ${builtPath}\n  ${devPath}`,
	);
}

let _gsBinary: string | undefined;

function getGsBinary(): string {
	if (!_gsBinary) {
		try {
			_gsBinary = resolveResource("../resources/bin/gs", "gs/gs-minimal");
		} catch {
			// Fall back to system gs for dev when gs/gs-minimal hasn't been built.
			_gsBinary = "gs";
		}
	}
	return _gsBinary;
}

/**
 * Run the fork-based PS + Ghostscript pipeline.
 * Called only on explicit PDF export — not on every preview update.
 */
export async function compileToPdf(content: string): Promise<PdfPipelineResult> {
	const tempDir = join(tmpdir(), `tabbo-${crypto.randomUUID()}`);
	mkdirSync(tempDir, { recursive: true });

	const inputFile = join(tempDir, "input.tab");
	const outputPs = join(tempDir, "output.ps");
	const outputPdf = join(tempDir, "output.pdf");

	try {
		await Bun.write(inputFile, content);

		// Pass 1+2: tab binary produces PostScript.
		const tabProc = Bun.spawn(
			[getTabBinary(), "-no-includes", "-o", outputPs, inputFile],
			{
				env: { ...Bun.env, TABFONTS: getFontsDir() },
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const tabTimeout = setTimeout(() => tabProc.kill(), TAB_TIMEOUT_MS);
		const exitCode = await tabProc.exited;
		clearTimeout(tabTimeout);

		if (exitCode !== 0) {
			const stderr = await new Response(tabProc.stderr).text();
			return { success: false, pdf: null, errors: parseTabErrors(stderr) };
		}

		// PS → PDF via Ghostscript.
		const gsProc = Bun.spawn(
			[
				getGsBinary(),
				"-q",
				"-dNOPAUSE",
				"-dBATCH",
				"-dSAFER",
				"-sDEVICE=pdfwrite",
				`-sOutputFile=${outputPdf}`,
				outputPs,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const gsTimeout = setTimeout(() => gsProc.kill(), GS_TIMEOUT_MS);
		const gsExitCode = await gsProc.exited;
		clearTimeout(gsTimeout);

		if (gsExitCode !== 0) {
			return {
				success: true,
				pdf: null,
				errors: [
					{
						message:
							"PDF conversion failed (PostScript was generated successfully)",
					},
				],
			};
		}

		const pdfBuffer = await Bun.file(outputPdf).arrayBuffer();
		const pdfBase64 = Buffer.from(pdfBuffer).toString("base64");

		return { success: true, pdf: pdfBase64, errors: [] };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Compile `content` to PDF and write the result to `outputDir/<stem>.pdf`.
 *
 * This function is the testable core of the export pipeline; `file-manager.ts`
 * calls it with the app's `~/Documents/Tabbo` directory. Pass a temp directory
 * in tests to avoid the Electrobun runtime dependency on `Utils.paths.documents`.
 *
 * Filename rules (delegated to `derivePdfFilename`):
 * - Path components are stripped (path-traversal guard).
 * - Hidden files and empty stems are rejected.
 * - Any single extension is replaced with `.pdf`.
 *
 * `outputDir` is created if it does not exist.
 */
export async function exportPdfToDir(
	content: string,
	filename: string,
	outputDir: string,
): Promise<PdfExportResult> {
	const pdfFilename = derivePdfFilename(filename);
	if (!pdfFilename) {
		return { success: false, path: null, message: "Invalid filename" };
	}

	const result = await compileToPdf(content);

	if (!result.success) {
		const message =
			result.errors.length > 0
				? result.errors.map((e) => e.message).join("\n")
				: "Compilation failed";
		return { success: false, path: null, message };
	}

	if (!result.pdf) {
		// gs failed but tab succeeded — use the error message from the pipeline.
		const message =
			result.errors.length > 0
				? result.errors[0].message
				: "PDF conversion failed";
		return { success: false, path: null, message };
	}

	mkdirSync(outputDir, { recursive: true });
	const filePath = join(outputDir, pdfFilename);
	const pdfBuffer = Buffer.from(result.pdf, "base64");
	await Bun.write(filePath, pdfBuffer);
	return { success: true, path: filePath };
}

import type { RPCSchema } from "electrobun";

export interface CompilationError {
	line?: number;
	message: string;
}

// ---------------------------------------------------------------------------
// Layout schema (v1)
// Coordinate system: DVI integer units, top-left origin.
// ---------------------------------------------------------------------------

export interface FontDescriptor {
	font_id: number;
	family: string;
	/** "tab" for the lute tablature font, "text" for PostScript text fonts */
	type: "tab" | "text";
	/** Present only when type === "text" */
	size_pt?: number;
}

export type LayoutPrimitive =
	| {
			type: "glyph";
			font_id: number;
			char_code: number;
			x: number;
			y: number;
	  }
	| {
			type: "text_run";
			font_id: number;
			x: number;
			y: number;
			text: string;
	  }
	| {
			type: "rule";
			x: number;
			y: number;
			width: number;
			height: number;
	  }
	| {
			type: "tie";
			x: number;
			y: number;
			length: number;
			variant: "normal" | "reversed" | "half" | "half_reversed";
	  }
	| {
			// rtie: no variant field — the engine emits only x, y, length.
			type: "rtie";
			x: number;
			y: number;
			length: number;
	  }
	| {
			// slash: width = span across string courses, count = number of slash marks.
			type: "slash";
			x: number;
			y: number;
			width: number;
			count: number;
	  }
	| {
			// uline: variant distinguishes standard, reversed, and wide underlines.
			type: "uline";
			x: number;
			y: number;
			width: number;
			variant: "normal" | "reversed" | "wide";
	  }
	| {
			// slant: endpoints (x1,y1)→(x2,y2) with stroke weight.
			type: "slant";
			x1: number;
			y1: number;
			x2: number;
			y2: number;
			weight: "thin" | "medium" | "thick";
	  }
	| {
			// curve: vertical curve ornament, length in DVI units.
			type: "curve";
			x: number;
			y: number;
			length: number;
	  };

export interface LayoutSystem {
	system_num: number;
	primitives: LayoutPrimitive[];
}

export interface LayoutPage {
	page_num: number;
	systems: LayoutSystem[];
}

export interface LayoutResult {
	schema_version: number;
	page_width_dvi: number;
	page_height_dvi: number;
	left_margin_dvi: number;
	top_margin_dvi: number;
	// Emitted by the engine for future use; renderer does not yet consume it.
	// Right margin currently falls out implicitly as page_width - left - staff_len.
	staff_len_dvi: number;
	fonts: FontDescriptor[];
	pages: LayoutPage[];
	errors: CompilationError[];
}

/**
 * Response shape for the `getLayout` RPC request.
 *
 * Three cases:
 * - Success: layout populated, errors empty (or non-fatal warnings).
 * - Failure: layout null, errors non-empty.
 * - Superseded: the call was replaced by a newer getLayout before dispatch.
 *   Callers check `superseded === true` and discard the result without error.
 *   superseded responses carry an empty errors array and null layout.
 */
export type GetLayoutResponse =
	| { layout: LayoutResult; errors: CompilationError[]; superseded?: never }
	| { layout: null; errors: CompilationError[]; superseded?: never }
	| { layout: null; errors: []; superseded: true };

// ---------------------------------------------------------------------------

export interface FileInfo {
	content: string;
	filename: string;
	path: string;
}

export interface SaveResult {
	path: string;
}

/** Result type for operations that can fail with a user-visible message. */
export type PdfExportResult =
	| { success: true; path: string }
	| { success: false; path: null; message: string };

export interface Settings {
	fontSize: number;
	theme: "light" | "dark";
	lastOpenedFile: string | null;
}

export type MenuAction = "open" | "save" | "exportPdf" | "new" | "showHelp";

// ---------------------------------------------------------------------------
// Auto-update types
// ---------------------------------------------------------------------------

/**
 * Update information returned from a check-for-update call.
 * `changelog` is null when no update is available or the section was not found.
 */
export interface UpdateInfo {
	available: boolean;
	version: string | null;
	changelog: string | null;
}

/**
 * Discriminated union describing the current update lifecycle phase.
 *
 * Phase transitions (happy path):
 *   idle → checking → available → downloading → ready
 *
 * Error path:
 *   any phase → error
 *
 * After `ready`, the frontend calls `applyDownloadedUpdate` which quits and
 * relaunches. There is no cancel operation — once downloading starts, it runs
 * to completion or error.
 */
export type UpdateStatus =
	| { phase: "idle" }
	| { phase: "checking" }
	| { phase: "available"; version: string | null; changelog: string | null }
	/** `progress` is a 0-100 integer (Electrobun native unit) or null when unknown. Do not multiply by 100. */
	| { phase: "downloading"; progress: number | null }
	| { phase: "ready" }
	| { phase: "error"; message: string };

export type TabboRPC = {
	bun: RPCSchema<{
		requests: {
			getLayout: {
				params: { content: string };
				response: GetLayoutResponse;
			};
			/**
			 * Compile the source to PDF and write it to ~/Documents/Tabbo/<filename>.pdf.
			 * Returns a discriminated union: success carries the written path; failure
			 * carries a user-visible message (engine or gs error).
			 */
			compileToPdf: {
				params: { content: string; filename: string };
				response: PdfExportResult;
			};
			openFile: {
				params: Record<string, never>;
				response: FileInfo | null;
			};
			saveFile: {
				params: { content: string; filename: string };
				response: SaveResult;
			};
			getSettings: {
				params: Record<string, never>;
				response: Settings;
			};
			updateSettings: {
				params: Partial<Settings>;
				response: Settings;
			};
			/** Check for an available update. Returns version + changelog if found. */
			checkForUpdate: {
				params: Record<string, never>;
				response: UpdateInfo;
			};
			/**
			 * Begin downloading a previously detected update.
			 * Caller should already have received an `available` status via
			 * `updateStatusChanged` before calling this.
			 */
			startUpdateDownload: {
				params: Record<string, never>;
				response: Record<string, never>;
			};
			/**
			 * Quit and relaunch into the downloaded update.
			 * Only valid after a `ready` status has been received.
			 */
			applyDownloadedUpdate: {
				params: Record<string, never>;
				response: Record<string, never>;
			};
		};
		messages: {
			titleChanged: { title: string };
		};
	}>;
	webview: RPCSchema<{
		messages: {
			menuAction: { action: MenuAction };
			/** Bun pushes update lifecycle events to the webview as they occur. */
			updateStatusChanged: { status: UpdateStatus };
		};
	}>;
};

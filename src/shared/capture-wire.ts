/**
 * Wire types for the long-poll channel between the capture server (bun) and
 * the webview (useCaptureWorker). Both sides import from here to prevent drift.
 *
 * Transport: GET /poll + POST /result (dev-only, http://127.0.0.1:9876).
 *
 * Flow: webview opens GET /poll; bun responds with RenderJob JSON when a job
 * is ready, or IdleMessage after POLL_WAIT_TIMEOUT_MS with no job. Webview
 * posts the result to POST /result.
 */

import type { LayoutResult } from "./rpc-types";

// ---------------------------------------------------------------------------
// Bun → webview
// ---------------------------------------------------------------------------

/**
 * Bun sends this after compiling the fixture source. The webview receives
 * a fully-resolved LayoutResult and only needs to serialise the DOM — it
 * makes no Electrobun RPC calls of its own during a capture.
 */
export type RenderJob = {
	type: "render";
	jobId: string;
	/** Pre-compiled layout. Always present — bun compiles before dispatching. */
	layout: LayoutResult;
	/** Filename hint (e.g. "simple.tab"). Present when ?source= was given. */
	filename?: string;
};

/**
 * Sent by bun when the poll timeout expires with no job pending. The webview
 * should immediately open a new /poll request.
 */
export type IdleMessage = {
	type: "idle";
};

/**
 * Discriminated union of everything bun can return on GET /poll.
 * Bun-side helpers and the webview's poll handler both narrow on `type`.
 */
export type BunMessage = RenderJob | IdleMessage;

// ---------------------------------------------------------------------------
// Webview → bun
// ---------------------------------------------------------------------------

export type JobResult = {
	type: "result";
	jobId: string;
	pages: Array<{ svg: string; widthPx: number; heightPx: number }>;
};

export type JobError = {
	type: "error";
	jobId: string;
	error: string;
};

export type WebviewMessage = JobResult | JobError;

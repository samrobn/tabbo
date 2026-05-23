/**
 * Stringify a thrown value for logging or error responses.
 *
 * Most thrown values are `Error` instances and want `.message`. A few APIs
 * (notably Electrobun's `BrowserWindow.focus()`) `throw` a bare string,
 * which has no `.message`. Falling back to `String(err)` covers both, plus
 * any other accidentally-thrown primitive.
 */
export function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

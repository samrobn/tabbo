/** Path helpers for display in the webview. Pure, so bun tests cover them. */

export function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

/** The folder holding `path`: "/" for a file at the root, "" for a bare name. */
export function dirname(path: string): string {
	const slash = path.lastIndexOf("/");
	if (slash < 0) return "";
	return slash === 0 ? "/" : path.slice(0, slash);
}

// Display only: values used as paths stay in full.
// MINIMAL: any home-folder prefix except the Shared folder shows as ~, other
// users' homes included; an exact match needs bun to send os.homedir().
export function tildify(path: string): string {
	return path.replace(/^\/Users\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, "~");
}

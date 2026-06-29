/**
 * Most-recent-first folder history: prepend `dir`, drop any earlier occurrence,
 * cap the length. Pure and dependency-free so both bun and the webview import it.
 */
export function addRecentDir(list: string[], dir: string, cap = 5): string[] {
	return [dir, ...list.filter((existing) => existing !== dir)].slice(0, cap);
}

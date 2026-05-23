const TABBO_VITE_SIGNATURE = "import";
// `/main.ts` is the module entry under Vite's `root: src/mainview`; foreign servers won't serve it as ESM.
const TABBO_VITE_PROBE_PATH = "/main.ts";
const VITE_PROBE_TIMEOUT_MS = 3_000;

export const DEV_SERVER_PORT = 5173;
export const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

export type ViteProbeResult = "tabbo" | "foreign" | "absent";

export function looksLikeViteEntry(body: string): boolean {
	return body.trimStart().startsWith(TABBO_VITE_SIGNATURE);
}

export async function probeViteServer(
	fetchImpl: typeof fetch = fetch,
): Promise<ViteProbeResult> {
	let res: Response;
	try {
		res = await fetchImpl(`${DEV_SERVER_URL}${TABBO_VITE_PROBE_PATH}`, {
			signal: AbortSignal.timeout(VITE_PROBE_TIMEOUT_MS),
		});
	} catch {
		return "absent";
	}
	if (!res.ok) return "foreign";
	return looksLikeViteEntry(await res.text()) ? "tabbo" : "foreign";
}

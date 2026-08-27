import { ROUTE_PREFIX } from "../shared/api.js";
import { dirname, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
//#region src/host/mermaid-route.ts
/**
* Serves the taskboard's heavy Mermaid client chunk from the host half.
*
* The official plugin client endpoint serves only the core client registration
* file, so this fixed, allowlisted route provides the one optional chunk used
* by the detail Markdown renderer. It carries an ETag so refreshes revalidate
* without repeatedly downloading the multi-megabyte artifact.
*/
/** Fixed public path; no user-controlled file name is ever accepted. */
const MERMAID_BUNDLE_PATH = `${ROUTE_PREFIX}/bundle/mermaid.js`;
/** Host modules compile under lib/host; the chunk lives in the published lib/. */
const LIB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
let etagMemo;
async function etagOf(path) {
	try {
		const info = await stat(path);
		if (etagMemo !== void 0 && etagMemo.path === path && etagMemo.mtimeMs === info.mtimeMs && etagMemo.size === info.size) return etagMemo.value;
		const value = `"${createHash("sha1").update(await readFile(path)).digest("hex").slice(0, 12)}"`;
		etagMemo = {
			path,
			mtimeMs: info.mtimeMs,
			size: info.size,
			value
		};
		return value;
	} catch {
		return;
	}
}
/** Build a testable handler; production defaults to the published lib dir. */
function createMermaidBundleHandler(chunkDir = LIB_DIR) {
	return async (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { allow: "GET, HEAD" });
			res.end();
			return;
		}
		const path = join(chunkDir, "client-mermaid.js");
		const etag = await etagOf(path);
		if (etag === void 0) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, {
				"cache-control": "no-cache",
				etag
			});
			res.end();
			return;
		}
		try {
			const body = await readFile(path);
			res.writeHead(200, {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-cache",
				etag
			});
			if (req.method !== "HEAD") res.end(body);
			else res.end();
		} catch {
			res.writeHead(404);
			res.end("not found");
		}
	};
}
/** Register the fixed Mermaid chunk route with the current Cordis fiber. */
function registerMermaidBundleRoute(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: MERMAID_BUNDLE_PATH,
		handler: createMermaidBundleHandler()
	});
}
//#endregion
export { MERMAID_BUNDLE_PATH, createMermaidBundleHandler, registerMermaidBundleRoute };

//# sourceMappingURL=mermaid-route.js.map
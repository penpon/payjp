interface Env {
	BACKEND_ORIGIN: string;
}

const ALLOWED_PATH = "/v1/payjp/webhook";

/**
 * Parse `BACKEND_ORIGIN` / `CF_API_ORIGIN` as a bare https origin (scheme + host[:port] only).
 * Rejects path/query/fragment/credentials so a typo cannot turn the worker into a generic open proxy.
 */
function parseStrictHttpsOrigin(raw: string): string | null {
	const t = raw.trim();
	if (!t) return null;
	let u: URL;
	try {
		u = new URL(t);
	} catch {
		return null;
	}
	if (u.protocol !== "https:") return null;
	if (u.username !== "" || u.password !== "") return null;
	if (u.pathname !== "/" && u.pathname !== "") return null;
	if (u.search !== "" || u.hash !== "") return null;
	if (!u.hostname) return null;
	return u.origin;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== ALLOWED_PATH) {
			return new Response("Not Found", { status: 404 });
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const backendOrigin = parseStrictHttpsOrigin(env.BACKEND_ORIGIN ?? "");
		if (!backendOrigin) {
			return new Response("BACKEND_ORIGIN is not a valid https origin", { status: 502 });
		}

		const backendUrl = `${backendOrigin}${ALLOWED_PATH}`;

		const headers = new Headers(request.headers);
		headers.delete("host");

		const response = await fetch(backendUrl, {
			method: "POST",
			headers,
			body: request.body,
		});

		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	},
};

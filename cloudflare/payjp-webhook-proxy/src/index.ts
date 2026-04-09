interface Env {
	BACKEND_ORIGIN: string;
}

const ALLOWED_PATH = "/v1/payjp/webhook";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== ALLOWED_PATH) {
			return new Response("Not Found", { status: 404 });
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const backendUrl = `${env.BACKEND_ORIGIN}${ALLOWED_PATH}`;

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

/**
 * Uno Web IDE Worker.
 *
 * Two jobs:
 *   1. Serve the static frontend out of public/ (the ASSETS binding).
 *   2. Answer /api/* routes.
 *
 * T0 only stubs POST /api/compile with 501. T1 replaces the stub with a call
 * into the arduino-cli container. Keep this file small; a teacher maintains it.
 */

/** Every API response is JSON, so build them in one place. */
function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
	});
}

async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname === "/api/compile") {
		if (request.method !== "POST") {
			return json(405, { ok: false, error: "Use POST for /api/compile." }, { allow: "POST" });
		}
		// Not built yet. See T1 in PLAN.md.
		return json(501, {
			ok: false,
			error: "Compile service is not deployed yet.",
		});
	}

	if (url.pathname.startsWith("/api/")) {
		return json(404, { ok: false, error: "Unknown API route." });
	}

	// Anything that is not an API route is the static site.
	return env.ASSETS.fetch(request);
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handle(request, env);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "unhandled worker error",
					path: new URL(request.url).pathname,
					error: String(error),
				}),
			);
			return json(500, { ok: false, error: "Server error. Tell your teacher." });
		}
	},
} satisfies ExportedHandler<Env>;

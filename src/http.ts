/**
 * One place that builds a JSON response, because every API answer is one.
 *
 * Lives apart from worker.ts so src/compile-gate.ts can build its refusals
 * without importing the Worker (which would be a cycle, and which drags in the
 * container runtime that `node --test` cannot load).
 */
export function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
	});
}

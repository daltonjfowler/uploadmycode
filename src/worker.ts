/**
 * uploadmycode Worker.
 *
 * Two jobs:
 *   1. Serve the static frontend out of public/ (the ASSETS binding).
 *   2. Answer /api/* routes.
 *
 * Both go out through the same door in `fetch` below, which forces https and
 * stamps the security headers on whatever comes back. See src/headers.ts.
 *
 * POST /api/compile hands the sketch to the arduino-cli container and passes
 * its answer straight back, but only after the gate in src/compile-gate.ts:
 * size, the optional school IP lock, the class phrase, six compiles a minute
 * for this browser's client id, and the all-of-us bill guard. That file holds
 * the order and the reasons; this one holds the wiring.
 *
 * POST /api/format is the Auto indent button and goes through the very same
 * gate, spending a bucket of its own (twelve a minute) so that tidying a sketch
 * can never leave a student unable to compile it. The same container answers
 * both; it runs clang-format for this one.
 *
 * The rule behind both gates: nothing a stranger gets wrong is allowed to cost
 * anybody else anything. The school leaves Cloudflare through one address, so a
 * per-IP penalty is a whole-class outage. A wrong phrase is therefore a plain
 * 403 every time, and the only guard on the teacher key is failure-path only,
 * so a correct key always gets in. See src/teacher-guard.ts.
 *
 * Keep this file small; a teacher maintains it.
 */

import { Container, getContainer } from "@cloudflare/containers";

import {
	gateCompile,
	gateFormat,
	readActivePhrase,
	type CompileCounters,
} from "./compile-gate.ts";
import { constantTimeEquals } from "./constant-time.ts";
import { httpsRedirect, withSecurityHeaders } from "./headers.ts";
import { json } from "./http.ts";
import {
	clampTtlSeconds,
	isUsablePhrase,
	MAX_PHRASE_LENGTH,
	normalizePhrase,
	PHRASE_KEY,
	type PhraseRecord,
} from "./phrase.ts";
import {
	FORMAT_RATE_LIMIT_MAX,
	GLOBAL_COMPILE_KEY,
	GLOBAL_COMPILE_MAX_PER_MINUTE,
	RATE_LIMIT_WINDOW_MS,
	RateLimiter,
	type RateVerdict,
} from "./ratelimit.ts";
import { minutesPhrase, TeacherKeyGuard, type GuardVerdict } from "./teacher-guard.ts";

/**
 * Fixed pause before every teacher-key rejection. It costs a guesser a third of
 * a second an attempt and, with the constant-time compare, leaves nothing in
 * the response time to learn from.
 */
const TEACHER_REJECT_DELAY_MS = 300;
/** The teacher endpoint takes a two-field JSON object and nothing larger. */
const MAX_TEACHER_BYTES = 4 * 1024;

/**
 * The arduino-cli compile service. See container/Dockerfile and
 * container/server.js; the wiring lives in wrangler.jsonc.
 *
 * It also holds the three rate counters and the teacher-key guard.
 * max_instances is 1 and every request addresses the same named instance, so
 * this Durable Object is the one place that sees every compile, every format
 * and every wrong key, and can count them for the whole site rather than per
 * isolate.
 *
 * Reaching this object does NOT start the container: the Container constructor
 * only schedules its own alarms. So a refused compile, and every wrong teacher
 * key, cost a Durable Object call and no container compute.
 */
export class CompilerContainer extends Container {
	/** Matches EXPOSE / PORT in the Dockerfile. */
	override defaultPort = 8080;
	/**
	 * Idle shutdown. Long enough to stay warm across a class period's gaps,
	 * short enough that an idle evening bills nothing. Memory is billed while
	 * the instance is awake, so do not make this generous.
	 */
	override sleepAfter = "10m";

	/** Six a minute per client id. In memory, on purpose: see src/ratelimit.ts. */
	readonly #clients = new RateLimiter();
	/**
	 * Twelve a minute per client id, for Auto indent. A separate map, so no
	 * amount of tidying can eat the compiles a student still needs.
	 */
	readonly #formatters = new RateLimiter(FORMAT_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
	/** The bill guard, counted across everybody and across both jobs. */
	readonly #everyone = new RateLimiter(GLOBAL_COMPILE_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
	/** In memory, on purpose: see src/teacher-guard.ts. */
	readonly #teacherKeys = new TeacherKeyGuard();

	/**
	 * Count one compile attempt for one client. `key` is built by
	 * `rateLimitKey`, so it is either a validated client id or an IP fallback.
	 */
	checkClientRate(key: string): RateVerdict {
		return this.#clients.check(key, Date.now());
	}

	/**
	 * Count one format attempt for one client. `key` is built by
	 * `formatRateLimitKey`, so it carries the `fmt ` prefix as well as landing
	 * in a different map from the compiles.
	 */
	checkFormatRate(key: string): RateVerdict {
		return this.#formatters.check(key, Date.now());
	}

	/** Count one request — compile or format — against the site-wide ceiling. */
	checkGlobalRate(): RateVerdict {
		return this.#everyone.check(GLOBAL_COMPILE_KEY, Date.now());
	}

	/**
	 * One wrong teacher key, from anybody.
	 *
	 * Called only after the compare has already failed, which is what keeps this
	 * guard from ever refusing somebody who knows the key.
	 */
	recordWrongTeacherKey(): GuardVerdict {
		return this.#teacherKeys.recordFailure(Date.now());
	}

	override onError(error: unknown): Response {
		console.error(
			JSON.stringify({ message: "container error", error: String(error) }),
		);
		return json(503, {
			ok: false,
			error: "The compiler is busy or starting up. Wait a few seconds and try again.",
		});
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The one Durable Object: the compiler, and the counters that guard it.
 *
 * max_instances is 1 and every request names the same instance, so the rate
 * limiters and the teacher guard inside it count for the whole site.
 */
function compilerStub(env: Env): DurableObjectStub<CompilerContainer> {
	return getContainer(env.COMPILER, "compiler");
}

// ---------------------------------------------------------------- teacher key

async function teacherAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.TEACHER_KEY ?? "";
	// No secret uploaded means no teacher endpoint at all. Never fall open.
	if (expected === "") {
		console.error(JSON.stringify({ message: "TEACHER_KEY is not set; teacher endpoint refused" }));
		return false;
	}
	return await constantTimeEquals(request.headers.get("x-teacher-key") ?? "", expected);
}

/**
 * The door on every /api/teacher/* request. Returns the refusal to send, or
 * null when the key was right and the request may go on.
 *
 * The key is compared FIRST, before anything is counted or consulted, so a
 * correct key gets in no matter what anybody else has been doing. There is no
 * per-IP lockout: one bad actor on the school's single public address must
 * never be able to lock the teacher out of his own class, and the key is 192
 * bits of randomness, so guessing it is not the threat. Only a wrong key
 * touches the coarse guard, and only a wrong key can ever be refused by it.
 * See src/teacher-guard.ts.
 */
async function teacherGate(request: Request, env: Env): Promise<Response | null> {
	if (await teacherAuthorized(request, env)) return null;

	const guard = await compilerStub(env).recordWrongTeacherKey();
	await sleep(TEACHER_REJECT_DELAY_MS);
	if (guard.locked) {
		return json(
			429,
			{
				ok: false,
				error:
					"Too many wrong keys from everywhere right now. Try again in " +
					minutesPhrase(guard) +
					". The right key still works.",
			},
			{ "retry-after": String(guard.retryAfterSeconds) },
		);
	}
	return json(403, { ok: false, error: "Wrong teacher key." });
}

/** GET / POST / DELETE /api/teacher/phrase. The key is already checked. */
async function teacherPhrase(request: Request, env: Env): Promise<Response> {
	const method = request.method;
	if (method !== "GET" && method !== "POST" && method !== "DELETE") {
		return json(
			405,
			{ ok: false, error: "Use GET, POST or DELETE for /api/teacher/phrase." },
			{ allow: "GET, POST, DELETE" },
		);
	}

	if (method === "DELETE") {
		await env.CLASS_KV.delete(PHRASE_KEY);
		return json(200, { ok: true, phrase: null });
	}

	if (method === "GET") {
		const record = await readActivePhrase(env);
		return record === null
			? json(200, { ok: true, phrase: null })
			: json(200, { ok: true, phrase: record.phrase, expiresAt: record.expiresAt });
	}

	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_TEACHER_BYTES) {
		return json(413, { ok: false, error: "That request is too large." });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json(400, { ok: false, error: "Body must be JSON." });
	}

	const asked = body as { phrase?: unknown; ttlSeconds?: unknown };
	const phrase = normalizePhrase(asked.phrase);
	if (!isUsablePhrase(phrase)) {
		return json(400, {
			ok: false,
			error: "A phrase must be 1 to " + MAX_PHRASE_LENGTH + " characters once spaces are tidied.",
		});
	}

	const ttlSeconds = clampTtlSeconds(asked.ttlSeconds);
	const expiresAt = Date.now() + ttlSeconds * 1000;
	const record: PhraseRecord = { phrase, expiresAt };
	// expirationTtl is KV's own cleanup. expiresAt is what the Worker enforces.
	await env.CLASS_KV.put(PHRASE_KEY, JSON.stringify(record), { expirationTtl: ttlSeconds });

	return json(200, { ok: true, phrase, expiresAt });
}

// --------------------------------------------------- compiling and formatting

/**
 * Hand a body the gate has already cleared to one of the container's routes and
 * return its answer unchanged.
 *
 * The container's own JSON shapes ({ ok, hex } / { ok, stderr } for a compile,
 * { ok, code } / { ok, error } for a format) are the API, so this Worker still
 * never has to know what a sketch or an Intel HEX file is.
 */
async function forwardToContainer(
	container: DurableObjectStub<CompilerContainer>,
	path: "/compile" | "/format",
	body: ArrayBuffer,
): Promise<Response> {
	const proxied = new Request("http://compiler" + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});

	try {
		return await container.fetch(proxied);
	} catch (error) {
		// Container over capacity, still booting, or crashed. Students see one
		// clear sentence; the detail goes to the logs.
		console.error(
			JSON.stringify({ message: "compile container unreachable", path, error: String(error) }),
		);
		return json(503, {
			ok: false,
			error: "The compiler is busy or starting up. Wait a few seconds and try again.",
		});
	}
}

/**
 * POST /api/compile. src/compile-gate.ts has already read and size-checked the
 * body, so what it hands back is what gets forwarded.
 */
async function compile(request: Request, env: Env): Promise<Response> {
	const container = compilerStub(env);
	const counters: CompileCounters = {
		checkClientRate: async (key) => await container.checkClientRate(key),
		checkGlobalRate: async () => await container.checkGlobalRate(),
	};

	const verdict = await gateCompile(request, env, counters);
	if (!verdict.ok) return verdict.response;

	return await forwardToContainer(container, "/compile", verdict.body);
}

/**
 * POST /api/format — the Auto indent button. Same gate, same order, same
 * container; the only differences are which per-client counter is spent (the
 * format one, so tidying never costs a compile) and where it lands.
 */
async function format(request: Request, env: Env): Promise<Response> {
	const container = compilerStub(env);
	const counters: CompileCounters = {
		checkClientRate: async (key) => await container.checkFormatRate(key),
		checkGlobalRate: async () => await container.checkGlobalRate(),
	};

	const verdict = await gateFormat(request, env, counters);
	if (!verdict.ok) return verdict.response;

	return await forwardToContainer(container, "/format", verdict.body);
}

// -------------------------------------------------------------------- routing

async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname === "/api/compile") {
		if (request.method !== "POST") {
			return json(405, { ok: false, error: "Use POST for /api/compile." }, { allow: "POST" });
		}
		return await compile(request, env);
	}

	if (url.pathname === "/api/format") {
		if (request.method !== "POST") {
			return json(405, { ok: false, error: "Use POST for /api/format." }, { allow: "POST" });
		}
		return await format(request, env);
	}

	// Everything under /api/teacher/ needs the key, including paths that do not
	// exist: a stranger should not be able to map the endpoint by poking at it.
	if (url.pathname.startsWith("/api/teacher/")) {
		const refused = await teacherGate(request, env);
		if (refused !== null) return refused;

		if (url.pathname === "/api/teacher/phrase") {
			return await teacherPhrase(request, env);
		}
		return json(404, { ok: false, error: "Unknown API route." });
	}

	if (url.pathname.startsWith("/api/")) {
		return json(404, { ok: false, error: "Unknown API route." });
	}

	// Anything that is not an API route is the static site.
	return env.ASSETS.fetch(request);
}

export default {
	async fetch(request, env): Promise<Response> {
		// Before anything else, and before any secret is read: an http request is
		// answered with a redirect and nothing more. See src/headers.ts.
		const insecure = httpsRedirect(request.url);
		if (insecure !== null) return insecure;

		// /api/* is always JSON, so it always gets no-store. Everything else came
		// from the asset server and its content-type decides whether it gets the
		// Content-Security-Policy.
		const kind = new URL(request.url).pathname.startsWith("/api/") ? "json" : "asset";

		try {
			return withSecurityHeaders(await handle(request, env), kind);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "unhandled worker error",
					path: new URL(request.url).pathname,
					error: String(error),
				}),
			);
			return withSecurityHeaders(
				json(500, { ok: false, error: "Server error. Tell your teacher." }),
				"json",
			);
		}
	},
} satisfies ExportedHandler<Env>;

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
import { DurableObject } from "cloudflare:workers";

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
import { CompileQueue, CONTAINER_COUNT, isUsableToken } from "./queue.ts";
import {
	FORMAT_RATE_LIMIT_MAX,
	GLOBAL_COMPILE_KEY,
	GLOBAL_COMPILE_MAX_PER_MINUTE,
	GLOBAL_QUEUE_POLL_KEY,
	GLOBAL_QUEUE_POLL_MAX_PER_MINUTE,
	QUEUE_POLL_MAX,
	queuePollKey,
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
 * Container concerns ONLY. Nothing that a stranger can reach for free may be
 * added here. Two reasons, one evidenced, one hygiene. Evidenced: the
 * September 2026 bill (real awake GiB-hours) came from the STOP path.
 * server.js runs as PID 1 in the image, and Linux ignores an unhandled SIGTERM
 * for PID 1, so the platform's idle stop could not land. Post-fix, sleep is
 * proven by latency: a compile after a quiet gap cold-starts (~5.5 s), even
 * with junk requests ongoing. Do NOT trust wrangler's "instances" column for
 * awake state; it reports a provisioned slot. Cold-vs-warm latency and the
 * bill are the ground truth. The explicit
 * SIGTERM handler in container/server.js is that fix. Hygiene: the base class
 * renews the sleepAfter clock in its constructor and on every proxied request,
 * so counters must not share this object; a cold-start touch from junk traffic
 * background junk then held it awake for hours, billing provisioned memory the
 * whole time. They now live in `Counters` below, which has no container
 * attached and therefore no sleep clock to renew. Keep it that way.
 */
export class CompilerContainer extends Container {
	/** Matches EXPOSE / PORT in the Dockerfile. */
	override defaultPort = 8080;
	/**
	 * Idle shutdown. Long enough to stay warm across a class period's gaps,
	 * short enough that an idle evening bills nothing. Memory is billed while
	 * the instance is awake, so do not make this generous.
	 */
	override sleepAfter = "5m";

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

/**
 * Every counter on the site: the three rate limiters and the teacher-key guard.
 *
 * A plain Durable Object with NO container. Every request names the same
 * instance ("counters"), so these count for the whole site rather than per
 * Worker isolate — the same property the compile container used to provide,
 * without the side effect that made it expensive. Reaching this object costs a
 * Durable Object call and nothing else: no container is started, no memory is
 * provisioned, and the compiler's sleep clock is not touched. That last part is
 * the reason this class exists; see the note on CompilerContainer above.
 *
 * Nothing here is written to storage. If this object is evicted the counts
 * reset, which is the right trade for a fuse.
 */
export class Counters extends DurableObject<Env> {
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
	 * Sixty queue-position polls a minute per client, and a ceiling for
	 * everybody, both in their own maps. See src/ratelimit.ts for why polls are
	 * never counted against the compiles.
	 */
	readonly #pollers = new RateLimiter(QUEUE_POLL_MAX, RATE_LIMIT_WINDOW_MS);
	readonly #everyonePolling = new RateLimiter(
		GLOBAL_QUEUE_POLL_MAX_PER_MINUTE,
		RATE_LIMIT_WINDOW_MS,
	);
	/** Who is waiting for the compiler right now. See src/queue.ts. */
	readonly #queue = new CompileQueue();

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

	/** Count one queue-position poll for one client. */
	checkQueuePollRate(key: string): RateVerdict {
		return this.#pollers.check(key, Date.now());
	}

	/** Count one queue-position poll against the site-wide poll ceiling. */
	checkGlobalQueuePollRate(): RateVerdict {
		return this.#everyonePolling.check(GLOBAL_QUEUE_POLL_KEY, Date.now());
	}

	/**
	 * Join the compile queue. Returns the container to compile on (the
	 * least-loaded one) and how long the line now is, including this compile.
	 */
	enterCompileQueue(token: string): { container: number; depth: number } {
		return this.#queue.enter(token, Date.now());
	}

	/** Leave the compile queue. Always called, whatever the compile did. */
	leaveCompileQueue(token: string): void {
		this.#queue.leave(token);
	}

	/**
	 * How long the line is, and whether this compile is still standing in it.
	 * Not a personal place in the queue: see the note at the top of src/queue.ts
	 * for why that number could not be told truthfully.
	 */
	compileQueueStatus(token: string): { waiting: boolean; depth: number } {
		const now = Date.now();
		return { waiting: this.#queue.isWaiting(token, now), depth: this.#queue.depth(now) };
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
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The compile container. Only ever called where a request is actually being
 * forwarded to it, because reaching it renews its sleep timer: see the note on
 * CompilerContainer.
 */
function compilerStub(env: Env, index: number): DurableObjectStub<CompilerContainer> {
	// One name per container, `compiler-0` .. `compiler-(N-1)`. Cloudflare gives
	// each distinct name its own instance up to max_instances in wrangler.jsonc,
	// which must equal CONTAINER_COUNT. The old single "compiler" name is simply
	// no longer addressed; that instance sleeps and scales to zero on its own.
	return getContainer(env.COMPILER, `compiler-${index}`);
}

/**
 * A container to use when there is no line to balance against: a format (cheap,
 * and clang-format never waits behind a compile), or a compile with no usable
 * token. Random rather than always-zero so these still spread, and cheap so it
 * costs no Durable Object call.
 */
function randomContainer(): number {
	return Math.floor(Math.random() * CONTAINER_COUNT);
}

/**
 * The counters, all of them, in the one named instance every request shares.
 * Cheap to reach and safe to reach: no container hangs off this object.
 */
function countersStub(env: Env): DurableObjectStub<Counters> {
	return env.COUNTERS.get(env.COUNTERS.idFromName("counters"));
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

	const guard = await countersStub(env).recordWrongTeacherKey();
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
	const tally = countersStub(env);
	const counters: CompileCounters = {
		checkClientRate: async (key) => await tally.checkClientRate(key),
		checkGlobalRate: async () => await tally.checkGlobalRate(),
	};

	const verdict = await gateCompile(request, env, counters);
	if (!verdict.ok) return verdict.response;

	// The page mints a token per compile and polls /api/queue with it while it
	// waits. Tracking it is best-effort in both directions: a request without a
	// usable token compiles exactly as it always did, and a counters call that
	// fails must never cost somebody their compile.
	const token = request.headers.get("x-compile-token");
	const tracked = isUsableToken(token);
	// The queue also decides which of the containers this compile runs on, so a
	// tracked compile takes the container the line assigns it and everything else
	// falls back to a random one. If the counters call fails, the compile still
	// happens — on a random container rather than none.
	let container = randomContainer();
	if (tracked) {
		try {
			const assignment = await tally.enterCompileQueue(token);
			container = assignment.container;
			if (assignment.depth > 1) {
				console.log(
					JSON.stringify({ event: "compile-queued", inLine: assignment.depth, container }),
				);
			}
		} catch (error) {
			console.error(JSON.stringify({ message: "queue enter failed", error: String(error) }));
		}
	}

	try {
		// Only now is the container touched — and only now is its sleep timer renewed.
		return await forwardToContainer(compilerStub(env, container), "/compile", verdict.body);
	} finally {
		if (tracked) {
			// Leaving the line is the half that must not be skipped: a token left
			// behind would sit in front of every later student until it aged out.
			try {
				await tally.leaveCompileQueue(token);
			} catch (error) {
				console.error(JSON.stringify({ message: "queue leave failed", error: String(error) }));
			}
		}
	}
}

/**
 * GET /api/queue?token=… — "how long is the line I am standing in?"
 *
 * The one endpoint here that asks for no class phrase. Three reasons, in order
 * of how much they matter: it reads a number and changes nothing; requiring the
 * phrase would mean a KV read every three seconds for every waiting Chromebook,
 * which costs more than the thing being reported; and a student whose phrase has
 * just expired should still see why their compile is slow rather than a puzzle.
 * What it gives away is how busy one classroom's compiler is.
 *
 * It never touches the container, so polling cannot keep the compiler awake or
 * add a penny to the bill beyond the Durable Object call itself. Both fuses are
 * per client id and site-wide — NEVER per IP: the school leaves Cloudflare
 * through one address, so a per-IP limit here would be one student silencing
 * the whole room. See src/ratelimit.ts.
 */
async function queuePosition(request: Request, env: Env): Promise<Response> {
	const token = new URL(request.url).searchParams.get("token");
	if (!isUsableToken(token)) {
		return json(400, { ok: false, error: "Ask with a token from a compile." });
	}

	const tally = countersStub(env);
	const ip = request.headers.get("cf-connecting-ip") ?? "";

	const client = await tally.checkQueuePollRate(
		queuePollKey(request.headers.get("x-client-id"), ip),
	);
	const everyone = client.allowed ? await tally.checkGlobalQueuePollRate() : client;
	if (!client.allowed || !everyone.allowed) {
		const seconds = client.allowed ? everyone.retryAfterSeconds : client.retryAfterSeconds;
		// The page stops asking and keeps waiting quietly. Nothing a student does
		// with this endpoint can touch the compile that is already in the line.
		return json(
			429,
			{ ok: false, error: "Too many queue checks. The compile itself is unaffected." },
			{ "retry-after": String(seconds) },
		);
	}

	const status = await tally.compileQueueStatus(token);
	return json(200, { ok: true, waiting: status.waiting, depth: status.depth });
}

/**
 * POST /api/format — the Auto indent button. Same gate, same order, same
 * container; the only differences are which per-client counter is spent (the
 * format one, so tidying never costs a compile) and where it lands.
 */
async function format(request: Request, env: Env): Promise<Response> {
	const tally = countersStub(env);
	const counters: CompileCounters = {
		checkClientRate: async (key) => await tally.checkFormatRate(key),
		checkGlobalRate: async () => await tally.checkGlobalRate(),
	};

	const verdict = await gateFormat(request, env, counters);
	if (!verdict.ok) return verdict.response;

	// Same rule as a compile: the container is reached only once the gate is clear.
	return await forwardToContainer(compilerStub(env, randomContainer()), "/format", verdict.body);
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

	if (url.pathname === "/api/queue") {
		if (request.method !== "GET") {
			return json(405, { ok: false, error: "Use GET for /api/queue." }, { allow: "GET" });
		}
		return await queuePosition(request, env);
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

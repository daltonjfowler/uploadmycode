/**
 * uploadmycode Worker.
 *
 * Two jobs:
 *   1. Serve the static frontend out of public/ (the ASSETS binding).
 *   2. Answer /api/* routes.
 *
 * POST /api/compile hands the sketch to the arduino-cli container and passes
 * its answer straight back, but only after the T5 gate:
 *
 *   size    body over 100 KB is refused before anything else runs
 *   school  optional ALLOWED_CIDRS lock, off unless the var is set
 *   lockout is this address serving a wrong-phrase lockout right now
 *   phrase  the rolling class phrase from KV, compared in constant time
 *   rate    six compiles a minute per IP, counted in the container's DO
 *   compile
 *
 * The phrase check comes before the rate limit on purpose: a wrong phrase costs
 * one KV read and two hashes, and a class that is locked out should not also be
 * fighting a counter. The size check comes first because it is nearly free, and
 * the lockout check comes before the KV read so an address that is already
 * locked out costs nothing at all.
 *
 * /api/teacher/* is gated the same way with a tighter policy, and the key is
 * compared before the coarse all-IP guard so that a flood of wrong keys can
 * never lock Dalton out of his own class. src/lockout.ts explains why.
 *
 * Keep this file small; a teacher maintains it.
 */

import { Container, getContainer } from "@cloudflare/containers";

import { ipAllowed, parseCidrList, type Cidr } from "./cidr.ts";
import { constantTimeEquals } from "./constant-time.ts";
import {
	FailureLockout,
	minutesPhrase,
	type LockoutKind,
	type LockVerdict,
} from "./lockout.ts";
import {
	activeRecord,
	clampTtlSeconds,
	isUsablePhrase,
	MAX_PHRASE_LENGTH,
	normalizePhrase,
	PHRASE_KEY,
	type PhraseRecord,
} from "./phrase.ts";
import { RateLimiter, type RateVerdict } from "./ratelimit.ts";

/** Cost cap from PLAN.md. A request this big is not a sketch. */
const MAX_COMPILE_BYTES = 100 * 1024;
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
 * It also holds the compile rate limiter and the failure lockouts.
 * max_instances is 1 and every request addresses the same named instance, so
 * this Durable Object is the one place that sees every compile and every wrong
 * key, and can count them for the whole site rather than per isolate.
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

	/** In memory, on purpose: see src/ratelimit.ts. */
	readonly #limiter = new RateLimiter();
	/** In memory, on purpose: see src/lockout.ts. */
	readonly #lockout = new FailureLockout();

	/**
	 * Count one compile attempt for `ip`. The Worker calls this over RPC before
	 * it forwards anything, so a refused compile costs no compute.
	 */
	checkRateLimit(ip: string): RateVerdict {
		return this.#limiter.check(ip, Date.now());
	}

	/** Is `ip` locked out of guessing `kind` right now? Asked before any compare. */
	gate(kind: LockoutKind, ip: string): LockVerdict {
		return this.#lockout.check(kind, ip, Date.now());
	}

	/**
	 * One wrong key or phrase from `ip`.
	 *
	 * The verdict that comes back is the coarse all-IP teacher guard, which is
	 * the only guard allowed to answer the request it was armed by; the per-IP
	 * lock answers the next request through `gate`. src/lockout.ts says why.
	 */
	failed(kind: LockoutKind, ip: string): LockVerdict {
		return this.#lockout.recordFailure(kind, ip, Date.now());
	}

	/** A right one. `ip` starts clean for that kind. */
	succeeded(kind: LockoutKind, ip: string): void {
		this.#lockout.clear(kind, ip);
	}

	/**
	 * Everybody starts clean for that kind. Called when the teacher sets a new
	 * phrase; see FailureLockout.clearKind for why that has to unlock the room.
	 */
	forgetAll(kind: LockoutKind): void {
		this.#lockout.clearKind(kind);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------- failure lockouts

/**
 * The one Durable Object: the compiler, and the counters that guard it.
 *
 * max_instances is 1 and every request names the same instance, so the rate
 * limiter and the lockouts inside it count for the whole site.
 */
function compilerStub(env: Env): DurableObjectStub<CompilerContainer> {
	return getContainer(env.COMPILER, "compiler");
}

/**
 * The address the lockouts count against.
 *
 * `cf-connecting-ip` is written by Cloudflare and a client cannot forge it. It
 * is missing only in odd local cases, and those all share one bucket, which is
 * strict rather than loose.
 */
function lockoutIp(request: Request): string {
	const ip = request.headers.get("cf-connecting-ip") ?? "";
	return ip === "" ? "unknown" : ip;
}

/** A 429 that says how long the wait is, in a sentence and in a header. */
function lockedOut(verdict: LockVerdict, error: string, kind: LockoutKind): Response {
	return json(
		429,
		{ ok: false, error },
		{
			"retry-after": String(verdict.retryAfterSeconds),
			// Not part of the message: it is how the editor tells a phrase lockout
			// from the ordinary "six compiles a minute" 429, which is a different
			// problem with a different fix. See web/src/compile.ts.
			"x-lockout": kind,
		},
	);
}

// ------------------------------------------------------------- school IP lock

/**
 * ALLOWED_CIDRS parsed once per isolate.
 *
 * This caches configuration, not anything from a request, so it is safe at
 * module scope; it re-parses if the var ever changes under a live isolate.
 */
let cidrCache: { raw: string; cidrs: Cidr[] } | null = null;

function allowedCidrs(env: Env): Cidr[] {
	const raw = env.ALLOWED_CIDRS ?? "";
	if (cidrCache !== null && cidrCache.raw === raw) return cidrCache.cidrs;

	const { cidrs, invalid } = parseCidrList(raw);
	if (invalid.length > 0) {
		// Loud, because a typo here silently narrows who is allowed to compile.
		console.error(JSON.stringify({ message: "ALLOWED_CIDRS entries not understood", invalid }));
	}
	cidrCache = { raw, cidrs };
	return cidrs;
}

// --------------------------------------------------------------- class phrase

/**
 * The phrase that is valid right now, or null.
 *
 * A KV read can be served from a location cache for up to 60 seconds, so a key
 * KV has already expired can still come back. `activeRecord` re-checks
 * `expiresAt` against the clock, and that is what actually ends a phrase.
 */
async function readPhrase(env: Env): Promise<PhraseRecord | null> {
	let stored: unknown;
	try {
		stored = await env.CLASS_KV.get(PHRASE_KEY, "json");
	} catch (error) {
		// "json" throws if the stored value is not JSON. Only this Worker writes
		// that key, so it should not happen — but a whole class being told
		// "Server error" because one KV value is malformed is a bad trade for a
		// case the teacher fixes by setting the phrase again.
		console.error(JSON.stringify({ message: "phrase in KV is not readable", error: String(error) }));
		return null;
	}
	return activeRecord(stored, Date.now());
}

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
 * Order matters, and it is the whole point of this function:
 *
 *   1. Is this address locked out? Then 429, without comparing anything. A
 *      guesser who has already spent his five tries costs one Durable Object
 *      call and nothing else.
 *   2. Compare the key. A CORRECT key gets in here even while the coarse
 *      all-IP guard is armed — otherwise a hundred wrong keys from a botnet
 *      would lock Dalton out of his own class, for free, which is the outcome
 *      the attack is fishing for.
 *   3. Only on a wrong key: count it, wait the fixed 300 ms, and answer. If
 *      the coarse guard is armed, that answer is a 429 instead of a 403.
 *
 * The per-IP lock this failure may have just tripped is not reported here; it
 * shows up at step 1 on the next attempt. So the fifth wrong key looks exactly
 * like the first, and the sixth is the one that gets 429.
 */
async function teacherGate(request: Request, env: Env): Promise<Response | null> {
	const ip = lockoutIp(request);
	const guards = compilerStub(env);

	const locked = await guards.gate("teacher-key", ip);
	if (locked.locked) {
		return lockedOut(
			locked,
			"Too many wrong keys from this network. Try again in " + minutesPhrase(locked) + ".",
			"teacher-key",
		);
	}

	if (await teacherAuthorized(request, env)) {
		await guards.succeeded("teacher-key", ip);
		return null;
	}

	const everywhere = await guards.failed("teacher-key", ip);
	await sleep(TEACHER_REJECT_DELAY_MS);
	if (everywhere.locked) {
		return lockedOut(
			everywhere,
			"Too many wrong keys from everywhere right now. Try again in " +
				minutesPhrase(everywhere) +
				". The right key still works.",
			"teacher-key",
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
		const record = await readPhrase(env);
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

	// A new phrase forgives every wrong old one. A school shares one address, so
	// a phrase expiring mid-period can put the whole class into a wrong-phrase
	// lockout within seconds; the teacher setting the new phrase has to be the
	// thing that fixes it, not a ten-minute wait nobody can explain.
	await compilerStub(env).forgetAll("class-phrase");

	return json(200, { ok: true, phrase, expiresAt });
}

// ------------------------------------------------------------------ compiling

function tooLarge(): Response {
	return json(413, {
		ok: false,
		error: "That sketch is too big to compile. The limit is 100 KB.",
	});
}

/**
 * Forward a compile to the container and return its answer unchanged.
 *
 * The container's own JSON shape ({ ok, hex } / { ok, stderr }) is the API, so
 * this Worker still never has to know what a sketch or an Intel HEX file is.
 * The body is buffered rather than streamed only so its real size can be
 * measured: a chunked upload has no Content-Length to trust.
 */
async function compile(request: Request, env: Env): Promise<Response> {
	// 1. Size. A declared oversize is answered before a byte is read.
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_COMPILE_BYTES) return tooLarge();

	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_COMPILE_BYTES) return tooLarge();

	// 2. The optional in-person lock. An empty ALLOWED_CIDRS switches it off.
	const ip = request.headers.get("cf-connecting-ip") ?? "";
	const ranges = allowedCidrs(env);
	if (ranges.length > 0 && !ipAllowed(ip, ranges)) {
		return json(403, { ok: false, error: "uploadmycode only works from school." });
	}

	const container = compilerStub(env);
	const lockKey = lockoutIp(request);

	// 3. Wrong-phrase lockout, BEFORE the KV read, so an address that is already
	// locked out costs one Durable Object call and no KV operation at all.
	const locked = await container.gate("class-phrase", lockKey);
	if (locked.locked) {
		return lockedOut(
			locked,
			"Too many wrong phrases. Wait " +
				minutesPhrase(locked) +
				", then ask your teacher for today's phrase.",
			"class-phrase",
		);
	}

	// 4. The class phrase.
	//
	// A guess counts as a failure only when the student actually sent one. A
	// browser that has no phrase yet sends no header, and that is not an attack
	// — it is the first compile of the day, and it must never eat a strike.
	const supplied = normalizePhrase(request.headers.get("x-class-phrase"));
	const guessed = supplied !== "";
	const active = await readPhrase(env);
	if (active === null) {
		if (guessed) await container.failed("class-phrase", lockKey);
		return json(403, { ok: false, error: "No class phrase is active. Ask your teacher." });
	}
	if (!(await constantTimeEquals(supplied, active.phrase))) {
		if (guessed) await container.failed("class-phrase", lockKey);
		return json(403, {
			ok: false,
			error: "Wrong class phrase. Ask your teacher for today's phrase.",
		});
	}
	// Right phrase: this address starts clean again. A class that fumbled the
	// phrase all morning is not one typo away from a lockout all afternoon.
	await container.succeeded("class-phrase", lockKey);

	// 5. Rate limit.
	const verdict = await container.checkRateLimit(lockKey);
	if (!verdict.allowed) {
		return json(
			429,
			{
				ok: false,
				error:
					"That is a lot of compiles in one minute. Wait " +
					verdict.retryAfterSeconds +
					" seconds and click Compile again.",
			},
			{ "retry-after": String(verdict.retryAfterSeconds) },
		);
	}

	// 6. Compile.
	const proxied = new Request("http://compiler/compile", {
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
			JSON.stringify({ message: "compile container unreachable", error: String(error) }),
		);
		return json(503, {
			ok: false,
			error: "The compiler is busy or starting up. Wait a few seconds and try again.",
		});
	}
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

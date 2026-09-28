/**
 * Everything POST /api/compile and POST /api/format have to get past before the
 * container is touched.
 *
 * The order is the design, so it is written once, here, and worker.ts just runs
 * the answer:
 *
 *   1. size          over 100 KB is refused before anything else runs
 *   2. school        the optional ALLOWED_CIDRS lock, off unless the var is set
 *   3. per address   120 phrase-carrying requests a minute per public address
 *   3b. lockout      5 wrong phrases in a row locks this address 5 s, then
 *                    doubling to at most 300 s (src/lockout.ts)
 *   4. phrase        today's class phrase from KV, compared in constant time
 *   5. per client    six compiles, or twelve formats, a minute for this browser
 *   6. everybody     the bill guard: 120 requests a minute in total, both kinds
 *
 * Both endpoints run the exact same six checks in the exact same order. Only
 * two things differ, and they are the only two things `GateKind` decides: which
 * per-client bucket the attempt is counted into, and which sentence the 429
 * carries. The size and phrase answers are word for word identical, because a
 * student who typed the phrase wrong has the same problem whichever button they
 * pressed.
 *
 * Formatting counts into a bucket of its own so that tidying a sketch can never
 * spend the compiles a student still needs. It counts into the SAME global
 * ceiling, because that one is about the container's bill and the container
 * does both jobs.
 *
 * A wrong or missing phrase is a plain 403. It is never delayed and it never
 * spends anybody's compile budget. What stops a stranger guessing phrases all
 * day is check 3, the per-address brake: every request that carries a phrase,
 * right or wrong, counts once against its public address, and past 120 a
 * minute the address gets a 429 BEFORE the phrase is compared. Counting right
 * and wrong alike is the point: a guesser who is refused cannot tell a right
 * guess from a wrong one, so the refusal really does end the guessing.
 *
 * Why 120, and why that is safe for a school. The school leaves Cloudflare
 * through one public address, so anything that punishes "this IP" punishes the
 * whole class. The brake is therefore set to exactly the bill guard's number
 * (check 6), which already caps everybody together at 120 compiles and formats
 * a minute: a class can never be held to less by its own address than the site
 * already allows it. That is the rule for this brake, and the reason the
 * two numbers must be raised together. One honest gap: a request that the
 * per-client limit later refuses was still counted here, so one student
 * hammering Compile far past their own six a minute spends the address's 120
 * faster than the bill guard would. The editor sends one compile at a time, so
 * that takes a determined student, and it costs the room a minute, not the
 * day. A student with the phrase could already do the same to the bill guard
 * with invented client ids. What it buys: 120 guesses a minute
 * against about 750 million generated phrases (web/public/phrase-words.js), and
 * the phrase expires within hours. The brake is a Workers Rate Limiting binding
 * (PHRASE_LIMITER in wrangler.jsonc), counted per Cloudflare location, which is
 * the right shape for a brake and costs no Durable Object call.
 *
 * The per-client and global limiters still run AFTER the phrase check, so a
 * wrong phrase never reaches them and no amount of wrong guessing can spend
 * anyone's compile budget. Only a compile that was actually going to run is
 * counted there, whether it then succeeds or fails to compile.
 *
 * The counters live in the `Counters` Durable Object — deliberately not the
 * compile container's, whose sleep clock restarts on every touch — and are
 * passed in (`CompileCounters`) rather than reached for, so
 * `test/compile-gate.test.mjs` can run this whole ordering under `node --test`
 * with fakes.
 */

import { ipAllowed, parseCidrList, type Cidr } from "./cidr.ts";
import { constantTimeEquals } from "./constant-time.ts";
import { json } from "./http.ts";
import {
	cacheLockoutStore,
	clearLock,
	lockedResponse,
	readLock,
	recordWrong,
	type LockoutStore,
} from "./lockout.ts";
import { activeRecord, normalizePhrase, PHRASE_KEY, type PhraseRecord } from "./phrase.ts";
import { formatRateLimitKey, rateLimitKey, type RateVerdict } from "./ratelimit.ts";

/** Cost cap from PLAN.md. A request this big is not a sketch. */
export const MAX_COMPILE_BYTES = 100 * 1024;

/** Which of the two jobs is being asked for. */
export type GateKind = "compile" | "format";

/** The slice of the Worker env this needs. `Env` satisfies it. */
export interface CompileEnv {
	ALLOWED_CIDRS?: string;
	CLASS_KV: KVNamespace;
	/** The per-address brake, check 3. See wrangler.jsonc "ratelimits". */
	PHRASE_LIMITER: RateLimit;
}

/**
 * How long the per-address 429 tells the page to wait. The binding counts in
 * one-minute windows and does not say how much of this one is left, so the
 * honest answer is the whole window.
 */
const PHRASE_LIMIT_RETRY_SECONDS = 60;

/**
 * The two counters in the `Counters` Durable Object, as this module wants to
 * call them.
 *
 * `checkClientRate` is whichever per-client counter belongs to the job the
 * caller is gating — the compile one for /api/compile, the format one for
 * /api/format. worker.ts is where those are wired to the Durable Object, which
 * is what keeps this file free of any knowledge of it.
 */
export interface CompileCounters {
	/** This client's own budget for this kind of request. */
	checkClientRate(key: string): Promise<RateVerdict>;
	/** The bill guard, counted across everybody and across both kinds. */
	checkGlobalRate(): Promise<RateVerdict>;
}

/** The bucket name, and the sentence a 429 carries, for each kind. */
const KINDS: Record<
	GateKind,
	{
		key: (clientId: string | null, ip: string) => string;
		tooFast: (retryAfterSeconds: number) => string;
	}
> = {
	compile: {
		key: rateLimitKey,
		tooFast: (seconds) =>
			"That is a lot of compiles in one minute. Wait " + seconds + " seconds and click Compile again.",
	},
	format: {
		key: formatRateLimitKey,
		// No countdown in this one on purpose: twelve a minute is a lot of tidying,
		// the wait is short, and "wait a moment" is the honest instruction.
		tooFast: () => "That is a lot of tidying in one minute. Wait a moment and try again.",
	},
};

export type GateVerdict =
	/** Cleared. `body` is the sketch request, already read, ready to forward. */
	| { ok: true; body: ArrayBuffer }
	/** Refused. Send this and touch nothing else. */
	| { ok: false; response: Response };

/**
 * ALLOWED_CIDRS parsed once per isolate.
 *
 * This caches configuration, not anything from a request, so it is safe at
 * module scope; it re-parses if the var ever changes under a live isolate.
 */
let cidrCache: { raw: string; cidrs: Cidr[] } | null = null;

function allowedCidrs(env: CompileEnv): Cidr[] {
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

/**
 * The phrase that is valid right now, or null. Exported because the teacher's
 * GET has to read the same value the same careful way.
 *
 * A KV read can be served from a location cache for up to 60 seconds, so a key
 * KV has already expired can still come back. `activeRecord` re-checks
 * `expiresAt` against the clock, and that is what actually ends a phrase.
 */
export async function readActivePhrase(env: CompileEnv): Promise<PhraseRecord | null> {
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

function refuse(response: Response): GateVerdict {
	return { ok: false, response };
}

function tooLarge(): GateVerdict {
	return refuse(
		json(413, { ok: false, error: "That sketch is too big to compile. The limit is 100 KB." }),
	);
}

/**
 * The request body, or null the moment it passes `max` bytes.
 *
 * Not `request.arrayBuffer()`: that reads everything before anyone can count
 * it, so a chunked upload with no Content-Length could make the Worker hold as
 * much as the sender cares to send. Here the rest is cancelled, unread, as
 * soon as the running total goes over.
 */
async function readCapped(request: Request, max: number): Promise<ArrayBuffer | null> {
	if (request.body === null) return new ArrayBuffer(0);

	const reader = request.body.getReader();
	const pieces: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const piece: Uint8Array = value;
		total += piece.byteLength;
		if (total > max) {
			// Nothing is waiting on the rest of the upload; a cancel that fails
			// changes nothing about the answer.
			await reader.cancel().catch(() => undefined);
			return null;
		}
		pieces.push(piece);
	}

	const joined = new Uint8Array(total);
	let at = 0;
	for (const piece of pieces) {
		joined.set(piece, at);
		at += piece.byteLength;
	}
	return joined.buffer;
}

/**
 * Count one phrase-carrying request against its public address and say whether
 * it may go on. See check 3 in the notes at the top.
 *
 * If the binding itself fails, the request goes on. That is the same choice
 * the rest of this file makes: a fault in a fuse must never refuse a class that
 * typed the phrase right. It is logged, loudly, because while it lasts the
 * phrase is unbraked.
 */
async function addressMayTry(env: CompileEnv, ip: string): Promise<boolean> {
	try {
		const outcome = await env.PHRASE_LIMITER.limit({ key: ip === "" ? "unknown" : ip });
		return outcome.success;
	} catch (error) {
		console.error(JSON.stringify({ message: "phrase limiter failed; not braking", error: String(error) }));
		return true;
	}
}

/** POST /api/compile: the six checks, with the compile bucket and wording. */
export async function gateCompile(
	request: Request,
	env: CompileEnv,
	counters: CompileCounters,
	lockout: LockoutStore = cacheLockoutStore(),
): Promise<GateVerdict> {
	return await gate(request, env, counters, "compile", lockout);
}

/** POST /api/format: the same six checks, with the format bucket and wording. */
export async function gateFormat(
	request: Request,
	env: CompileEnv,
	counters: CompileCounters,
	lockout: LockoutStore = cacheLockoutStore(),
): Promise<GateVerdict> {
	return await gate(request, env, counters, "format", lockout);
}

async function gate(
	request: Request,
	env: CompileEnv,
	counters: CompileCounters,
	kind: GateKind,
	lockout: LockoutStore,
): Promise<GateVerdict> {
	// 1. Size. A declared oversize is answered before a byte is read; a chunked
	// upload declares nothing, so the body is read a piece at a time and the
	// reading stops the moment it passes the cap.
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_COMPILE_BYTES) return tooLarge();

	const body = await readCapped(request, MAX_COMPILE_BYTES);
	if (body === null) return tooLarge();

	// 2. The optional in-person lock. An empty ALLOWED_CIDRS switches it off.
	const ip = request.headers.get("cf-connecting-ip") ?? "";
	const ranges = allowedCidrs(env);
	if (ranges.length > 0 && !ipAllowed(ip, ranges)) {
		return refuse(json(403, { ok: false, error: "uploadmycode only works from school." }));
	}

	// 3. The per-address brake, BEFORE the phrase is compared, counting right
	// and wrong alike. A request with no phrase at all is not a guess and is
	// refused at step 4 without being counted.
	const supplied = normalizePhrase(request.headers.get("x-class-phrase"));
	if (supplied !== "" && !(await addressMayTry(env, ip))) {
		return refuse(
			json(
				429,
				{
					ok: false,
					error: "That is a lot of tries from your network in one minute. Wait a minute and try again.",
				},
				{ "retry-after": String(PHRASE_LIMIT_RETRY_SECONDS) },
			),
		);
	}

	// 3b. The growing lockout, still BEFORE the compare: a locked address is
	// refused without its phrase ever being looked at. Only a request that
	// carries a phrase is a guess, so only those are checked or counted.
	const now = Date.now();
	const lock = supplied === "" ? null : await readLock(lockout, "phrase", ip, now);
	if (lock !== null && lock.retryAfterSeconds > 0) {
		return refuse(lockedResponse(lock.retryAfterSeconds));
	}

	// 4. The class phrase. Wrong is 403, immediately, and spends no budget.
	const active = await readActivePhrase(env);
	if (active === null) {
		return refuse(json(403, { ok: false, error: "No class phrase is active. Ask your teacher." }));
	}
	if (!(await constantTimeEquals(supplied, active.phrase))) {
		if (lock !== null) await recordWrong(lockout, "phrase", ip, lock, now);
		return refuse(
			json(403, { ok: false, error: "Wrong class phrase. Ask your teacher for today's phrase." }),
		);
	}

	if (lock !== null) await clearLock(lockout, "phrase", ip, lock);

	// 5. This browser's own budget for this kind of request — six compiles a
	// minute, or twelve formats. Only requests that got past the phrase are
	// counted, so a class fumbling the phrase never spends its own budget.
	const client = await counters.checkClientRate(
		KINDS[kind].key(request.headers.get("x-client-id"), ip),
	);
	if (!client.allowed) {
		return refuse(
			json(
				429,
				{ ok: false, error: KINDS[kind].tooFast(client.retryAfterSeconds) },
				{ "retry-after": String(client.retryAfterSeconds) },
			),
		);
	}

	// 6. The bill guard. Last, so a client already over its own limit does not
	// spend the shared budget on the way to being refused anyway.
	const everyone = await counters.checkGlobalRate();
	if (!everyone.allowed) {
		return refuse(
			json(
				429,
				{ ok: false, error: "The compiler is very busy right now. Wait a minute and try again." },
				{ "retry-after": String(everyone.retryAfterSeconds) },
			),
		);
	}

	return { ok: true, body };
}

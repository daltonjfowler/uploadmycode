/**
 * Everything POST /api/compile has to get past before the container is touched.
 *
 * The order is the design, so it is written once, here, and worker.ts just runs
 * the answer:
 *
 *   1. size          over 100 KB is refused before anything else runs
 *   2. school        the optional ALLOWED_CIDRS lock, off unless the var is set
 *   3. phrase        today's class phrase from KV, compared in constant time
 *   4. per client    six compiles a minute for this browser's client id
 *   5. everybody     the bill guard: 120 compile requests a minute in total
 *
 * A wrong or missing phrase is a plain 403, every time. It is never counted,
 * never delayed, and never locks anybody out. That is deliberate: the school
 * leaves Cloudflare through one public address, so anything that punishes "this
 * IP" punishes the whole class, and one student could take the room offline
 * with a few clicks. A wrong phrase costs one cached KV read and two hashes,
 * the phrase expires within hours, and the container never starts — so there is
 * nothing here worth buying with a shared-fate outage.
 *
 * The limiters run AFTER the phrase check, which is what makes that safe: a
 * wrong phrase never reaches a counter, so no amount of wrong guessing can
 * spend anyone's compile budget. Only a compile that was actually going to run
 * is counted, whether it then succeeds or fails to compile.
 *
 * The counters live in the compile container's Durable Object and are passed in
 * (`CompileCounters`) rather than reached for, so `test/compile-gate.test.mjs`
 * can run this whole ordering under `node --test` with fakes.
 */

import { ipAllowed, parseCidrList, type Cidr } from "./cidr.ts";
import { constantTimeEquals } from "./constant-time.ts";
import { json } from "./http.ts";
import { activeRecord, normalizePhrase, PHRASE_KEY, type PhraseRecord } from "./phrase.ts";
import { rateLimitKey, type RateVerdict } from "./ratelimit.ts";

/** Cost cap from PLAN.md. A request this big is not a sketch. */
export const MAX_COMPILE_BYTES = 100 * 1024;

/** The slice of the Worker env this needs. `Env` satisfies it. */
export interface CompileEnv {
	ALLOWED_CIDRS?: string;
	CLASS_KV: KVNamespace;
}

/** The two counters in the Durable Object, as this module wants to call them. */
export interface CompileCounters {
	/** Six a minute for one client id (or one address, when there is no id). */
	checkClientRate(key: string): Promise<RateVerdict>;
	/** The bill guard, counted across everybody. */
	checkGlobalRate(): Promise<RateVerdict>;
}

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

export async function gateCompile(
	request: Request,
	env: CompileEnv,
	counters: CompileCounters,
): Promise<GateVerdict> {
	// 1. Size. A declared oversize is answered before a byte is read; the real
	// byte count is checked after, because a chunked upload declares nothing.
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_COMPILE_BYTES) return tooLarge();

	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_COMPILE_BYTES) return tooLarge();

	// 2. The optional in-person lock. An empty ALLOWED_CIDRS switches it off.
	const ip = request.headers.get("cf-connecting-ip") ?? "";
	const ranges = allowedCidrs(env);
	if (ranges.length > 0 && !ipAllowed(ip, ranges)) {
		return refuse(json(403, { ok: false, error: "uploadmycode only works from school." }));
	}

	// 3. The class phrase. Wrong is 403, always, immediately, uncounted.
	const supplied = normalizePhrase(request.headers.get("x-class-phrase"));
	const active = await readActivePhrase(env);
	if (active === null) {
		return refuse(json(403, { ok: false, error: "No class phrase is active. Ask your teacher." }));
	}
	if (!(await constantTimeEquals(supplied, active.phrase))) {
		return refuse(
			json(403, { ok: false, error: "Wrong class phrase. Ask your teacher for today's phrase." }),
		);
	}

	// 4. This browser's own six a minute. Only compiles that got past the phrase
	// are counted, so a class fumbling the phrase never spends its own budget.
	const client = await counters.checkClientRate(
		rateLimitKey(request.headers.get("x-client-id"), ip),
	);
	if (!client.allowed) {
		return refuse(
			json(
				429,
				{
					ok: false,
					error:
						"That is a lot of compiles in one minute. Wait " +
						client.retryAfterSeconds +
						" seconds and click Compile again.",
				},
				{ "retry-after": String(client.retryAfterSeconds) },
			),
		);
	}

	// 5. The bill guard. Last, so a client already over its own limit does not
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

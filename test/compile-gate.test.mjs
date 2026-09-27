/**
 * The order of the checks on POST /api/compile.
 *
 * This is where the shared-school-IP promise is actually kept, so it is tested
 * as an order and not just as a set of numbers: a wrong phrase must be a plain
 * 403 that never reaches a counter, and only a compile that was really going to
 * run may spend anybody's budget.
 *
 * Run with `npm test`. Node runs src/compile-gate.ts directly (it strips the
 * types). The two counters are injected, so the whole gate runs here with no
 * Durable Object, no container and no KV.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { gateCompile, gateFormat, MAX_COMPILE_BYTES } from "../src/compile-gate.ts";
import { GLOBAL_COMPILE_MAX_PER_MINUTE, rateLimitKey } from "../src/ratelimit.ts";

// `crypto.subtle.timingSafeEqual` is a Cloudflare extension to SubtleCrypto and
// Node does not have it. The gate uses it only to compare the phrase, and what
// is under test here is the ORDER of the checks, so a plain byte compare of the
// two SHA-256 digests stands in for it.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
	crypto.subtle.timingSafeEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

const PHRASE = "red-robot-maple";
const SCHOOL_IP = "203.0.113.5";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const SKETCH = JSON.stringify({ code: "void setup() {}" });

/** A KV that holds one phrase and counts how often it was read. */
function fakeKv(phrase) {
	const kv = {
		reads: 0,
		async get() {
			kv.reads += 1;
			return phrase === null ? null : { phrase, expiresAt: Date.now() + 60_000 };
		},
	};
	return kv;
}

/**
 * The per-address brake: a stand-in for the Workers Rate Limiting binding that
 * remembers every key it was asked about and says yes to the first `allow`.
 */
function fakeLimiter(allow = Number.POSITIVE_INFINITY) {
	const limiter = {
		keys: [],
		async limit({ key }) {
			limiter.keys.push(key);
			return { success: limiter.keys.length <= allow };
		},
	};
	return limiter;
}

function envWith(phrase, allowedCidrs = "", limiter = fakeLimiter()) {
	return { ALLOWED_CIDRS: allowedCidrs, CLASS_KV: fakeKv(phrase), PHRASE_LIMITER: limiter };
}

/**
 * Counters that remember every call, so the gate's order can be asserted rather
 * than assumed. `client` / `global` say whether each one allows the attempt.
 */
function spyCounters({ client = true, global = true } = {}) {
	const calls = { client: [], global: 0 };
	return {
		calls,
		async checkClientRate(key) {
			calls.client.push(key);
			return client
				? { allowed: true, retryAfterSeconds: 0 }
				: { allowed: false, retryAfterSeconds: 42 };
		},
		async checkGlobalRate() {
			calls.global += 1;
			return global
				? { allowed: true, retryAfterSeconds: 0 }
				: { allowed: false, retryAfterSeconds: 17 };
		},
	};
}

function compileRequest(headers = {}, body = SKETCH) {
	return new Request("https://uploadmycode.com/api/compile", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": SCHOOL_IP,
			...headers,
		},
		body,
	});
}

/** The headers a student's editor sends when everything is right. */
function goodHeaders(extra = {}) {
	return { "x-class-phrase": PHRASE, "x-client-id": CLIENT_ID, ...extra };
}

async function errorOf(response) {
	const body = await response.json();
	return body.error;
}

// ------------------------------------------------------------- the happy path

test("the right phrase gets through and is counted once in each place", async () => {
	const counters = spyCounters();
	const verdict = await gateCompile(compileRequest(goodHeaders()), envWith(PHRASE), counters);

	assert.equal(verdict.ok, true);
	assert.deepEqual(counters.calls.client, ["client " + CLIENT_ID]);
	assert.equal(counters.calls.global, 1);
	// The body comes back already read, so the Worker forwards it without
	// reading the request twice.
	assert.equal(new TextDecoder().decode(verdict.body), SKETCH);
});

test("the phrase is tidied on the way in, the way the teacher page promises", async () => {
	const counters = spyCounters();
	const verdict = await gateCompile(
		compileRequest(goodHeaders({ "x-class-phrase": "  RED-Robot-Maple  " })),
		envWith(PHRASE),
		counters,
	);
	assert.equal(verdict.ok, true);
});

// ----------------------------------------------- a wrong phrase costs nobody

test("a wrong phrase is a plain 403 and never reaches a counter", async () => {
	const counters = spyCounters();
	const env = envWith(PHRASE);

	// Twenty wrong phrases from the one address the whole school shares.
	for (let i = 0; i < 20; i++) {
		const verdict = await gateCompile(
			compileRequest(goodHeaders({ "x-class-phrase": "wrong-" + i })),
			env,
			counters,
		);
		assert.equal(verdict.ok, false, "attempt " + (i + 1));
		assert.equal(verdict.response.status, 403, "always 403, never 429");
		assert.equal(
			await errorOf(verdict.response),
			"Wrong class phrase. Ask your teacher for today's phrase.",
			"the same sentence every time, with no wait in it",
		);
		assert.equal(verdict.response.headers.get("retry-after"), null);
		assert.equal(verdict.response.headers.get("x-lockout"), null, "that header is gone");
	}

	assert.deepEqual(counters.calls.client, [], "not one wrong phrase spent a compile");
	assert.equal(counters.calls.global, 0, "and none of them touched the bill guard");

	// And the twenty-first attempt, with the right phrase, compiles at once.
	const good = await gateCompile(compileRequest(goodHeaders()), env, counters);
	assert.equal(good.ok, true, "no lockout was ever armed");
});

test("a missing phrase is the same plain 403, also uncounted", async () => {
	const counters = spyCounters();
	const verdict = await gateCompile(compileRequest(), envWith(PHRASE), counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 403);
	assert.deepEqual(counters.calls.client, []);
	assert.equal(counters.calls.global, 0);
});

test("no phrase set at all is a 403 that says so, and is uncounted", async () => {
	const counters = spyCounters();
	const verdict = await gateCompile(compileRequest(goodHeaders()), envWith(null), counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 403);
	assert.equal(await errorOf(verdict.response), "No class phrase is active. Ask your teacher.");
	assert.deepEqual(counters.calls.client, []);
	assert.equal(counters.calls.global, 0);
});

// ------------------------------------------------------------ the two limits

test("the client id picks the bucket, and a missing one falls back to the address", async () => {
	const withId = spyCounters();
	await gateCompile(compileRequest(goodHeaders()), envWith(PHRASE), withId);
	assert.deepEqual(withId.calls.client, ["client " + CLIENT_ID]);

	const noId = spyCounters();
	await gateCompile(
		compileRequest({ "x-class-phrase": PHRASE }),
		envWith(PHRASE),
		noId,
	);
	assert.deepEqual(noId.calls.client, ["anon " + SCHOOL_IP]);

	const junkId = spyCounters();
	await gateCompile(
		compileRequest(goodHeaders({ "x-client-id": "not a valid id" })),
		envWith(PHRASE),
		junkId,
	);
	assert.deepEqual(junkId.calls.client, ["anon " + SCHOOL_IP], "malformed is the same as missing");
	assert.deepEqual(junkId.calls.client, noId.calls.client);
	assert.equal(rateLimitKey(null, SCHOOL_IP), "anon " + SCHOOL_IP);
});

test("the per-client 429 keeps its friendly wording and its Retry-After", async () => {
	const counters = spyCounters({ client: false });
	const verdict = await gateCompile(compileRequest(goodHeaders()), envWith(PHRASE), counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 429);
	assert.equal(
		await errorOf(verdict.response),
		"That is a lot of compiles in one minute. Wait 42 seconds and click Compile again.",
	);
	assert.equal(verdict.response.headers.get("retry-after"), "42");
});

test("a client over its own limit does not spend the shared budget", async () => {
	const counters = spyCounters({ client: false });
	await gateCompile(compileRequest(goodHeaders()), envWith(PHRASE), counters);
	assert.equal(counters.calls.global, 0, "the ceiling is checked last, on purpose");
});

test("the ceiling answers 429 with its own sentence", async () => {
	const counters = spyCounters({ global: false });
	const verdict = await gateCompile(compileRequest(goodHeaders()), envWith(PHRASE), counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 429);
	assert.equal(
		await errorOf(verdict.response),
		"The compiler is very busy right now. Wait a minute and try again.",
	);
	assert.equal(verdict.response.headers.get("retry-after"), "17");
	assert.equal(counters.calls.client.length, 1, "the client check ran first");
});

// ----------------------------------------------- what comes before the phrase

test("an oversize sketch is 413 before the phrase is even read", async () => {
	const counters = spyCounters();
	const env = envWith(PHRASE);
	const big = "x".repeat(MAX_COMPILE_BYTES + 1);

	const verdict = await gateCompile(compileRequest(goodHeaders(), big), env, counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 413);
	assert.equal(env.CLASS_KV.reads, 0, "no KV read");
	assert.deepEqual(counters.calls.client, []);
});

test("the school IP lock refuses before the phrase is read", async () => {
	const counters = spyCounters();
	const env = envWith(PHRASE, "198.51.100.0/24");

	const verdict = await gateCompile(compileRequest(goodHeaders()), env, counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 403);
	assert.equal(await errorOf(verdict.response), "uploadmycode only works from school.");
	assert.equal(env.CLASS_KV.reads, 0, "no KV read");
	assert.deepEqual(counters.calls.client, []);

	// An address inside the range goes through as normal.
	const inside = await gateCompile(
		compileRequest(goodHeaders({ "cf-connecting-ip": "198.51.100.7" })),
		envWith(PHRASE, "198.51.100.0/24"),
		spyCounters(),
	);
	assert.equal(inside.ok, true);
});

// ------------------------------------------------- the per-address brake

const BRAKE_SENTENCE =
	"That is a lot of tries from your network in one minute. Wait a minute and try again.";

test("every request carrying a phrase is counted against its address before the phrase is read", async () => {
	const limiter = fakeLimiter();
	const env = envWith(PHRASE, "", limiter);

	await gateCompile(compileRequest(goodHeaders()), env, spyCounters());
	await gateCompile(compileRequest(goodHeaders({ "x-class-phrase": "a wrong guess" })), env, spyCounters());
	await gateFormat(compileRequest(goodHeaders()), env, spyCounters());

	assert.deepEqual(limiter.keys, [SCHOOL_IP, SCHOOL_IP, SCHOOL_IP], "right, wrong and format alike");
});

test("over the brake is a 429 before KV or any counter is touched", async () => {
	const counters = spyCounters();
	const env = envWith(PHRASE, "", fakeLimiter(0));

	const verdict = await gateCompile(compileRequest(goodHeaders({ "x-class-phrase": "a guess" })), env, counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 429);
	assert.equal(await errorOf(verdict.response), BRAKE_SENTENCE);
	assert.equal(verdict.response.headers.get("retry-after"), "60");
	assert.equal(env.CLASS_KV.reads, 0, "the phrase was never looked up");
	assert.deepEqual(counters.calls.client, []);
	assert.equal(counters.calls.global, 0);
});

test("over the brake, the RIGHT phrase is refused too, so a guesser learns nothing", async () => {
	const env = envWith(PHRASE, "", fakeLimiter(2));

	const wrong = await gateCompile(compileRequest(goodHeaders({ "x-class-phrase": "guess-one" })), env, spyCounters());
	assert.equal(wrong.response.status, 403);
	const right = await gateCompile(compileRequest(goodHeaders()), env, spyCounters());
	assert.equal(right.ok, true, "inside the limit the right phrase works");

	const wrongAgain = await gateCompile(compileRequest(goodHeaders({ "x-class-phrase": "guess-two" })), env, spyCounters());
	const rightAgain = await gateCompile(compileRequest(goodHeaders()), env, spyCounters());
	assert.equal(wrongAgain.response.status, 429);
	assert.equal(rightAgain.response.status, 429, "same answer for right and wrong");
	assert.equal(await errorOf(wrongAgain.response), await errorOf(rightAgain.response));
});

test("a request with no phrase at all is not a guess and is not counted", async () => {
	const limiter = fakeLimiter(0);
	const verdict = await gateCompile(compileRequest(), envWith(PHRASE, "", limiter), spyCounters());

	assert.equal(verdict.response.status, 403, "still the plain phrase refusal");
	assert.deepEqual(limiter.keys, []);
});

test("an address the gate cannot see still gets a bucket, not a free pass", async () => {
	const limiter = fakeLimiter();
	await gateCompile(
		compileRequest(goodHeaders({ "cf-connecting-ip": "" })),
		envWith(PHRASE, "", limiter),
		spyCounters(),
	);
	assert.deepEqual(limiter.keys, ["unknown"]);
});

test("a broken limiter binding lets the class compile rather than locking it out", async () => {
	const broken = {
		async limit() {
			throw new Error("binding unavailable");
		},
	};
	const originalError = console.error;
	console.error = () => {};
	try {
		const verdict = await gateCompile(compileRequest(goodHeaders()), envWith(PHRASE, "", broken), spyCounters());
		assert.equal(verdict.ok, true);
	} finally {
		console.error = originalError;
	}
});

test("the brake in wrangler.jsonc is exactly the site-wide ceiling, never tighter", () => {
	// The whole school shares one address. Held to less than the bill guard
	// already allows everybody together, the brake would punish a class for its
	// own size. See the notes at the top of src/compile-gate.ts.
	const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	const block = /"ratelimits"\s*:\s*\[([\s\S]*?)\]/.exec(config);
	assert.ok(block, "wrangler.jsonc has a ratelimits block");
	assert.match(block[1], /"name"\s*:\s*"PHRASE_LIMITER"/);
	assert.match(block[1], /"namespace_id"\s*:\s*"20260930"/);
	const simple = /"limit"\s*:\s*(\d+)\s*,\s*"period"\s*:\s*(\d+)/.exec(block[1]);
	assert.ok(simple, "a simple limit and period");
	assert.equal(Number(simple[1]), GLOBAL_COMPILE_MAX_PER_MINUTE);
	assert.equal(Number(simple[2]), 60, "a minute, the same window as the ceiling");
});

// ------------------------------------------------- a body with no length

/** A streamed body with no Content-Length, `chunks` pieces of `size` bytes. */
function streamedRequest(chunkSize, chunks) {
	let sent = 0;
	const state = { pulled: 0, cancelled: false };
	const body = new ReadableStream({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			sent += 1;
			state.pulled += 1;
			controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const request = new Request("https://uploadmycode.com/api/compile", {
		method: "POST",
		headers: { "cf-connecting-ip": SCHOOL_IP, ...goodHeaders() },
		body,
		duplex: "half",
	});
	assert.equal(request.headers.get("content-length"), null, "nothing declared");
	return { request, state };
}

test("a chunked upload with no length is cut off at the cap, not read to the end", async () => {
	const env = envWith(PHRASE);
	// Effectively endless: if the gate read it all, this test would never finish.
	const { request, state } = streamedRequest(16 * 1024, Number.MAX_SAFE_INTEGER);

	const verdict = await gateCompile(request, env, spyCounters());

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 413);
	assert.ok(state.pulled <= Math.ceil(MAX_COMPILE_BYTES / (16 * 1024)) + 2, `pulled ${state.pulled} pieces`);
	assert.equal(state.cancelled, true, "the rest of the upload was cancelled");
	assert.equal(env.CLASS_KV.reads, 0);
});

test("a chunked upload under the cap arrives whole", async () => {
	const { request } = streamedRequest(1000, 5);
	const verdict = await gateCompile(request, envWith(PHRASE), spyCounters());

	assert.equal(verdict.ok, true);
	assert.equal(verdict.body.byteLength, 5000);
});

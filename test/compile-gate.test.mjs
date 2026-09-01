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
import { test } from "node:test";

import { gateCompile, MAX_COMPILE_BYTES } from "../src/compile-gate.ts";
import { rateLimitKey } from "../src/ratelimit.ts";

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

function envWith(phrase, allowedCidrs = "") {
	return { ALLOWED_CIDRS: allowedCidrs, CLASS_KV: fakeKv(phrase) };
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

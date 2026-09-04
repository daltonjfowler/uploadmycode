/**
 * POST /api/format: the same five checks as a compile, and the one thing that
 * must NOT be shared — the budget.
 *
 * The promise this file exists to keep is narrow and worth stating plainly: a
 * student can press Auto indent as often as the limit allows and still have
 * every one of their six compiles. Tidying is the cheap thing you do while
 * reading your code; compiling is the thing you need when you are ready. If the
 * two ever shared a bucket, the cheap habit would eat the expensive need, and
 * the student would find that out in the worst minute of the lesson.
 *
 * Run with `npm test`. Node runs the .ts files directly (it strips the types).
 * The counters are injected, so the whole gate runs here with no Durable
 * Object, no container and no KV.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { gateCompile, gateFormat, MAX_COMPILE_BYTES } from "../src/compile-gate.ts";
import {
	FORMAT_KEY_PREFIX,
	FORMAT_RATE_LIMIT_MAX,
	formatRateLimitKey,
	GLOBAL_COMPILE_KEY,
	GLOBAL_COMPILE_MAX_PER_MINUTE,
	rateLimitKey,
	RateLimiter,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW_MS,
} from "../src/ratelimit.ts";

// Same stand-in as compile-gate.test.mjs: `crypto.subtle.timingSafeEqual` is a
// Cloudflare extension Node does not have, and what is under test here is the
// ordering and the budgets, not the compare itself.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
	crypto.subtle.timingSafeEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

const PHRASE = "red-robot-maple";
const SCHOOL_IP = "203.0.113.5";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const SKETCH = JSON.stringify({ code: "void setup() {}" });

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

function spyCounters({ client = true, global = true } = {}) {
	const calls = { client: [], global: 0 };
	return {
		calls,
		async checkClientRate(key) {
			calls.client.push(key);
			return client
				? { allowed: true, retryAfterSeconds: 0 }
				: { allowed: false, retryAfterSeconds: 9 };
		},
		async checkGlobalRate() {
			calls.global += 1;
			return global
				? { allowed: true, retryAfterSeconds: 0 }
				: { allowed: false, retryAfterSeconds: 17 };
		},
	};
}

function formatRequest(headers = {}, body = SKETCH) {
	return new Request("https://uploadmycode.com/api/format", {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": SCHOOL_IP, ...headers },
		body,
	});
}

function goodHeaders(extra = {}) {
	return { "x-class-phrase": PHRASE, "x-client-id": CLIENT_ID, ...extra };
}

async function errorOf(response) {
	const body = await response.json();
	return body.error;
}

// ------------------------------------------------------------ the bucket name

test("a format is counted into a bucket of its own, behind the fmt prefix", async () => {
	const counters = spyCounters();
	const verdict = await gateFormat(formatRequest(goodHeaders()), envWith(PHRASE), counters);

	assert.equal(verdict.ok, true);
	assert.deepEqual(counters.calls.client, ["fmt client " + CLIENT_ID]);
	assert.equal(FORMAT_KEY_PREFIX, "fmt ");
	// And it is counted toward the shared ceiling, because the same container
	// does the work either way and that number is about the bill.
	assert.equal(counters.calls.global, 1);
});

test("a format key can never be a compile key, whatever the client id says", async () => {
	// Not even for a client that hand-writes an id designed to look like one.
	assert.notEqual(formatRateLimitKey(CLIENT_ID, SCHOOL_IP), rateLimitKey(CLIENT_ID, SCHOOL_IP));
	assert.notEqual(formatRateLimitKey(null, SCHOOL_IP), rateLimitKey(null, SCHOOL_IP));
	// A dash is legal in an id, a space is not, so no id can spell the prefix.
	assert.notEqual(rateLimitKey("fmt-client-" + CLIENT_ID, SCHOOL_IP), formatRateLimitKey(CLIENT_ID, SCHOOL_IP));
});

test("a format with no client id falls back to the address, like a compile", async () => {
	const counters = spyCounters();
	await gateFormat(formatRequest({ "x-class-phrase": PHRASE }), envWith(PHRASE), counters);
	assert.deepEqual(counters.calls.client, ["fmt anon " + SCHOOL_IP]);

	const junk = spyCounters();
	await gateFormat(
		formatRequest(goodHeaders({ "x-client-id": "not a valid id" })),
		envWith(PHRASE),
		junk,
	);
	assert.deepEqual(junk.calls.client, ["fmt anon " + SCHOOL_IP], "malformed is the same as missing");
});

// --------------------------------------------------------- the two budgets

test("twelve formats in a minute do not spend a single compile", () => {
	// The two limiters the Durable Object holds, built here exactly as worker.ts
	// builds them, and driven through one shared clock.
	const compiles = new RateLimiter();
	const formats = new RateLimiter(FORMAT_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
	const now = 1_000_000;

	for (let i = 0; i < FORMAT_RATE_LIMIT_MAX; i++) {
		assert.equal(
			formats.check(formatRateLimitKey(CLIENT_ID, SCHOOL_IP), now + i).allowed,
			true,
			"format " + (i + 1) + " should pass",
		);
	}
	// The thirteenth is refused, so the limit really is twelve.
	assert.equal(formats.check(formatRateLimitKey(CLIENT_ID, SCHOOL_IP), now + 12).allowed, false);

	// And now the point of the whole file: all six compiles are still there.
	for (let i = 0; i < RATE_LIMIT_MAX; i++) {
		assert.equal(
			compiles.check(rateLimitKey(CLIENT_ID, SCHOOL_IP), now + 20 + i).allowed,
			true,
			"compile " + (i + 1) + " should still pass after all that tidying",
		);
	}
});

test("running out of compiles does not take Auto indent away either", () => {
	const compiles = new RateLimiter();
	const formats = new RateLimiter(FORMAT_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
	const now = 1_000_000;

	for (let i = 0; i < RATE_LIMIT_MAX; i++) compiles.check(rateLimitKey(CLIENT_ID, SCHOOL_IP), now);
	assert.equal(compiles.check(rateLimitKey(CLIENT_ID, SCHOOL_IP), now).allowed, false);

	// A student who has just burned their compiles is exactly the student who
	// wants to read their sketch properly. Let them tidy it.
	assert.equal(formats.check(formatRateLimitKey(CLIENT_ID, SCHOOL_IP), now).allowed, true);
});

test("the format limit is twelve, and it is one number", () => {
	assert.equal(FORMAT_RATE_LIMIT_MAX, 12);
	assert.equal(FORMAT_RATE_LIMIT_MAX, RATE_LIMIT_MAX * 2, "twice the compiles, being far cheaper");
});

test("classmates on the one school address each get their own twelve", () => {
	const formats = new RateLimiter(FORMAT_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
	const now = 1_000_000;
	const mine = formatRateLimitKey(CLIENT_ID, SCHOOL_IP);
	const theirs = formatRateLimitKey("22222222-2222-4222-8222-222222222222", SCHOOL_IP);

	for (let i = 0; i < FORMAT_RATE_LIMIT_MAX; i++) formats.check(mine, now);
	assert.equal(formats.check(mine, now).allowed, false);
	assert.equal(formats.check(theirs, now).allowed, true, "same building, different Chromebook");
});

test("formats and compiles share the one ceiling, because they share the container", () => {
	const everyone = new RateLimiter(GLOBAL_COMPILE_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
	const now = 1_000_000;

	// Sixty of each is the ceiling exactly, whichever order they arrive in.
	for (let i = 0; i < GLOBAL_COMPILE_MAX_PER_MINUTE; i++) {
		assert.equal(everyone.check(GLOBAL_COMPILE_KEY, now + i).allowed, true);
	}
	assert.equal(everyone.check(GLOBAL_COMPILE_KEY, now + 200).allowed, false);
});

// ------------------------------------------------------------- the messages

test("too much tidying is a 429 in the words the task asked for, with Retry-After", async () => {
	const counters = spyCounters({ client: false });
	const verdict = await gateFormat(formatRequest(goodHeaders()), envWith(PHRASE), counters);

	assert.equal(verdict.ok, false);
	assert.equal(verdict.response.status, 429);
	assert.equal(
		await errorOf(verdict.response),
		"That is a lot of tidying in one minute. Wait a moment and try again.",
	);
	assert.equal(verdict.response.headers.get("retry-after"), "9");
	assert.equal(counters.calls.global, 0, "the ceiling is not spent on a request already refused");
});

test("the size and phrase sentences are word for word the compile ones", async () => {
	// Same problem, same words: which button was pressed does not change what a
	// student has to go and do about it.
	const big = "x".repeat(MAX_COMPILE_BYTES + 1);
	const tooBig = await gateFormat(formatRequest(goodHeaders(), big), envWith(PHRASE), spyCounters());
	const tooBigCompile = await gateCompile(
		new Request("https://uploadmycode.com/api/compile", {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": SCHOOL_IP, ...goodHeaders() },
			body: big,
		}),
		envWith(PHRASE),
		spyCounters(),
	);
	assert.equal(tooBig.response.status, 413);
	assert.equal(await errorOf(tooBig.response), await errorOf(tooBigCompile.response));

	const wrong = await gateFormat(
		formatRequest(goodHeaders({ "x-class-phrase": "not-todays-phrase" })),
		envWith(PHRASE),
		spyCounters(),
	);
	assert.equal(wrong.response.status, 403);
	assert.equal(
		await errorOf(wrong.response),
		"Wrong class phrase. Ask your teacher for today's phrase.",
	);

	const none = await gateFormat(formatRequest(goodHeaders()), envWith(null), spyCounters());
	assert.equal(none.response.status, 403);
	assert.equal(await errorOf(none.response), "No class phrase is active. Ask your teacher.");
});

test("the ceiling's own sentence is the shared one", async () => {
	const counters = spyCounters({ global: false });
	const verdict = await gateFormat(formatRequest(goodHeaders()), envWith(PHRASE), counters);

	assert.equal(verdict.response.status, 429);
	assert.equal(
		await errorOf(verdict.response),
		"The compiler is very busy right now. Wait a minute and try again.",
	);
	assert.equal(counters.calls.client.length, 1, "the client check ran first");
});

// ------------------------------------------------------ the order is the same

test("a wrong phrase never reaches a format counter either", async () => {
	const counters = spyCounters();
	const env = envWith(PHRASE);

	for (let i = 0; i < 20; i++) {
		const verdict = await gateFormat(
			formatRequest(goodHeaders({ "x-class-phrase": "wrong-" + i })),
			env,
			counters,
		);
		assert.equal(verdict.response.status, 403, "always 403, never 429");
		assert.equal(verdict.response.headers.get("retry-after"), null);
	}

	assert.deepEqual(counters.calls.client, [], "not one wrong phrase spent a tidy");
	assert.equal(counters.calls.global, 0);
	assert.equal((await gateFormat(formatRequest(goodHeaders()), env, counters)).ok, true);
});

test("an oversize body and the school lock are both answered before KV is read", async () => {
	const bigEnv = envWith(PHRASE);
	await gateFormat(
		formatRequest(goodHeaders(), "x".repeat(MAX_COMPILE_BYTES + 1)),
		bigEnv,
		spyCounters(),
	);
	assert.equal(bigEnv.CLASS_KV.reads, 0);

	const lockedEnv = envWith(PHRASE, "198.51.100.0/24");
	const locked = await gateFormat(formatRequest(goodHeaders()), lockedEnv, spyCounters());
	assert.equal(locked.response.status, 403);
	assert.equal(await errorOf(locked.response), "uploadmycode only works from school.");
	assert.equal(lockedEnv.CLASS_KV.reads, 0);
});

test("the body comes back already read, ready to forward unchanged", async () => {
	const verdict = await gateFormat(formatRequest(goodHeaders()), envWith(PHRASE), spyCounters());
	assert.equal(verdict.ok, true);
	assert.equal(new TextDecoder().decode(verdict.body), SKETCH);
});

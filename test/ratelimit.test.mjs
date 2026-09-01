/**
 * The compile rate limiter: the window, the client-id bucket names, and the
 * site-wide ceiling.
 *
 * Run with `npm test`. Node runs src/ratelimit.ts directly (it strips the
 * types). The clock is always passed in, so the whole window can be walked
 * through without waiting a real minute.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	GLOBAL_COMPILE_KEY,
	GLOBAL_COMPILE_MAX_PER_MINUTE,
	rateLimitKey,
	RateLimiter,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW_MS,
} from "../src/ratelimit.ts";

test("the sixth compile passes and the seventh does not", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	for (let i = 0; i < RATE_LIMIT_MAX; i++) {
		const verdict = limiter.check("203.0.113.5", start + i * 100);
		assert.equal(verdict.allowed, true, `compile ${i + 1} should pass`);
		assert.equal(verdict.retryAfterSeconds, 0);
	}

	const seventh = limiter.check("203.0.113.5", start + 600);
	assert.equal(seventh.allowed, false);
	assert.equal(seventh.retryAfterSeconds, 60, "the whole window is still ahead");
});

test("the window slides: the oldest hit ageing out frees exactly one slot", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	// Six hits one second apart, so they expire one second apart too.
	for (let i = 0; i < RATE_LIMIT_MAX; i++) {
		assert.equal(limiter.check("ip", start + i * 1000).allowed, true);
	}
	assert.equal(limiter.check("ip", start + 6000).allowed, false);

	// One millisecond before the first hit ages out.
	assert.equal(limiter.check("ip", start + RATE_LIMIT_WINDOW_MS - 1).allowed, false);
	// The moment it is a full window old it no longer counts, freeing one slot.
	assert.equal(limiter.check("ip", start + RATE_LIMIT_WINDOW_MS).allowed, true);
	// And exactly one: the five newer hits plus the one just taken make six.
	assert.equal(limiter.check("ip", start + RATE_LIMIT_WINDOW_MS).allowed, false);
});

test("retryAfterSeconds counts down toward the oldest hit leaving the window", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	for (let i = 0; i < RATE_LIMIT_MAX; i++) limiter.check("ip", start);

	assert.equal(limiter.check("ip", start).retryAfterSeconds, 60);
	assert.equal(limiter.check("ip", start + 30_000).retryAfterSeconds, 30);
	assert.equal(limiter.check("ip", start + 59_500).retryAfterSeconds, 1, "never rounds to 0");
	// A whole window later everything has aged out.
	assert.equal(limiter.check("ip", start + RATE_LIMIT_WINDOW_MS + 1).allowed, true);
});

test("a refused attempt is not counted, so hammering cannot extend the wait", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	for (let i = 0; i < RATE_LIMIT_MAX; i++) limiter.check("ip", start);
	// Twenty angry clicks spread over the window.
	for (let i = 0; i < 20; i++) limiter.check("ip", start + i * 100);

	// The wait is still measured from the original six, not from the clicks.
	assert.equal(limiter.check("ip", start + RATE_LIMIT_WINDOW_MS + 1).allowed, true);
});

test("each bucket has its own budget", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	const one = rateLimitKey("11111111-1111-4111-8111-111111111111", "203.0.113.5");
	const two = rateLimitKey("22222222-2222-4222-8222-222222222222", "203.0.113.5");

	for (let i = 0; i < RATE_LIMIT_MAX; i++) limiter.check(one, start);
	assert.equal(limiter.check(one, start).allowed, false);
	assert.equal(
		limiter.check(two, start).allowed,
		true,
		"the classmate on the same school address is fine",
	);
});

test("pruning drops keys that have gone quiet", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	limiter.check("a", start);
	limiter.check("b", start + 30_000);
	assert.equal(limiter.size, 2);

	limiter.prune(start + RATE_LIMIT_WINDOW_MS + 1);
	assert.equal(limiter.size, 1, "a has aged out, b has not");

	limiter.prune(start + 30_000 + RATE_LIMIT_WINDOW_MS + 1);
	assert.equal(limiter.size, 0);
});

test("the limits are configurable, which is how the window itself is tested", () => {
	const limiter = new RateLimiter(2, 1000);

	assert.equal(limiter.check("ip", 0).allowed, true);
	assert.equal(limiter.check("ip", 0).allowed, true);
	assert.equal(limiter.check("ip", 0).allowed, false);
	assert.equal(limiter.check("ip", 1001).allowed, true);
});

// ------------------------------------------------------------- bucket names

test("a well-formed client id gets its own bucket", () => {
	const uuid = crypto.randomUUID();
	assert.equal(rateLimitKey(uuid, "203.0.113.5"), "client " + uuid);
	// randomUUID is what the page sends, so it had better be acceptable.
	assert.notEqual(rateLimitKey(uuid, "ip"), rateLimitKey(crypto.randomUUID(), "ip"));
});

test("anything that is not a sane client id falls back to the address", () => {
	const junk = [
		null,
		undefined,
		"",
		"short",                                    // seven characters, under the floor
		"a".repeat(65),                             // one over the ceiling
		"has spaces in it",
		"semi;colon",
		"slash/es",
		"under_scores",
		"dots.in.it",
		"emoji-😀-here",
		"plus+sign+here",
		"percent%20encoded",
		{ not: "a string" },
		1234567890,
	];
	for (const id of junk) {
		assert.equal(
			rateLimitKey(id, "203.0.113.5"),
			"anon 203.0.113.5",
			"rejected: " + JSON.stringify(id),
		);
	}
});

test("the shortest and longest acceptable ids are accepted", () => {
	assert.equal(rateLimitKey("abcd1234", "ip"), "client abcd1234");
	assert.equal(rateLimitKey("A".repeat(64), "ip"), "client " + "A".repeat(64));
});

test("a missing address still gets a bucket of its own", () => {
	// cf-connecting-ip is written by Cloudflare and is missing only in odd local
	// cases. Those all share one strict bucket rather than one loose one.
	assert.equal(rateLimitKey(null, ""), "anon unknown");
});

test("a client id can never be confused with an address, or the ceiling", () => {
	// Dots are not allowed in an id, but dashes are, so a client could try to
	// dress one up as an address. The prefixes keep the two apart.
	assert.notEqual(rateLimitKey("203-0-113-5", "198.51.100.1"), rateLimitKey(null, "203-0-113-5"));
	assert.notEqual(rateLimitKey(GLOBAL_COMPILE_KEY, "ip"), GLOBAL_COMPILE_KEY);
	assert.notEqual(rateLimitKey(null, GLOBAL_COMPILE_KEY), GLOBAL_COMPILE_KEY);
});

test("curl with no id shares one bucket per address, which is the point", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	const anon = rateLimitKey(null, "203.0.113.9");
	const malformed = rateLimitKey("nope!", "203.0.113.9");
	assert.equal(anon, malformed);

	for (let i = 0; i < RATE_LIMIT_MAX; i++) assert.equal(limiter.check(anon, start).allowed, true);
	assert.equal(limiter.check(malformed, start).allowed, false, "same six, not another six");
	// And a real editor on that same address is untouched.
	assert.equal(limiter.check(rateLimitKey(crypto.randomUUID(), "203.0.113.9"), start).allowed, true);
});

// ----------------------------------------------------------- the bill guard

test("the ceiling is one number, and it is 120 a minute", () => {
	assert.equal(GLOBAL_COMPILE_MAX_PER_MINUTE, 120);
});

test("the 121st compile in a minute from everybody together is refused", () => {
	const everyone = new RateLimiter(GLOBAL_COMPILE_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
	const start = 1_000_000;

	for (let i = 0; i < GLOBAL_COMPILE_MAX_PER_MINUTE; i++) {
		assert.equal(everyone.check(GLOBAL_COMPILE_KEY, start + i).allowed, true, "compile " + (i + 1));
	}

	const over = everyone.check(GLOBAL_COMPILE_KEY, start + GLOBAL_COMPILE_MAX_PER_MINUTE);
	assert.equal(over.allowed, false);
	assert.equal(over.retryAfterSeconds, 60);

	// It slides like the per-client one: the oldest hit ageing out frees a slot.
	assert.equal(everyone.check(GLOBAL_COMPILE_KEY, start + RATE_LIMIT_WINDOW_MS).allowed, true);
});

test("a whole class working hard stays well under the ceiling", () => {
	const everyone = new RateLimiter(GLOBAL_COMPILE_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
	const start = 1_000_000;

	// Thirty students, each at their own per-client limit of six a minute, is
	// 180 — over the ceiling. But six a minute each is a stuck loop, not a
	// lesson: two compiles a minute each is 60, which is half the ceiling.
	for (let i = 0; i < 30 * 2; i++) {
		assert.equal(everyone.check(GLOBAL_COMPILE_KEY, start + i * 500).allowed, true);
	}
});

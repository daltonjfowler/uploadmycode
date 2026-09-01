/**
 * The compile rate limiter's window.
 *
 * Run with `npm test`. Node runs src/ratelimit.ts directly (it strips the
 * types). The clock is always passed in, so the whole window can be walked
 * through without waiting a real minute.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RateLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../src/ratelimit.ts";

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

test("each IP has its own budget", () => {
	const limiter = new RateLimiter();
	const start = 1_000_000;

	for (let i = 0; i < RATE_LIMIT_MAX; i++) limiter.check("203.0.113.5", start);
	assert.equal(limiter.check("203.0.113.5", start).allowed, false);
	assert.equal(limiter.check("203.0.113.6", start).allowed, true, "the next student is fine");
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

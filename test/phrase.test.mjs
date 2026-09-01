/**
 * The rolling class phrase rules.
 *
 * Run with `npm test`. Node runs src/phrase.ts directly (it strips the types),
 * so this tests the exact file the Worker bundles — there is no build step and
 * no second copy of the normalizer to keep in sync.
 *
 * The constant-time comparison itself is not here: it lives in
 * src/constant-time.ts and needs crypto.subtle.timingSafeEqual, which is a
 * Workers extension that Node does not have.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	activeRecord,
	clampTtlSeconds,
	DEFAULT_TTL_SECONDS,
	isUsablePhrase,
	MAX_PHRASE_LENGTH,
	MAX_TTL_SECONDS,
	MIN_TTL_SECONDS,
	normalizePhrase,
} from "../src/phrase.ts";

test("normalizing trims, lowercases and collapses whitespace", () => {
	assert.equal(normalizePhrase("  Blue Robot Pancake  "), "blue robot pancake");
	assert.equal(normalizePhrase("BLUE   ROBOT\tPANCAKE"), "blue robot pancake");
	assert.equal(normalizePhrase("blue\r\nrobot\npancake"), "blue robot pancake");
	assert.equal(normalizePhrase("blue-robot-pancake"), "blue-robot-pancake");
});

test("what the teacher projects and what a student types normalize the same", () => {
	assert.equal(normalizePhrase("Blue Robot Pancake"), normalizePhrase("blue robot   pancake "));
});

test("anything that is not a string normalizes to the empty phrase", () => {
	for (const value of [undefined, null, 42, {}, [], true]) {
		assert.equal(normalizePhrase(value), "");
	}
	// A header that is absent and a header that is blank take the same path.
	assert.equal(normalizePhrase("   "), "");
});

test("a phrase is usable only when it is non-empty and not too long", () => {
	assert.equal(isUsablePhrase(""), false);
	assert.equal(isUsablePhrase("a"), true);
	assert.equal(isUsablePhrase("x".repeat(MAX_PHRASE_LENGTH)), true);
	assert.equal(isUsablePhrase("x".repeat(MAX_PHRASE_LENGTH + 1)), false);
});

test("ttl clamps to the KV floor and the twelve-hour ceiling", () => {
	assert.equal(clampTtlSeconds(60), MIN_TTL_SECONDS);
	assert.equal(clampTtlSeconds(1), MIN_TTL_SECONDS, "KV refuses anything under 60 s");
	assert.equal(clampTtlSeconds(0), MIN_TTL_SECONDS);
	assert.equal(clampTtlSeconds(-5000), MIN_TTL_SECONDS);
	assert.equal(clampTtlSeconds(5400), 5400, "one class period");
	assert.equal(clampTtlSeconds(MAX_TTL_SECONDS), MAX_TTL_SECONDS);
	assert.equal(clampTtlSeconds(999999), MAX_TTL_SECONDS);
	assert.equal(clampTtlSeconds(90.7), 90, "seconds are whole");
});

test("a missing or unreadable ttl becomes one class period", () => {
	assert.equal(clampTtlSeconds(undefined), DEFAULT_TTL_SECONDS);
	assert.equal(clampTtlSeconds(null), DEFAULT_TTL_SECONDS);
	assert.equal(clampTtlSeconds("banana"), DEFAULT_TTL_SECONDS);
	assert.equal(clampTtlSeconds(Number.NaN), DEFAULT_TTL_SECONDS);
	assert.equal(clampTtlSeconds(Number.POSITIVE_INFINITY), DEFAULT_TTL_SECONDS);
	// A numeric string is still a number a teacher meant.
	assert.equal(clampTtlSeconds("5400"), 5400);
});

test("a stored phrase is active until the moment it expires", () => {
	const record = { phrase: "blue robot pancake", expiresAt: 1000 };

	assert.deepEqual(activeRecord(record, 999), record, "one millisecond left");
	assert.equal(activeRecord(record, 1000), null, "expiry is exclusive");
	assert.equal(activeRecord(record, 1001), null);
});

test("a stored phrase is re-normalized on the way back out", () => {
	const active = activeRecord({ phrase: "  Blue  Robot ", expiresAt: 1000 }, 0);
	assert.deepEqual(active, { phrase: "blue robot", expiresAt: 1000 });
});

test("junk in KV is treated as no phrase at all, never as a match", () => {
	assert.equal(activeRecord(null, 0), null);
	assert.equal(activeRecord(undefined, 0), null);
	assert.equal(activeRecord("blue robot pancake", 0), null, "a bare string is not a record");
	assert.equal(activeRecord({ expiresAt: 1000 }, 0), null, "no phrase");
	assert.equal(activeRecord({ phrase: "blue" }, 0), null, "no expiry");
	assert.equal(activeRecord({ phrase: "", expiresAt: 1000 }, 0), null);
	assert.equal(activeRecord({ phrase: "blue", expiresAt: "1000" }, 0), null, "expiry must be a number");
	assert.equal(activeRecord({ phrase: "blue", expiresAt: Number.NaN }, 0), null);
});

/**
 * The growing wrong-guess lockout (src/lockout.ts), on its own and wired into
 * the compile gate.
 *
 * Run with `npm test`. Node runs the .ts files directly (it strips the types).
 * The store is an in-memory map and the clock is passed in, so a five-minute
 * lock is walked through in a millisecond.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { gateCompile } from "../src/compile-gate.ts";
import {
	afterWrong,
	clearLock,
	FIRST_LOCK_SECONDS,
	LOCK_AFTER_FAILURES,
	lockedResponse,
	lockKey,
	lockSecondsFor,
	lockSubject,
	MAX_LOCK_SECONDS,
	memoryLockoutStore,
	readLock,
	recordWrong,
} from "../src/lockout.ts";

// Node has no timingSafeEqual; see test/compile-gate.test.mjs.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
	crypto.subtle.timingSafeEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

const IP = "198.51.100.7";

/** One wrong try the way the Worker does it: ask, then count if not locked. */
async function wrongTry(store, kind, now) {
	const state = await readLock(store, kind, IP, now);
	if (state.retryAfterSeconds > 0) return { refused: true, seconds: state.retryAfterSeconds };
	await recordWrong(store, kind, IP, state, now);
	return { refused: false };
}

// ------------------------------------------------------------------ the math

test("the numbers are the ones Dalton asked for", () => {
	assert.equal(LOCK_AFTER_FAILURES, 5);
	assert.equal(FIRST_LOCK_SECONDS, 5);
	assert.equal(MAX_LOCK_SECONDS, 300);
});

test("no lock below five; then 5, 10, 20, 40, 80, 160, and capped at 300", () => {
	assert.deepEqual(
		[0, 1, 2, 3, 4].map(lockSecondsFor),
		[0, 0, 0, 0, 0],
	);
	assert.deepEqual(
		[5, 6, 7, 8, 9, 10, 11, 12, 50, 1e9].map(lockSecondsFor),
		[5, 10, 20, 40, 80, 160, 300, 300, 300, 300],
	);
});

test("afterWrong counts up and sets the end of the lock from now", () => {
	let record = null;
	for (let i = 0; i < 4; i++) record = afterWrong(record, 1000);
	assert.deepEqual(record, { failures: 4, lockedUntil: 0 });
	record = afterWrong(record, 1000);
	assert.deepEqual(record, { failures: 5, lockedUntil: 6000 });
});

test("the store key is per kind and per device (Dalton 2026-09-28: kids never lock each other out)", () => {
	const a = lockSubject("11111111-2222-4333-8444-555555555555", IP);
	const b = lockSubject("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", IP);
	assert.equal(a, "device:11111111-2222-4333-8444-555555555555");
	assert.notEqual(lockKey("phrase", a), lockKey("phrase", b), "two devices on one school IP are counted apart");
	assert.notEqual(lockKey("phrase", a), lockKey("teacher", a));
	assert.ok(lockKey("phrase", a).startsWith("https://lockout.internal/phrase/"));
});

test("no usable device id (only scripts send none) falls back to the IP", () => {
	assert.equal(lockSubject(" 11111111-2222-4333-8444-555555555555 ".toUpperCase(), IP), "device:11111111-2222-4333-8444-555555555555");
	for (const junk of [undefined, null, "", "not-a-uuid", "11111111222243338444555555555555", "11111111-2222-4333-8444-55555555555g", "11111111-2222-4333-8444-555555555555x"]) {
		assert.equal(lockSubject(junk, IP), `ip:${IP}`, String(junk));
	}
	assert.equal(lockSubject(null, ""), "ip:unknown");
});

test("the locked reply is a 429 with the wait in the body and the header", async () => {
	const response = lockedResponse(5);
	assert.equal(response.status, 429);
	assert.equal(response.headers.get("retry-after"), "5");
	assert.deepEqual(await response.json(), {
		ok: false,
		error: "locked",
		retryAfter: 5,
		message: "Too many wrong tries. Wait 5 seconds and try again.",
	});
});

// ---------------------------------------------------------------- the store

test("four wrong tries are fine; the fifth locks for 5 s", async () => {
	const store = memoryLockoutStore();
	const now = 1_000_000;
	for (let i = 0; i < 4; i++) {
		assert.deepEqual(await wrongTry(store, "phrase", now), { refused: false });
		assert.equal((await readLock(store, "phrase", IP, now)).retryAfterSeconds, 0);
	}
	assert.deepEqual(await wrongTry(store, "phrase", now), { refused: false });
	assert.equal((await readLock(store, "phrase", IP, now)).retryAfterSeconds, 5);
	assert.deepEqual(await wrongTry(store, "phrase", now + 1000), { refused: true, seconds: 4 });
	// Refused tries are not counted, so they cannot push the end out.
	assert.equal(store.map.get(lockKey("phrase", IP)).failures, 5);
	// Five seconds on, the address may try again.
	assert.equal((await readLock(store, "phrase", IP, now + 5000)).retryAfterSeconds, 0);
});

test("each wrong try after a lock ends doubles it, up to 300 s", async () => {
	const store = memoryLockoutStore();
	let now = 1_000_000;
	for (let i = 0; i < 4; i++) await wrongTry(store, "teacher", now);

	const seen = [];
	for (let i = 0; i < 9; i++) {
		await wrongTry(store, "teacher", now);
		const seconds = (await readLock(store, "teacher", IP, now)).retryAfterSeconds;
		seen.push(seconds);
		now += seconds * 1000;
	}
	assert.deepEqual(seen, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
});

test("the phrase and the teacher key are counted apart", async () => {
	const store = memoryLockoutStore();
	for (let i = 0; i < 5; i++) await wrongTry(store, "phrase", 0);
	assert.equal((await readLock(store, "phrase", IP, 0)).retryAfterSeconds, 5);
	assert.equal((await readLock(store, "teacher", IP, 0)).retryAfterSeconds, 0);
});

test("a correct answer clears the counter", async () => {
	const store = memoryLockoutStore();
	for (let i = 0; i < 4; i++) await wrongTry(store, "phrase", 0);
	await clearLock(store, "phrase", IP, await readLock(store, "phrase", IP, 0));
	assert.equal(store.map.size, 0);
	// Back to a fresh five.
	for (let i = 0; i < 4; i++) await wrongTry(store, "phrase", 0);
	assert.equal((await readLock(store, "phrase", IP, 0)).retryAfterSeconds, 0);
});

test("a store that throws falls open: never locked, nothing thrown", async () => {
	const broken = {
		async get() {
			throw new Error("cache down");
		},
		async put() {
			throw new Error("cache down");
		},
		async delete() {
			throw new Error("cache down");
		},
	};
	const quiet = console.error;
	console.error = () => {};
	try {
		for (let i = 0; i < 20; i++) {
			assert.deepEqual(await wrongTry(broken, "phrase", 0), { refused: false });
		}
		await clearLock(broken, "phrase", IP, { record: { failures: 1, lockedUntil: 0 }, retryAfterSeconds: 0 });
	} finally {
		console.error = quiet;
	}
});

// ------------------------------------------------------------- in the gate

const PHRASE = "red-robot-maple";

function envWith() {
	const kv = {
		reads: 0,
		async get() {
			kv.reads += 1;
			return { phrase: PHRASE, expiresAt: Date.now() + 60_000 };
		},
	};
	return {
		ALLOWED_CIDRS: "",
		CLASS_KV: kv,
		PHRASE_LIMITER: { async limit() { return { success: true }; } },
	};
}

const counters = {
	async checkClientRate() {
		return { allowed: true, retryAfterSeconds: 0 };
	},
	async checkGlobalRate() {
		return { allowed: true, retryAfterSeconds: 0 };
	},
};

function compileRequest(phrase) {
	return new Request("https://uploadmycode.com/api/compile", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": IP,
			"x-class-phrase": phrase,
		},
		body: JSON.stringify({ code: "void setup() {}" }),
	});
}

test("the gate: 4 wrong are 403, the 5th is 403 and locks, then even the right phrase is 429 unread", async () => {
	const store = memoryLockoutStore();
	const env = envWith();

	for (let i = 0; i < 5; i++) {
		const verdict = await gateCompile(compileRequest("wrong guess"), env, counters, store);
		assert.equal(verdict.ok, false);
		assert.equal(verdict.response.status, 403);
	}
	assert.equal(env.CLASS_KV.reads, 5);

	const locked = await gateCompile(compileRequest(PHRASE), env, counters, store);
	assert.equal(locked.ok, false);
	assert.equal(locked.response.status, 429);
	assert.equal(locked.response.headers.get("retry-after"), "5");
	const body = await locked.response.json();
	assert.equal(body.error, "locked");
	assert.equal(body.retryAfter, 5);
	// Refused without comparing: the phrase was never even read from KV.
	assert.equal(env.CLASS_KV.reads, 5);
});

test("the gate: the right phrase clears the counter", async () => {
	const store = memoryLockoutStore();
	const env = envWith();
	for (let i = 0; i < 4; i++) await gateCompile(compileRequest("nope"), env, counters, store);
	assert.equal(store.map.size, 1);

	const verdict = await gateCompile(compileRequest(PHRASE), env, counters, store);
	assert.equal(verdict.ok, true);
	assert.equal(store.map.size, 0);
});

test("the gate: a request with no phrase is not a guess and is not counted", async () => {
	const store = memoryLockoutStore();
	const env = envWith();
	for (let i = 0; i < 10; i++) await gateCompile(compileRequest(""), env, counters, store);
	assert.equal(store.map.size, 0);
});

test("the gate: with no cache at all (as under node) the class still compiles", async () => {
	// No store passed: the gate uses caches.default, which node does not have.
	const quiet = console.error;
	console.error = () => {};
	try {
		const env = envWith();
		for (let i = 0; i < 10; i++) await gateCompile(compileRequest("nope"), env, counters);
		const verdict = await gateCompile(compileRequest(PHRASE), env, counters);
		assert.equal(verdict.ok, true);
	} finally {
		console.error = quiet;
	}
});

/**
 * The compile queue: how long the line is, who is still standing in it, and
 * what happens to the tokens of requests that never came back.
 *
 * There is no test for a personal place in the line because the code no longer
 * reports one: the Worker's order is not the container's, so that number could
 * not be told truthfully. See the note at the top of src/queue.ts.
 *
 * Run with `npm test`. Node runs src/queue.ts directly (it strips the types).
 * The clock is always passed in, so a token can be aged out without waiting two
 * real minutes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CompileQueue, CONTAINER_COUNT, isUsableToken, MAX_WAIT_MS } from "../src/queue.ts";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-3333-4333-8333-cccccccccccc";
const D = "dddddddd-4444-4444-8444-dddddddddddd";

// A queue with a known container count, so the assignments below are exact
// rather than dependent on whatever CONTAINER_COUNT happens to be today.
const twoContainers = () => new CompileQueue(2);

test("joining reports the length of the line, this compile included", () => {
	const queue = twoContainers();
	const now = 1_000_000;

	assert.equal(queue.enter(A, now).depth, 1);
	assert.equal(queue.enter(B, now + 10).depth, 2);
	assert.equal(queue.enter(C, now + 20).depth, 3);

	assert.equal(queue.depth(now + 30), 3);
	assert.equal(queue.isWaiting(A, now + 30), true);
	assert.equal(queue.isWaiting(B, now + 30), true);
	assert.equal(queue.isWaiting(C, now + 30), true);
});

test("compiles go to the least-loaded container, ties to the lower index", () => {
	const queue = twoContainers();
	const now = 1_000_000;

	assert.equal(queue.enter(A, now).container, 0, "first has both empty: index 0");
	assert.equal(queue.enter(B, now + 1).container, 1, "second balances onto 1");
	assert.equal(queue.enter(C, now + 2).container, 0, "third: tie at 1 each, back to 0");
	assert.equal(queue.enter(D, now + 3).container, 1, "fourth fills 1");
});

test("one compile in flight always lands on container 0, leaving the rest asleep", () => {
	const queue = twoContainers();
	let now = 1_000_000;
	// This is the property that keeps a second container from billing all day:
	// nothing but a genuine overlap ever reaches container 1.
	for (let i = 0; i < 6; i += 1) {
		const token = `solo-${i}-aaaaaaaaaaaa`;
		assert.equal(queue.enter(token, now).container, 0, "a lone compile uses container 0");
		queue.leave(token);
		now += 100;
	}
});

test("when a container frees up, the next compile fills that gap", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	queue.enter(A, now); // -> 0
	queue.enter(B, now + 1); // -> 1
	queue.enter(C, now + 2); // -> 0 (tie), so container 0 now carries A and C
	queue.leave(A); // container 0 back to just C; 0 and 1 hold one each

	assert.equal(queue.enter(D, now + 4).container, 0, "the freed slot on 0 is taken first");
});

test("a swept token frees its container too", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	queue.enter(A, now); // -> 0
	queue.enter(B, now + 1); // -> 1

	const later = now + MAX_WAIT_MS + 1; // both A and B age out
	assert.equal(queue.enter(C, later).container, 0, "with the line swept, 0 is free again");
	assert.equal(queue.depth(later), 1);
});

test("the line spreads across every configured container", () => {
	assert.ok(CONTAINER_COUNT >= 1);
	const queue = new CompileQueue(CONTAINER_COUNT);
	const now = 1_000_000;
	const seen = new Set();
	for (let i = 0; i < CONTAINER_COUNT * 3; i += 1) {
		seen.add(queue.enter(`spread-${i}-aaaaaaaa`, now + i).container);
	}
	assert.equal(seen.size, CONTAINER_COUNT, "every container is used under load");
});

test("when one finishes, the line gets shorter for everybody left", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	queue.enter(A, now);
	queue.enter(B, now + 10);
	queue.enter(C, now + 20);

	queue.leave(A);

	assert.equal(queue.depth(now + 30), 2);
	assert.equal(queue.isWaiting(A, now + 30), false);
	assert.equal(queue.isWaiting(B, now + 30), true);
});

test("a token that is not waiting says so", () => {
	const queue = twoContainers();
	const now = 1_000_000;

	assert.equal(queue.isWaiting(A, now), false, "never joined");

	queue.enter(A, now);
	queue.leave(A);
	assert.equal(queue.isWaiting(A, now + 10), false, "already finished");
});

test("leaving twice, or leaving something that never joined, is harmless", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	queue.enter(A, now);

	queue.leave(A);
	queue.leave(A);
	queue.leave(B);

	assert.equal(queue.depth(now), 0);
});

test("entering twice with one token counts once", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	queue.enter(A, now);
	queue.enter(B, now + 10);

	assert.equal(queue.enter(A, now + 20).depth, 2, "still two compiles, not three");
	assert.equal(queue.depth(now + 20), 2);
});

test("a token left behind by a lost request ages out of the line", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	queue.enter(A, now);
	queue.enter(B, now + 1000);

	const later = now + MAX_WAIT_MS + 1;
	assert.equal(queue.isWaiting(A, later), false, "the lost one is gone");
	assert.equal(queue.isWaiting(B, later), true, "and the real one is untouched");
	assert.equal(queue.depth(later), 1, "so it stops lengthening the line for everybody");
});

test("the line cannot grow without bound", () => {
	const queue = twoContainers();
	const now = 1_000_000;
	for (let i = 0; i < 400; i += 1) {
		queue.enter(`token-${String(i).padStart(4, "0")}`, now + i);
	}
	assert.ok(queue.depth(now + 400) <= 256, `depth was ${queue.depth(now + 400)}`);
});

test("only sane tokens are tracked", () => {
	assert.equal(isUsableToken(A), true);
	assert.equal(isUsableToken("t-1a2b3c4d-9z8y7x6w"), true);
	assert.equal(isUsableToken(""), false);
	assert.equal(isUsableToken("short"), false);
	assert.equal(isUsableToken(null), false);
	assert.equal(isUsableToken(undefined), false);
	assert.equal(isUsableToken("has spaces in it"), false);
	assert.equal(isUsableToken("x".repeat(65)), false);
	assert.equal(isUsableToken("semi;colon-and-more"), false);
});

// The buckets a queue poll spends. Kept here rather than in ratelimit.test.mjs
// because the reason they exist is the queue: polls must not be able to spend
// the budget that lets a class compile.

test("a queue poll lands in its own bucket, never a compile's", async () => {
	const { queuePollKey, QUEUE_KEY_PREFIX, rateLimitKey, formatRateLimitKey } = await import(
		"../src/ratelimit.ts"
	);
	const clientId = "abcd1234-ef56-7890-abcd-ef1234567890";
	const schoolIp = "203.0.113.7";

	assert.equal(QUEUE_KEY_PREFIX, "queue ");
	assert.notEqual(queuePollKey(clientId, schoolIp), rateLimitKey(clientId, schoolIp));
	assert.notEqual(queuePollKey(clientId, schoolIp), formatRateLimitKey(clientId, schoolIp));
	assert.notEqual(queuePollKey(null, schoolIp), rateLimitKey(null, schoolIp));
});

test("the poll ceilings are loose enough for a whole class waiting", async () => {
	const { QUEUE_POLL_MAX, GLOBAL_QUEUE_POLL_MAX_PER_MINUTE, GLOBAL_COMPILE_MAX_PER_MINUTE } =
		await import("../src/ratelimit.ts");

	// The page polls every 3 s: 20 a minute per waiting Chromebook.
	assert.ok(QUEUE_POLL_MAX >= 20 * 3, "one Chromebook must have room to spare");
	// Thirty Chromebooks polling at once is 600.
	assert.ok(GLOBAL_QUEUE_POLL_MAX_PER_MINUTE >= 600 * 2, "a whole class must fit, twice over");
	// And it is counted separately from the compiles, not carved out of them.
	assert.ok(GLOBAL_QUEUE_POLL_MAX_PER_MINUTE > GLOBAL_COMPILE_MAX_PER_MINUTE);
});

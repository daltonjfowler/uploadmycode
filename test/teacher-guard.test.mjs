/**
 * The coarse teacher-key guard — the only failure counter left.
 *
 * Run with `npm test`. Node runs src/teacher-guard.ts directly (it strips the
 * types). The clock is always passed in, so a fifteen-minute arming can be
 * walked through in a millisecond.
 *
 * The per-IP lockouts these tests used to cover are gone on purpose: the school
 * egresses through one public address, so any per-IP penalty is a whole-class
 * outage that one student can trigger. What is left below is failure-path only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	GLOBAL_TEACHER_LOCK_MS,
	GLOBAL_TEACHER_MAX_FAILURES,
	GLOBAL_TEACHER_WINDOW_MS,
	minutesPhrase,
	TeacherKeyGuard,
} from "../src/teacher-guard.ts";

/** Wrong keys from `count` different people, one each. */
function spray(guard, count, now) {
	let last;
	for (let i = 0; i < count; i++) last = guard.recordFailure(now);
	return last;
}

test("the numbers are the ones written down in DEPLOY.md", () => {
	assert.equal(GLOBAL_TEACHER_MAX_FAILURES, 100);
	assert.equal(GLOBAL_TEACHER_WINDOW_MS, 900_000);
	assert.equal(GLOBAL_TEACHER_LOCK_MS, 900_000);
});

test("a hundred wrong keys is fine; a hundred and one arms the guard", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	const hundredth = spray(guard, GLOBAL_TEACHER_MAX_FAILURES, start);
	assert.equal(hundredth.locked, false, "'more than 100' means 100 is still under it");

	const next = guard.recordFailure(start);
	assert.equal(next.locked, true);
	assert.equal(next.retryAfterMinutes, 15);
	assert.equal(next.retryAfterSeconds, 900);

	// Every later wrong key, from anybody, is refused by the guard too.
	const someoneElse = guard.recordFailure(start + 60_000);
	assert.equal(someoneElse.locked, true);
	assert.equal(someoneElse.retryAfterMinutes, 14, "counted from when it was armed");
});

test("the guard is only ever consulted on a wrong key, so it cannot lock the teacher out", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	spray(guard, GLOBAL_TEACHER_MAX_FAILURES + 1, start);

	// The whole safety argument is in the shape of this class: `recordFailure`
	// is the ONLY way to get a verdict out of it, and the Worker calls it only
	// after a key has already failed the constant-time compare. There is no
	// method a correct key can ever reach, so no flood — from one address or a
	// thousand — can refuse Dalton with the right key in his hand.
	assert.deepEqual(Object.getOwnPropertyNames(TeacherKeyGuard.prototype).sort(), [
		"constructor",
		"failures",
		"prune",
		"recordFailure",
	]);
});

test("a wrong key while the guard is armed does not push the lift further away", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	spray(guard, GLOBAL_TEACHER_MAX_FAILURES + 1, start);
	// Fifty more angry attempts spread across the arming.
	for (let i = 1; i <= 50; i++) guard.recordFailure(start + i * 1000);

	assert.equal(guard.recordFailure(start + GLOBAL_TEACHER_LOCK_MS).locked, false);
});

test("the guard needs its hundred failures inside fifteen minutes", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	spray(guard, GLOBAL_TEACHER_MAX_FAILURES, start);
	const later = start + GLOBAL_TEACHER_WINDOW_MS + 1;

	// The old hundred have aged out, so this is number one again.
	assert.equal(guard.recordFailure(later).locked, false);
	assert.equal(guard.failures, 1);
});

test("the guard lifts on time and starts counting over", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	spray(guard, GLOBAL_TEACHER_MAX_FAILURES + 1, start);

	// One millisecond early.
	const early = guard.recordFailure(start + GLOBAL_TEACHER_LOCK_MS - 1);
	assert.equal(early.locked, true);
	assert.equal(early.retryAfterSeconds, 1, "never rounds down to zero");
	assert.equal(early.retryAfterMinutes, 1, "and never says zero minutes");

	// And on the millisecond.
	const done = start + GLOBAL_TEACHER_LOCK_MS;
	assert.equal(guard.recordFailure(done).locked, false, "the guard has lifted");
	assert.equal(guard.failures, 1, "and this was failure number one");

	// One more wrong key does not re-arm it: the count really restarted.
	assert.equal(guard.recordFailure(done).locked, false);
});

test("pruning drops an arming that has lifted and failures that have aged out", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	spray(guard, 10, start);
	guard.prune(start + 1000);
	assert.equal(guard.failures, 10, "still inside the window");

	guard.prune(start + GLOBAL_TEACHER_WINDOW_MS + 1);
	assert.equal(guard.failures, 0);

	spray(guard, GLOBAL_TEACHER_MAX_FAILURES + 1, start);
	guard.prune(start + 1000);
	assert.equal(guard.failures, GLOBAL_TEACHER_MAX_FAILURES + 1, "armed, so nothing is dropped");
	guard.prune(start + GLOBAL_TEACHER_LOCK_MS);
	assert.equal(guard.failures, 0);
});

test("a flood cannot grow the list without bound", () => {
	const guard = new TeacherKeyGuard();
	const start = 1_000_000;

	for (let i = 0; i < 10_000; i++) guard.recordFailure(start + i);

	// Once armed the guard stops counting, so the list stops at the failure
	// that armed it. Ten thousand wrong keys cost 101 numbers of memory.
	assert.equal(guard.failures, GLOBAL_TEACHER_MAX_FAILURES + 1);
});

test("the minutes are spelled the way a person would say them", () => {
	assert.equal(minutesPhrase({ retryAfterMinutes: 1 }), "1 minute");
	assert.equal(minutesPhrase({ retryAfterMinutes: 2 }), "2 minutes");
	assert.equal(minutesPhrase({ retryAfterMinutes: 15 }), "15 minutes");
});

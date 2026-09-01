/**
 * The wrong-key and wrong-phrase lockouts.
 *
 * Run with `npm test`. Node runs src/lockout.ts directly (it strips the types).
 * The clock is always passed in, so a fifteen-minute lock can be walked through
 * in a millisecond.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	FailureLockout,
	GLOBAL_TEACHER_LOCK_MS,
	GLOBAL_TEACHER_MAX_FAILURES,
	GLOBAL_TEACHER_WINDOW_MS,
	LOCKOUT_POLICIES,
	minutesPhrase,
} from "../src/lockout.ts";

const TEACHER = LOCKOUT_POLICIES["teacher-key"];
const PHRASE = LOCKOUT_POLICIES["class-phrase"];

/** The policies the docs and the messages promise. */
test("the policies are the ones written down in DEPLOY.md", () => {
	assert.deepEqual(TEACHER, { maxFailures: 5, windowMs: 900_000, lockMs: 900_000 });
	assert.deepEqual(PHRASE, { maxFailures: 10, windowMs: 600_000, lockMs: 600_000 });
	assert.equal(GLOBAL_TEACHER_MAX_FAILURES, 100);
	assert.equal(GLOBAL_TEACHER_WINDOW_MS, 900_000);
	assert.equal(GLOBAL_TEACHER_LOCK_MS, 900_000);
});

// ----------------------------------------------------------------- per-IP lock

test("five wrong teacher keys lock the sixth attempt for fifteen minutes", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < TEACHER.maxFailures; i++) {
		// Every wrong key inside the allowance is answered the same way: the
		// per-IP lock never fires on the request that trips it.
		const answer = lockout.recordFailure("teacher-key", "203.0.113.5", start + i * 1000);
		assert.equal(answer.locked, false, `key ${i + 1} is answered as a plain refusal`);
		if (i < TEACHER.maxFailures - 1) {
			assert.equal(lockout.check("teacher-key", "203.0.113.5", start + i * 1000).locked, false);
		}
	}

	const sixth = lockout.check("teacher-key", "203.0.113.5", start + 5000);
	assert.equal(sixth.locked, true);
	assert.equal(sixth.scope, "ip");
	assert.equal(sixth.retryAfterMinutes, 15);
	assert.equal(sixth.retryAfterSeconds, 900 - 1, "measured from the fifth failure");
});

test("ten wrong phrases lock the eleventh attempt for ten minutes", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < PHRASE.maxFailures; i++) {
		lockout.recordFailure("class-phrase", "198.51.100.7", start);
		assert.equal(
			lockout.check("class-phrase", "198.51.100.7", start).locked,
			i === PHRASE.maxFailures - 1,
			`after ${i + 1} wrong phrases`,
		);
	}

	const eleventh = lockout.check("class-phrase", "198.51.100.7", start);
	assert.equal(eleventh.locked, true);
	assert.equal(eleventh.scope, "ip");
	assert.equal(eleventh.retryAfterMinutes, 10);
	assert.equal(eleventh.retryAfterSeconds, 600);
});

test("failures older than the window do not count toward the lock", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	// Four wrong keys, then nothing for a quarter of an hour.
	for (let i = 0; i < 4; i++) lockout.recordFailure("teacher-key", "ip", start);

	const later = start + TEACHER.windowMs + 1;
	lockout.recordFailure("teacher-key", "ip", later);
	assert.equal(
		lockout.check("teacher-key", "ip", later).locked,
		false,
		"the four old ones have aged out; this is failure number one",
	);

	// And it really is one, not five: four more are needed to lock.
	for (let i = 0; i < 3; i++) lockout.recordFailure("teacher-key", "ip", later);
	assert.equal(lockout.check("teacher-key", "ip", later).locked, false);
	lockout.recordFailure("teacher-key", "ip", later);
	assert.equal(lockout.check("teacher-key", "ip", later).locked, true);
});

test("the lock lifts on time, and the count starts over with it", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < TEACHER.maxFailures; i++) lockout.recordFailure("teacher-key", "ip", start);

	// One millisecond early.
	const early = lockout.check("teacher-key", "ip", start + TEACHER.lockMs - 1);
	assert.equal(early.locked, true);
	assert.equal(early.retryAfterSeconds, 1, "never rounds down to zero");
	assert.equal(early.retryAfterMinutes, 1, "and never says zero minutes");

	// And on the millisecond.
	const done = start + TEACHER.lockMs;
	assert.equal(lockout.check("teacher-key", "ip", done).locked, false);

	// The next mistake is failure number one, not number six.
	lockout.recordFailure("teacher-key", "ip", done);
	assert.equal(lockout.check("teacher-key", "ip", done).locked, false);
});

test("hammering a locked door does not push the unlock further away", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < TEACHER.maxFailures; i++) lockout.recordFailure("teacher-key", "ip", start);
	// The Worker refuses these before comparing anything, but even if one slips
	// through the record, the lock must not grow.
	for (let i = 1; i <= 50; i++) lockout.recordFailure("teacher-key", "ip", start + i * 1000);

	assert.equal(lockout.check("teacher-key", "ip", start + TEACHER.lockMs).locked, false);
});

test("a right answer forgets that address's failures", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < TEACHER.maxFailures - 1; i++) {
		lockout.recordFailure("teacher-key", "ip", start);
	}
	lockout.clear("teacher-key", "ip");
	assert.equal(lockout.size, 0);

	// Four more wrong keys still do not lock: the count really did reset.
	for (let i = 0; i < TEACHER.maxFailures - 1; i++) {
		lockout.recordFailure("teacher-key", "ip", start);
	}
	assert.equal(lockout.check("teacher-key", "ip", start).locked, false);
});

test("a new class phrase forgives every address's wrong old ones", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	// A school leaves through one address, so the class shares one bucket: the
	// phrase expires mid-period and ten stale tabs lock the room out.
	for (let i = 0; i < PHRASE.maxFailures; i++) lockout.recordFailure("class-phrase", "school", start);
	assert.equal(lockout.check("class-phrase", "school", start).locked, true);
	// Somebody at home is in the same state.
	for (let i = 0; i < PHRASE.maxFailures; i++) lockout.recordFailure("class-phrase", "home", start);

	// The teacher sets a new phrase. Guesses at a phrase that is no longer the
	// phrase are not evidence of anything.
	lockout.clearKind("class-phrase");
	assert.equal(lockout.check("class-phrase", "school", start).locked, false);
	assert.equal(lockout.check("class-phrase", "home", start).locked, false);
	assert.equal(lockout.size, 0);
});

test("setting a phrase does not forgive wrong teacher keys", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < TEACHER.maxFailures; i++) lockout.recordFailure("teacher-key", "guesser", start);
	lockout.recordFailure("class-phrase", "guesser", start);

	lockout.clearKind("class-phrase");
	assert.equal(lockout.check("teacher-key", "guesser", start).locked, true, "still locked");
	assert.equal(lockout.size, 1);
});

test("the two kinds and the two addresses are counted apart", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < TEACHER.maxFailures; i++) lockout.recordFailure("teacher-key", "ip", start);

	assert.equal(lockout.check("teacher-key", "ip", start).locked, true);
	assert.equal(
		lockout.check("class-phrase", "ip", start).locked,
		false,
		"a wrong key is not a wrong phrase",
	);
	assert.equal(
		lockout.check("teacher-key", "other-ip", start).locked,
		false,
		"and it is not the next person's problem",
	);

	// Clearing one kind leaves the other alone.
	for (let i = 0; i < PHRASE.maxFailures; i++) lockout.recordFailure("class-phrase", "ip", start);
	lockout.clear("class-phrase", "ip");
	assert.equal(lockout.check("class-phrase", "ip", start).locked, false);
	assert.equal(lockout.check("teacher-key", "ip", start).locked, true);
});

// ------------------------------------------------------------- coarse guard

/** Wrong keys from `count` different addresses, one each. */
function spray(lockout, count, now) {
	let last;
	for (let i = 0; i < count; i++) last = lockout.recordFailure("teacher-key", "bot-" + i, now);
	return last;
}

test("a hundred wrong keys from everywhere is fine; a hundred and one arms the guard", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	const hundredth = spray(lockout, GLOBAL_TEACHER_MAX_FAILURES, start);
	assert.equal(hundredth.locked, false, "'more than 100' means 100 is still under it");

	const next = lockout.recordFailure("teacher-key", "bot-100", start);
	assert.equal(next.locked, true);
	assert.equal(next.scope, "global");
	assert.equal(next.retryAfterMinutes, 15);

	// Every later wrong key, from any address, is refused by the guard too.
	const someoneElse = lockout.recordFailure("teacher-key", "203.0.113.9", start + 60_000);
	assert.equal(someoneElse.locked, true);
	assert.equal(someoneElse.scope, "global");
	assert.equal(someoneElse.retryAfterMinutes, 14, "counted from when it was armed");
});

test("the coarse guard never blocks the correct key", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	spray(lockout, GLOBAL_TEACHER_MAX_FAILURES + 1, start);

	// The Worker asks `check` BEFORE it compares the key, and `check` knows
	// nothing about the coarse guard. That is what lets Dalton walk in with the
	// right key in the middle of the flood: the guard is only ever consulted on
	// the failure path, so an attacker cannot lock the teacher out.
	const dalton = lockout.check("teacher-key", "school-ip", start + 1000);
	assert.equal(dalton.locked, false);
	assert.equal(dalton.scope, "none");

	// Even an address that took part, as long as it stayed under five tries.
	assert.equal(lockout.check("teacher-key", "bot-3", start + 1000).locked, false);
	// But five tries from one address is still five tries.
	for (let i = 0; i < TEACHER.maxFailures; i++) lockout.recordFailure("teacher-key", "bot-3", start);
	assert.equal(lockout.check("teacher-key", "bot-3", start).scope, "ip");
});

test("the coarse guard needs its hundred failures inside fifteen minutes", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	spray(lockout, GLOBAL_TEACHER_MAX_FAILURES, start);
	const later = start + GLOBAL_TEACHER_WINDOW_MS + 1;

	// The old hundred have aged out, so this is number one again.
	const answer = lockout.recordFailure("teacher-key", "bot-100", later);
	assert.equal(answer.locked, false);
});

test("the coarse guard lifts after fifteen minutes and starts counting over", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	spray(lockout, GLOBAL_TEACHER_MAX_FAILURES + 1, start);
	const done = start + GLOBAL_TEACHER_LOCK_MS;

	const after = lockout.recordFailure("teacher-key", "someone", done);
	assert.equal(after.locked, false, "the guard has lifted");

	// And one more wrong key does not re-arm it: the count restarted.
	assert.equal(lockout.recordFailure("teacher-key", "someone-else", done).locked, false);
});

test("wrong phrases never arm the teacher guard", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	for (let i = 0; i < 500; i++) {
		const answer = lockout.recordFailure("class-phrase", "student-" + i, start);
		assert.equal(answer.locked, false);
		assert.equal(answer.scope, "none");
	}
	assert.equal(lockout.check("teacher-key", "anyone", start).locked, false);
});

// ------------------------------------------------------------------ upkeep

test("pruning drops locks that have lifted and failures that have aged out", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	lockout.recordFailure("class-phrase", "quiet", start);
	for (let i = 0; i < TEACHER.maxFailures; i++) lockout.recordFailure("teacher-key", "loud", start);
	assert.equal(lockout.size, 2);

	// Still inside both windows: nothing to drop.
	lockout.prune(start + 1000);
	assert.equal(lockout.size, 2);

	// The single phrase failure ages out first.
	lockout.prune(start + PHRASE.windowMs + 1);
	assert.equal(lockout.size, 1);

	// Then the teacher lock lifts.
	lockout.prune(start + TEACHER.lockMs);
	assert.equal(lockout.size, 0);
});

test("a spray of addresses cannot grow the map without bound", () => {
	const lockout = new FailureLockout();
	const start = 1_000_000;

	// Well past the internal sweep threshold, all of it long expired.
	for (let i = 0; i < 600; i++) lockout.recordFailure("class-phrase", "spray-" + i, start);
	lockout.recordFailure("class-phrase", "one-more", start + PHRASE.windowMs + 1);

	assert.equal(lockout.size, 1, "the sweep took the stale entries with it");
});

test("the minutes are spelled the way a person would say them", () => {
	assert.equal(minutesPhrase({ retryAfterMinutes: 1 }), "1 minute");
	assert.equal(minutesPhrase({ retryAfterMinutes: 2 }), "2 minutes");
	assert.equal(minutesPhrase({ retryAfterMinutes: 15 }), "15 minutes");
});

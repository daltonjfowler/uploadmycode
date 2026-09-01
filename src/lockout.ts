/**
 * Failure lockouts for the two things a stranger can guess: the teacher key and
 * the class phrase.
 *
 * The rate limiter next door (src/ratelimit.ts) counts compiles, which is about
 * the bill. This counts WRONG ANSWERS, which is about the lock. Without it a
 * guesser can try a phrase as fast as the network allows, because a wrong
 * phrase is refused before the compile limiter ever sees it, and a wrong
 * teacher key costs only the fixed 300 ms delay.
 *
 * Policies, per (kind, IP):
 *
 *   teacher-key    5 wrong keys in 15 minutes  -> locked 15 minutes
 *   class-phrase  10 wrong phrases in 10 min   -> locked 10 minutes
 *
 * A correct answer forgets that IP's failures. The lock is measured from the
 * failure that tripped it, and a refused request is never counted, so somebody
 * hammering a locked door cannot push their own unlock further away.
 *
 * There is also one coarse guard, for the teacher key only: more than 100 wrong
 * keys from ALL addresses inside 15 minutes locks the teacher endpoint for 15
 * minutes. See `recordFailure` for why that guard can never lock Dalton out.
 *
 * Like the rate limiter this lives in the CompilerContainer Durable Object, the
 * one instance every request already passes through, so the counts are global
 * rather than per isolate. Nothing is written to storage: if the Durable Object
 * is evicted the counts reset, which is the same trade the rate limiter makes.
 * A guesser cannot cause that eviction on demand, and the phrase is still the
 * lock — this is only what makes guessing it slow.
 *
 * Pure apart from the clock, which is always passed in. `test/lockout.test.mjs`
 * runs it directly under `node --test`.
 */

/** The two secrets that get guessed at. */
export type LockoutKind = "teacher-key" | "class-phrase";

export interface LockoutPolicy {
	/** Failures inside the window that trip the lock. */
	maxFailures: number;
	/** How far back failures are counted, in milliseconds. */
	windowMs: number;
	/** How long the lock lasts, measured from the failure that tripped it. */
	lockMs: number;
}

/**
 * Tuned so a class fumbling the phrase off the projector never trips it, while
 * a script gets roughly ten guesses an hour.
 *
 * The phrase is the looser of the two on purpose: thirty students typing a
 * three-word phrase produce real typos, and the phrase changes daily anyway.
 * The teacher key is one long random string typed by one person on one machine,
 * so five wrong tries already means something is off.
 */
export const LOCKOUT_POLICIES: Record<LockoutKind, LockoutPolicy> = {
	"teacher-key": { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
	"class-phrase": { maxFailures: 10, windowMs: 10 * 60_000, lockMs: 10 * 60_000 },
};

/** Wrong keys from every address together that arm the coarse guard. */
export const GLOBAL_TEACHER_MAX_FAILURES = 100;
export const GLOBAL_TEACHER_WINDOW_MS = 15 * 60_000;
export const GLOBAL_TEACHER_LOCK_MS = 15 * 60_000;

/**
 * Sweep once the map grows past this. A school is tens of addresses, so in
 * normal use this never fires; it is here so a long-lived Durable Object facing
 * a spray of addresses cannot grow without bound.
 */
const SWEEP_ABOVE_KEYS = 512;

/** Which guard said no. "none" when nothing did. */
export type LockScope = "none" | "ip" | "global";

export interface LockVerdict {
	locked: boolean;
	scope: LockScope;
	/** Seconds until the caller may try again. 0 when not locked. */
	retryAfterSeconds: number;
	/** The same wait in whole minutes, never 0 while locked. For the message. */
	retryAfterMinutes: number;
}

/** What one (kind, IP) pair has been up to. */
interface Failures {
	/** Timestamps still inside the window, oldest first. */
	at: number[];
	/** Unix ms the lock ends, or 0 when this pair is not locked. */
	lockedUntil: number;
}

function unlocked(): LockVerdict {
	return { locked: false, scope: "none", retryAfterSeconds: 0, retryAfterMinutes: 0 };
}

function lockedFor(scope: LockScope, until: number, now: number): LockVerdict {
	// Never round down to zero: "try again in 0 minutes" is not an instruction.
	const seconds = Math.max(1, Math.ceil((until - now) / 1000));
	return {
		locked: true,
		scope,
		retryAfterSeconds: seconds,
		retryAfterMinutes: Math.max(1, Math.ceil(seconds / 60)),
	};
}

/** "1 minute" / "14 minutes". The half of a lockout message that varies. */
export function minutesPhrase(verdict: LockVerdict): string {
	const minutes = verdict.retryAfterMinutes;
	return minutes === 1 ? "1 minute" : minutes + " minutes";
}

/** One map for both kinds. A space cannot appear in a kind. */
function entryKey(kind: LockoutKind, ip: string): string {
	return kind + " " + ip;
}

export class FailureLockout {
	/** "kind ip" -> that pair's failures. */
	readonly #entries = new Map<string, Failures>();
	/** Wrong teacher keys from every address, for the coarse guard. */
	#globalTeacherAt: number[] = [];
	/** Unix ms the coarse guard lifts, or 0 when it is not armed. */
	#globalTeacherUntil = 0;

	/**
	 * Is this IP locked out of `kind` right now?
	 *
	 * Asked BEFORE the secret is compared, so a locked address costs nothing: no
	 * KV read, no hashing, no container. It answers on the per-IP lock only —
	 * the coarse teacher guard deliberately does not apply here. See
	 * `recordFailure`.
	 */
	check(kind: LockoutKind, ip: string, now: number): LockVerdict {
		const key = entryKey(kind, ip);
		const entry = this.#entries.get(key);
		if (entry === undefined) return unlocked();

		if (entry.lockedUntil > now) return lockedFor("ip", entry.lockedUntil, now);

		// The lock has run out. Drop the failures with it, so the next mistake
		// starts a fresh count instead of re-locking on the spot.
		if (entry.lockedUntil !== 0) this.#entries.delete(key);
		return unlocked();
	}

	/**
	 * Count one wrong answer from `ip`, and say how THIS request should be
	 * answered.
	 *
	 * The returned verdict is the coarse all-IP guard, and only for
	 * `teacher-key`; for `class-phrase` it is always unlocked. The per-IP lock
	 * this failure may have just tripped is NOT returned: it answers the next
	 * request, through `check`, so every wrong key inside the allowance takes
	 * the identical delay-then-403 path.
	 *
	 * Why the coarse guard is consulted here and not in `check`: `check` runs
	 * BEFORE the key is compared, so a guard applied there would refuse everyone
	 * — including Dalton with the correct key. A hundred wrong keys from a
	 * botnet would then lock the teacher out of his own class, which is exactly
	 * what an attacker wants and costs him nothing. Comparing the key first and
	 * consulting the guard only on the failure path means a correct key always
	 * gets through, while a guesser gets 429 instead of 403 for the next fifteen
	 * minutes no matter how many addresses he sprays from.
	 */
	recordFailure(kind: LockoutKind, ip: string, now: number): LockVerdict {
		const policy = LOCKOUT_POLICIES[kind];
		const key = entryKey(kind, ip);
		const previous = this.#entries.get(key);

		if (previous !== undefined && previous.lockedUntil > now) {
			// Already locked. Do not count it and do not extend the lock: this
			// request was going to be refused anyway, and a lock that grows every
			// time somebody retries never ends.
			return kind === "teacher-key" ? this.#globalGuard(now) : unlocked();
		}

		const cutoff = now - policy.windowMs;
		// A lock that has run out took its failures with it.
		const kept =
			previous === undefined || previous.lockedUntil !== 0
				? []
				: previous.at.filter((at) => at > cutoff);

		kept.push(now);
		this.#entries.set(key, {
			at: kept,
			lockedUntil: kept.length >= policy.maxFailures ? now + policy.lockMs : 0,
		});
		if (this.#entries.size > SWEEP_ABOVE_KEYS) this.prune(now);

		if (kind !== "teacher-key") return unlocked();
		this.#recordGlobalTeacherFailure(now);
		return this.#globalGuard(now);
	}

	/**
	 * A correct answer. This IP starts clean for that kind.
	 *
	 * The coarse teacher guard is left alone on purpose: Dalton getting in does
	 * not mean the botnet has stopped.
	 */
	clear(kind: LockoutKind, ip: string): void {
		this.#entries.delete(entryKey(kind, ip));
	}

	/**
	 * Forget every address's failures for one kind.
	 *
	 * This exists for one moment: the teacher setting a new class phrase. A
	 * whole school usually leaves Cloudflare through one address, so the class
	 * shares one bucket of ten wrong phrases — and the phrase expiring mid-period
	 * is exactly when thirty tabs all send a stale one at once. Without this, the
	 * teacher's fix would not fix anything for another ten minutes. Guesses at a
	 * phrase that is no longer the phrase are not evidence of anything, so they
	 * go in the bin with it.
	 */
	clearKind(kind: LockoutKind): void {
		const prefix = kind + " ";
		for (const key of this.#entries.keys()) {
			if (key.startsWith(prefix)) this.#entries.delete(key);
		}
	}

	/** Drop locks that have lifted and failures that have aged out. */
	prune(now: number): void {
		for (const [key, entry] of this.#entries) {
			if (entry.lockedUntil > now) continue;

			// A lock that has lifted takes its failures with it, so a pair that
			// was ever locked is finished the moment the lock is over.
			const kind = key.slice(0, key.indexOf(" ")) as LockoutKind;
			const cutoff = now - LOCKOUT_POLICIES[kind].windowMs;
			const recent = entry.lockedUntil !== 0 ? [] : entry.at.filter((at) => at > cutoff);

			if (recent.length === 0) this.#entries.delete(key);
			else this.#entries.set(key, { at: recent, lockedUntil: 0 });
		}

		if (this.#globalTeacherUntil !== 0 && this.#globalTeacherUntil <= now) {
			this.#globalTeacherUntil = 0;
			this.#globalTeacherAt = [];
		}
	}

	/** (kind, IP) pairs being tracked. For tests. */
	get size(): number {
		return this.#entries.size;
	}

	/** The coarse guard as it stands. Armed only by wrong teacher keys. */
	#globalGuard(now: number): LockVerdict {
		return this.#globalTeacherUntil > now
			? lockedFor("global", this.#globalTeacherUntil, now)
			: unlocked();
	}

	#recordGlobalTeacherFailure(now: number): void {
		if (this.#globalTeacherUntil > now) return; // Already armed; no need to count.

		if (this.#globalTeacherUntil !== 0) {
			// The last guard has lifted. Start the count over.
			this.#globalTeacherUntil = 0;
			this.#globalTeacherAt = [];
		}

		const cutoff = now - GLOBAL_TEACHER_WINDOW_MS;
		this.#globalTeacherAt = this.#globalTeacherAt.filter((at) => at > cutoff);
		this.#globalTeacherAt.push(now);
		// "More than" 100, so the 101st wrong key is the one that arms it. The
		// list stops growing at that point, which is what keeps it bounded.
		if (this.#globalTeacherAt.length > GLOBAL_TEACHER_MAX_FAILURES) {
			this.#globalTeacherUntil = now + GLOBAL_TEACHER_LOCK_MS;
		}
	}
}

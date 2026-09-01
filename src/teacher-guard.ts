/**
 * The one guard left on the teacher key: a coarse ceiling on WRONG keys, across
 * everybody at once.
 *
 * There used to be per-IP lockouts here — five wrong keys or ten wrong phrases
 * from one address bought that address a quarter of an hour of 429s. They are
 * gone on purpose. A school egresses through ONE public address, so "this IP"
 * and "the whole school" are the same thing, and any per-IP penalty is a
 * shared-fate outage that one bored student can hand to thirty classmates, or
 * to the teacher, in a few clicks. Wrong answers are cheap here anyway: a
 * cached KV read and a hash, with the container never touched. See
 * docs/DEPLOY.md, "Abuse protection".
 *
 * What is left is failure-path only, which is exactly what makes it safe:
 *
 *   more than 100 wrong keys from ALL addresses inside 15 minutes
 *     -> wrong keys are answered 429 for the next 15 minutes
 *     -> a CORRECT key still walks straight in, the whole time
 *
 * The Worker compares the key FIRST and asks this guard only once a key has
 * turned out to be wrong. If the guard ran before the compare it would refuse
 * everyone, so anybody could lock Dalton out of his own class for the price of
 * a hundred junk requests — which is the outcome such an attack is fishing for.
 * Because this guard can only ever refuse a request that was already going to
 * be refused, it cannot cause an outage for anyone who knows the key.
 *
 * It is not what stops a brute force: the key is 192 bits of randomness, and
 * that is what stops a brute force. This only keeps a flood from becoming a
 * bill, and it keeps the 300 ms rejection delay from being a free way to hold
 * Worker requests open.
 *
 * Like the rate limiter it lives in the CompilerContainer Durable Object, the
 * single instance every request already passes through, so the count is
 * site-wide rather than per isolate. Nothing is written to storage: if the
 * object is evicted the count resets, the same trade the rate limiter makes.
 *
 * Pure apart from the clock, which is always passed in.
 * `test/teacher-guard.test.mjs` runs it directly under `node --test`.
 */

/** Wrong keys from every address together that arm the guard. */
export const GLOBAL_TEACHER_MAX_FAILURES = 100;
export const GLOBAL_TEACHER_WINDOW_MS = 15 * 60_000;
export const GLOBAL_TEACHER_LOCK_MS = 15 * 60_000;

export interface GuardVerdict {
	locked: boolean;
	/** Seconds until wrong keys are answered normally again. 0 when not armed. */
	retryAfterSeconds: number;
	/** The same wait in whole minutes, never 0 while armed. For the message. */
	retryAfterMinutes: number;
}

/** "1 minute" / "14 minutes". The half of the message that varies. */
export function minutesPhrase(verdict: { retryAfterMinutes: number }): string {
	const minutes = verdict.retryAfterMinutes;
	return minutes === 1 ? "1 minute" : minutes + " minutes";
}

export class TeacherKeyGuard {
	/** Wrong keys inside the window, oldest first. Cleared when the guard arms. */
	#at: number[] = [];
	/** Unix ms the guard lifts, or 0 when it is not armed. */
	#until = 0;

	/**
	 * Count one wrong key and say how THIS request should be answered.
	 *
	 * Called only after a key has already failed the compare, so a `locked`
	 * verdict never refuses anybody who knows the key.
	 */
	recordFailure(now: number): GuardVerdict {
		if (this.#until > now) {
			// Already armed. Do not count this one and do not push the lift out:
			// this request was going to be refused anyway, and a guard that grows
			// every time somebody retries never ends.
			return this.#verdict(now);
		}

		if (this.#until !== 0) {
			// The last arming has lifted. Start the count over.
			this.#until = 0;
			this.#at = [];
		}

		const cutoff = now - GLOBAL_TEACHER_WINDOW_MS;
		this.#at = this.#at.filter((at) => at > cutoff);
		this.#at.push(now);
		// "More than" 100, so the 101st wrong key is the one that arms it. The
		// list stops growing at that point, which is what keeps it bounded.
		if (this.#at.length > GLOBAL_TEACHER_MAX_FAILURES) {
			this.#until = now + GLOBAL_TEACHER_LOCK_MS;
		}
		return this.#verdict(now);
	}

	/** Drop an arming that has lifted, and wrong keys that have aged out. */
	prune(now: number): void {
		if (this.#until !== 0 && this.#until <= now) {
			this.#until = 0;
			this.#at = [];
			return;
		}
		if (this.#until === 0) {
			const cutoff = now - GLOBAL_TEACHER_WINDOW_MS;
			this.#at = this.#at.filter((at) => at > cutoff);
		}
	}

	/** Wrong keys currently counted. For tests. */
	get failures(): number {
		return this.#at.length;
	}

	#verdict(now: number): GuardVerdict {
		if (this.#until <= now) return { locked: false, retryAfterSeconds: 0, retryAfterMinutes: 0 };

		// Never round down to zero: "try again in 0 minutes" is not an instruction.
		const seconds = Math.max(1, Math.ceil((this.#until - now) / 1000));
		return {
			locked: true,
			retryAfterSeconds: seconds,
			retryAfterMinutes: Math.max(1, Math.ceil(seconds / 60)),
		};
	}
}

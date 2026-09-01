/**
 * A fixed-cost sliding-window rate limiter, kept in memory.
 *
 * Six compiles a minute per IP. A student who is working normally never sees
 * it; a stuck loop, a page left hammering Ctrl-Enter, or somebody who found the
 * phrase does. The point is the bill, not security: the phrase check is the
 * lock, this is the fuse.
 *
 * It lives inside the CompilerContainer Durable Object, which is a single
 * instance (max_instances is 1, one named container), so every compile is
 * counted in one place. If the Durable Object is evicted the counts reset —
 * that is acceptable for a fuse and it is why nothing here writes to storage.
 *
 * Pure apart from the clock, which is always passed in. `test/ratelimit.test.mjs`
 * runs it directly under `node --test`.
 */

/** Compiles allowed per window, per IP. */
export const RATE_LIMIT_MAX = 6;
/** The window, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Sweep every key once the map grows past this. A class is tens of IPs, so in
 * practice this never fires; it exists so a long-lived Durable Object facing a
 * spray of addresses cannot grow without bound.
 */
const SWEEP_ABOVE_KEYS = 512;

export interface RateVerdict {
	allowed: boolean;
	/** Seconds until the caller may try again. 0 when allowed. */
	retryAfterSeconds: number;
}

export class RateLimiter {
	readonly #max: number;
	readonly #windowMs: number;
	/** IP -> timestamps of the hits still inside the window, oldest first. */
	readonly #hits = new Map<string, number[]>();

	constructor(max: number = RATE_LIMIT_MAX, windowMs: number = RATE_LIMIT_WINDOW_MS) {
		this.#max = max;
		this.#windowMs = windowMs;
	}

	/**
	 * Count one attempt.
	 *
	 * A refused attempt is NOT recorded, so hammering the button cannot push the
	 * unlock further away; the wait is always measured from the oldest hit that
	 * actually went through.
	 */
	check(key: string, now: number): RateVerdict {
		const cutoff = now - this.#windowMs;
		const recent = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);

		if (recent.length >= this.#max) {
			this.#hits.set(key, recent);
			const oldest = recent[0]!;
			const waitMs = oldest + this.#windowMs - now;
			return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
		}

		recent.push(now);
		this.#hits.set(key, recent);
		if (this.#hits.size > SWEEP_ABOVE_KEYS) this.prune(now);
		return { allowed: true, retryAfterSeconds: 0 };
	}

	/** Drop everything older than the window, and any key left with nothing. */
	prune(now: number): void {
		const cutoff = now - this.#windowMs;
		for (const [key, times] of this.#hits) {
			const recent = times.filter((at) => at > cutoff);
			if (recent.length === 0) this.#hits.delete(key);
			else this.#hits.set(key, recent);
		}
	}

	/** Keys currently being tracked. For tests. */
	get size(): number {
		return this.#hits.size;
	}
}

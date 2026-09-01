/**
 * A fixed-cost sliding-window rate limiter, kept in memory, used twice.
 *
 *   per client   6 compiles a minute, keyed by the browser's own client id
 *   everybody   120 compile requests a minute, all clients together
 *
 * Both are about the bill, not security: the class phrase is the lock, these
 * are the fuse. A student working normally never sees either; a stuck loop, a
 * page left hammering Ctrl-Enter, or a script that has the phrase does.
 *
 * Why a client id rather than an IP: a school leaves Cloudflare through ONE
 * public address, so a per-IP budget of six a minute is six a minute for the
 * whole class. The browser mints a random id once and keeps it in
 * localStorage (web/src/storage.ts), so each Chromebook gets its own six.
 *
 * A client id is not a credential and is not treated as one. Anyone can mint a
 * fresh one per request and walk around the per-client limit — which is why the
 * ceiling below exists, and why the phrase, not this, is what keeps strangers
 * out. A request with no usable id falls back to a per-IP bucket, which is
 * right for curl and for anything that is not the editor.
 *
 * Both limiters live inside the CompilerContainer Durable Object, which is a
 * single instance (max_instances is 1, one named container), so every compile
 * is counted in one place. If the Durable Object is evicted the counts reset —
 * acceptable for a fuse, and it is why nothing here writes to storage.
 *
 * Pure apart from the clock, which is always passed in. `test/ratelimit.test.mjs`
 * runs it directly under `node --test`.
 */

/** Compiles allowed per window, per client id. */
export const RATE_LIMIT_MAX = 6;
/** The window, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * The bill guard: compile requests a minute from EVERYONE together, counted
 * after the phrase check.
 *
 * This is not a security control — the phrase is — and it is not tuned to any
 * attacker. It is here so that a runaway script, a bug in the page, or a phrase
 * that leaked cannot quietly run up a container bill overnight.
 *
 * Know the headroom before relying on it: thirty students compiling twice a
 * minute is 60, and thirty students compiling four times a minute is exactly
 * 120. A class in a debugging frenzy is the one plausible way to meet this. If
 * that ever happens, RAISE the number — it is a bill guard, not a boundary.
 */
export const GLOBAL_COMPILE_MAX_PER_MINUTE = 120;

/** The single bucket the ceiling counts into. Not an id anyone can send. */
export const GLOBAL_COMPILE_KEY = "everyone";

/**
 * Sweep every key once the map grows past this. A class is tens of clients, so
 * in practice this never fires; it exists so a long-lived Durable Object facing
 * a spray of ids cannot grow without bound.
 */
const SWEEP_ABOVE_KEYS = 512;

/**
 * What we will accept as a client id: a `crypto.randomUUID()` fits, and so does
 * anything else short, printable and boring. Validated because it becomes a map
 * key inside the Durable Object, so it must not be attacker-shaped or unbounded.
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export interface RateVerdict {
	allowed: boolean;
	/** Seconds until the caller may try again. 0 when allowed. */
	retryAfterSeconds: number;
}

/**
 * The bucket one compile is counted into.
 *
 * A usable `x-client-id` gets its own bucket; anything else — no header, a
 * malformed one, curl — shares a per-IP bucket with everything else from that
 * address. The two are prefixed apart so a hand-written id can never land in
 * somebody's IP bucket, or vice versa.
 */
export function rateLimitKey(clientId: string | null | undefined, ip: string): string {
	if (typeof clientId === "string" && CLIENT_ID_PATTERN.test(clientId)) {
		return "client " + clientId;
	}
	return "anon " + (ip === "" ? "unknown" : ip);
}

export class RateLimiter {
	readonly #max: number;
	readonly #windowMs: number;
	/** Bucket -> timestamps of the hits still inside the window, oldest first. */
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

/**
 * Who is waiting for the compiler, and in what order.
 *
 * One compile runs at a time (container/server.js serialises them on a quarter
 * of a vCPU), so a class that all presses Compile at once forms a line. Five at
 * once, measured on the live site: 6.8 s, 13.6 s, 21.2 s, 28.3 s, 35.4 s. Every
 * one of them succeeded — a student standing in line is not failing — but the
 * page had nothing to say about it, so the fifth student watched `Compiling…`
 * for half a minute with no way to tell the difference between a queue and a
 * broken site. This is what lets the page say "3 sketches ahead of you".
 *
 * The Worker adds a token before it forwards a compile and removes it when the
 * answer comes back, so what is counted here is exactly the set of compiles in
 * flight. It is a HINT, not a promise: the real queue is the one inside the
 * container, ordering is by arrival at the Durable Object rather than at
 * avr-gcc, and if the Durable Object is evicted the line is forgotten and the
 * page quietly stops showing a position. Nothing depends on it being right —
 * the compile itself is unaffected either way.
 *
 * Formats are deliberately NOT tracked. clang-format has its own small
 * allowance in the container and finishes in milliseconds; it never forms a
 * line worth reporting.
 *
 * Pure apart from the clock, which is always passed in. `test/queue.test.mjs`
 * runs it directly under `node --test`.
 */

/**
 * What we will accept as a compile token: the same shape as a client id, which
 * is what `crypto.randomUUID()` produces. Validated because it becomes a key
 * inside a long-lived Durable Object, so it must not be attacker-shaped or
 * unbounded.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** True if `token` is safe to track. Anything else is ignored, never refused. */
export function isUsableToken(token: string | null | undefined): token is string {
	return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/**
 * How long a token may sit in the line before it is assumed lost.
 *
 * A compile is killed at 60 seconds, and the Worker removes its own token in a
 * `finally`, so a token older than this means the Worker never got to run that
 * `finally` — an isolate that went away mid-request. Sweeping them is what
 * stops one lost request from adding a phantom to everybody's position for the
 * rest of the day.
 */
export const MAX_WAIT_MS = 120_000;

/**
 * The most tokens tracked at once. A class is tens; this is here so that a
 * spray of made-up tokens cannot grow the object without bound. Over the cap,
 * the oldest goes — it is the one most likely to be a leftover anyway.
 */
const MAX_TRACKED = 256;

export class CompileQueue {
	/** Token -> when it joined. Map keeps insertion order, which IS the order. */
	readonly #waiting = new Map<string, number>();

	/**
	 * Join the line. Returns how many compiles are already ahead, so the caller
	 * can log it without a second round trip.
	 *
	 * Re-entering with a token already in the line keeps the original place
	 * rather than moving to the back: a retried request is not a new student.
	 */
	enter(token: string, now: number): number {
		this.#sweep(now);
		if (!this.#waiting.has(token)) {
			this.#waiting.set(token, now);
			if (this.#waiting.size > MAX_TRACKED) {
				const oldest = this.#waiting.keys().next();
				if (!oldest.done && oldest.value !== token) this.#waiting.delete(oldest.value);
			}
		}
		return this.positionOf(token, now) ?? 0;
	}

	/** Leave the line. Unknown tokens are not an error; the answer arrived. */
	leave(token: string): void {
		this.#waiting.delete(token);
	}

	/**
	 * How many compiles are ahead of this one: 0 means it is the one being
	 * compiled now. `null` means this token is not in the line at all — it
	 * finished, it was never here, or the object was evicted and forgot. The page
	 * treats all three the same way, by saying nothing about a queue.
	 */
	positionOf(token: string, now: number): number | null {
		this.#sweep(now);
		if (!this.#waiting.has(token)) return null;
		let ahead = 0;
		for (const other of this.#waiting.keys()) {
			if (other === token) return ahead;
			ahead += 1;
		}
		return null;
	}

	/** How many compiles are in flight altogether. */
	depth(now: number): number {
		this.#sweep(now);
		return this.#waiting.size;
	}

	/** Drop anything that has been waiting longer than a compile can live. */
	#sweep(now: number): void {
		const cutoff = now - MAX_WAIT_MS;
		for (const [token, joinedAt] of this.#waiting) {
			// Insertion order, so the first token still inside the window ends it.
			if (joinedAt > cutoff) break;
			this.#waiting.delete(token);
		}
	}
}

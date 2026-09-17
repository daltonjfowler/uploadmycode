/**
 * How many compiles are waiting for the compiler.
 *
 * One compile runs at a time (container/server.js serialises them on a quarter
 * of a vCPU), so a class that all presses Compile at once forms a line. Five at
 * once, measured on the live site: 6.8 s, 13.6 s, 21.2 s, 28.3 s, 35.4 s. Every
 * one of them succeeded — a student standing in line is not failing — but the
 * page had nothing to say about it, so the fifth student watched `Compiling…`
 * for half a minute with no way to tell the difference between a queue and a
 * broken site. This is what lets the page say how long the line is.
 *
 * The Worker adds a token before it forwards a compile and removes it when the
 * answer comes back, so what is counted here is exactly the set of compiles in
 * flight — the LENGTH of the line, and whether a given compile is still in it.
 *
 * It deliberately does NOT report a personal place in the line. The first
 * version did, and the live burst test showed the number lying: the order five
 * Worker isolates reach this object in is not the order their requests reach
 * avr-gcc in, so the student who finished last was told "0 ahead of you" for
 * forty-four seconds while the one who finished first was told there were two.
 * Only the container knows its own order, and asking it every three seconds
 * would cost more than the answer is worth. The length of the line is true
 * whatever the order, and it is the part that tells a student the site is busy
 * rather than broken.
 *
 * Even the length is a HINT: if the Durable Object is evicted the line is
 * forgotten and the page quietly goes back to saying nothing about it. Nothing
 * depends on it being right — the compile itself is unaffected either way.
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
 * stops one lost request from adding a phantom to the line for the rest of the
 * day.
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
	 * Join the line. Returns how long the line now is, including this compile,
	 * so the caller can log it without a second round trip.
	 *
	 * Entering twice with the same token counts once: a retried request is not a
	 * second student.
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
		return this.#waiting.size;
	}

	/** Leave the line. Unknown tokens are not an error; the answer arrived. */
	leave(token: string): void {
		this.#waiting.delete(token);
	}

	/**
	 * Is this compile still in the line?
	 *
	 * False covers three things the page treats identically: it has finished, it
	 * was never here, or this object was evicted and forgot. All three mean the
	 * page says nothing about a queue.
	 */
	isWaiting(token: string, now: number): boolean {
		this.#sweep(now);
		return this.#waiting.has(token);
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

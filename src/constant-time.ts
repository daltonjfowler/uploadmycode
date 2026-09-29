/**
 * Comparing secrets without leaking their contents through timing.
 *
 * `===` on strings stops at the first character that differs, so an attacker
 * who can measure the reply can recover a teacher key one character at a time.
 * Both sides are hashed to a fixed 32 bytes with SHA-256 and handed to the
 * runtime's `crypto.subtle.timingSafeEqual`, which is written to take the same
 * time whatever the inputs are. Hashing first also means the lengths always
 * match, which timingSafeEqual requires.
 *
 * Workers-only: `timingSafeEqual` is a Cloudflare extension to SubtleCrypto, so
 * this module is not exercised by the node --test suite.
 */

const encoder = new TextEncoder();

/** Constant-time string equality. Both arguments may be attacker-controlled. */
/** True when `given` equals any of `keys`. Every key is compared, so the time does not say which one. */
export async function anyKeyEquals(given: string, keys: string[]): Promise<boolean> {
	const hits = await Promise.all(keys.map((k) => constantTimeEquals(given, k)));
	return hits.some(Boolean);
}

export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(left, right);
}

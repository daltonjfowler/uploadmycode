/**
 * The rolling class phrase: normalizing it, and the rules for how long one
 * lives.
 *
 * The teacher sets a phrase from /teacher.html; every compile must carry it in
 * an `x-class-phrase` header. Both sides go through `normalizePhrase` before
 * they are compared, so "Blue Robot Pancake" typed on the projector and
 * "blue robot pancake" typed by a student are the same phrase.
 *
 * Pure: no bindings, no clock, no crypto. `test/phrase.test.mjs` runs it
 * directly under `node --test`. The constant-time comparison lives in
 * src/constant-time.ts because it needs the Workers crypto API.
 */

/** KV key holding the current phrase. One phrase at a time, on purpose. */
export const PHRASE_KEY = "phrase";

/**
 * KV's own minimum expirationTtl. Asking for less is an error from KV, so the
 * clamp floor is here rather than at 15 minutes: a 60 s phrase is exactly what
 * the T5 gate needs to watch one expire.
 */
export const MIN_TTL_SECONDS = 60;
/** 12 hours. Longer than a school day, and a phrase should not outlive one. */
export const MAX_TTL_SECONDS = 43200;
/** One class period. Used when a request leaves ttlSeconds out or sends junk. */
export const DEFAULT_TTL_SECONDS = 5400;
/** Long enough for four or five words, short enough to read off a projector. */
export const MAX_PHRASE_LENGTH = 64;
/**
 * The shortest phrase a teacher may SET. A short phrase is a guessable one: a
 * guesser starts with short dictionary words, and "robots" falls to those long
 * before the per-address limit in src/compile-gate.ts has a say. Twelve is
 * "two words and a number" long, and every phrase the teacher page's Generate
 * button makes is longer. Counted once spaces are tidied, like everything here.
 */
export const MIN_PHRASE_LENGTH = 12;

/** What the teacher endpoint stores in KV under PHRASE_KEY. */
export interface PhraseRecord {
	/** Already normalized. Never compare against a raw string. */
	phrase: string;
	/** Unix ms. Checked on read as well as by KV's own expiry. */
	expiresAt: number;
}

/**
 * Trim, lowercase, collapse every run of whitespace to one space.
 *
 * Anything that is not a string becomes "", which is never a valid phrase, so
 * a missing header and a blank header take the same path.
 */
export function normalizePhrase(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether a teacher may set this phrase: long enough not to be guessed, short
 * enough to read off a projector. Only the teacher endpoint asks this.
 */
export function isUsablePhrase(normalized: string): boolean {
	return normalized.length >= MIN_PHRASE_LENGTH && normalized.length <= MAX_PHRASE_LENGTH;
}

/**
 * Whether a phrase already in KV still counts. Looser than `isUsablePhrase` on
 * purpose: a short phrase set before the twelve-character rule existed keeps
 * working until it expires (twelve hours at most), rather than refusing a
 * class mid-lesson on the morning the rule is deployed.
 */
function isStoredPhrase(normalized: string): boolean {
	return normalized.length > 0 && normalized.length <= MAX_PHRASE_LENGTH;
}

/**
 * Pull a lifetime out of the request body and force it into range.
 *
 * Missing or unreadable becomes one class period rather than an error: the
 * response echoes the expiry back, so the teacher page always shows what
 * actually happened.
 */
export function clampTtlSeconds(raw: unknown): number {
	// null, undefined and "" all become 0 under Number(), and 0 is not a ttl a
	// teacher asked for. Only a number, or a string with a number in it, counts.
	const asked =
		typeof raw === "number"
			? raw
			: typeof raw === "string" && raw.trim() !== ""
				? Number(raw)
				: Number.NaN;
	if (!Number.isFinite(asked)) return DEFAULT_TTL_SECONDS;
	return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(asked)));
}

/**
 * Read back what KV returned.
 *
 * KV expiry is eventually consistent and a read can be served from a location
 * cache for up to 60 seconds, so the Worker must not trust the key's absence to
 * mean "expired". `expiresAt` is the real deadline and it is checked here.
 */
export function activeRecord(value: unknown, now: number): PhraseRecord | null {
	if (typeof value !== "object" || value === null) return null;

	const record = value as { phrase?: unknown; expiresAt?: unknown };
	const phrase = normalizePhrase(record.phrase);
	if (!isStoredPhrase(phrase)) return null;
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
	if (now >= record.expiresAt) return null;

	return { phrase, expiresAt: record.expiresAt };
}

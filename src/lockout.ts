/**
 * A short, growing lockout on wrong guesses, per DEVICE and per secret: one
 * counter for the class phrase, a separate one for the teacher key.
 *
 *   5 wrong in a row from one device   -> that device waits 5 s
 *   each further wrong try after that  -> the wait doubles: 10, 20, 40, 80, 160
 *   and never more than                -> 300 s
 *   a correct answer from that device  -> the counter is cleared
 *
 * A device is the random id every page keeps in localStorage ("umc.device")
 * and sends as `x-device-id`. Keyed per device, not per address, because the
 * school shares ONE public address: a per-address lock would let one student
 * lock out the whole room, or the teacher (Dalton, 2026-09-28: "I don't want
 * kids to lock it"). A student who fumbles only locks their own Chromebook. A
 * request with no usable id (a script, curl) falls back to its address, which
 * is the case the lockout is for: brute force from outside.
 *
 * While an address is locked every try is refused WITHOUT being compared, so a
 * guesser learns nothing during the wait. Tries refused while locked are not
 * counted, so hammering the button does not push the end of the wait out.
 *
 * A script can mint a fresh id per request and dodge the device counter; the
 * per-address brake in src/compile-gate.ts and the site-wide teacher-key guard
 * are still there for that, unchanged.
 *
 * Stored in the Cache API (caches.default), not KV: free, no write quota, and
 * per Cloudflare location is fine because one device reaches one location.
 * Every storage call is wrapped: if the cache fails, the lockout falls open and
 * the site behaves exactly as it did before this file existed. A fault in a
 * fuse must never refuse a class that typed the phrase right.
 *
 * The math is pure and the store is passed in, so `test/lockout.test.mjs` runs
 * all of it under `node --test` with an in-memory map.
 */

import { json } from "./http.ts";

/** Which secret a counter belongs to. */
export type LockKind = "phrase" | "teacher";

/** Wrong tries in a row that start the first lock. */
export const LOCK_AFTER_FAILURES = 5;
/** The first lock, in seconds. */
export const FIRST_LOCK_SECONDS = 5;
/** No lock is ever longer than this. */
export const MAX_LOCK_SECONDS = 300;
/** How long a counter is remembered after its last wrong try. */
export const LOCKOUT_MEMORY_SECONDS = 900;

/** What is kept per address and kind. */
export interface LockRecord {
	/** Wrong tries in a row that were actually compared. */
	failures: number;
	/** Unix ms the current lock ends, or 0 when there is none. */
	lockedUntil: number;
}

/** Where records live. The real one is the Cache API; tests use a Map. */
export interface LockoutStore {
	get(key: string): Promise<LockRecord | null>;
	put(key: string, record: LockRecord): Promise<void>;
	delete(key: string): Promise<void>;
}

/** A device id: a UUID, 8-4-4-4-12 hex. Checked strictly because it becomes a cache key. */
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Who a counter belongs to: `device:<uuid>` for a usable `x-device-id`
 * (lowercased), otherwise `ip:<address>`. The prefixes keep the two apart.
 */
export function lockSubject(deviceId: string | null | undefined, ip: string): string {
	const id = typeof deviceId === "string" ? deviceId.trim().toLowerCase() : "";
	if (DEVICE_ID_PATTERN.test(id)) return "device:" + id;
	return "ip:" + (ip === "" ? "unknown" : ip);
}

/** The store key for one subject (see lockSubject) and kind. */
export function lockKey(kind: LockKind, subject: string): string {
	return "https://lockout.internal/" + kind + "/" + encodeURIComponent(subject);
}

/**
 * How long the lock is after this many wrong tries in a row: 0 below five,
 * then 5, 10, 20, 40, 80, 160, 300, 300, ...
 */
export function lockSecondsFor(failures: number): number {
	if (!Number.isFinite(failures) || failures < LOCK_AFTER_FAILURES) return 0;
	const doublings = failures - LOCK_AFTER_FAILURES;
	// 2^7 * 5 is already past the cap, so stop doubling there and never overflow.
	if (doublings >= 7) return MAX_LOCK_SECONDS;
	return Math.min(MAX_LOCK_SECONDS, FIRST_LOCK_SECONDS * 2 ** doublings);
}

/** Seconds left on a lock, never 0 while it is still on. 0 when there is none. */
export function secondsLeft(record: LockRecord | null, now: number): number {
	if (record === null || record.lockedUntil <= now) return 0;
	return Math.max(1, Math.ceil((record.lockedUntil - now) / 1000));
}

/** The record after one more wrong try. Pure. */
export function afterWrong(record: LockRecord | null, now: number): LockRecord {
	const failures = (record?.failures ?? 0) + 1;
	const seconds = lockSecondsFor(failures);
	return { failures, lockedUntil: seconds > 0 ? now + seconds * 1000 : 0 };
}

/** Anything read back from storage that is not a sane record is no record. */
export function parseRecord(value: unknown): LockRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const { failures, lockedUntil } = value as { failures?: unknown; lockedUntil?: unknown };
	if (typeof failures !== "number" || !Number.isFinite(failures) || failures < 0) return null;
	if (typeof lockedUntil !== "number" || !Number.isFinite(lockedUntil)) return null;
	return { failures: Math.floor(failures), lockedUntil };
}

export interface LockState {
	/** What was stored, or null. Kept so a correct answer only clears what exists. */
	record: LockRecord | null;
	/** Seconds until this device may try again. 0 when it may try now. */
	retryAfterSeconds: number;
}

/**
 * Ask before comparing. A store that fails answers "not locked": fall open.
 */
export async function readLock(
	store: LockoutStore,
	kind: LockKind,
	subject: string,
	now: number,
): Promise<LockState> {
	try {
		const record = parseRecord(await store.get(lockKey(kind, subject)));
		return { record, retryAfterSeconds: secondsLeft(record, now) };
	} catch (error) {
		console.error(JSON.stringify({ message: "lockout read failed; not locking", kind, error: String(error) }));
		return { record: null, retryAfterSeconds: 0 };
	}
}

/** Count one compared wrong try. Returns the new record; a store fault is logged and ignored. */
export async function recordWrong(
	store: LockoutStore,
	kind: LockKind,
	subject: string,
	state: LockState,
	now: number,
): Promise<LockRecord> {
	const next = afterWrong(state.record, now);
	try {
		await store.put(lockKey(kind, subject), next);
	} catch (error) {
		console.error(JSON.stringify({ message: "lockout write failed", kind, error: String(error) }));
	}
	return next;
}

/** A correct answer: forget this device's wrong tries, if it had any. */
export async function clearLock(
	store: LockoutStore,
	kind: LockKind,
	subject: string,
	state: LockState,
): Promise<void> {
	if (state.record === null) return;
	try {
		await store.delete(lockKey(kind, subject));
	} catch (error) {
		console.error(JSON.stringify({ message: "lockout clear failed", kind, error: String(error) }));
	}
}

/** The 429 a locked device gets, without its answer ever being compared. */
export function lockedResponse(retryAfterSeconds: number): Response {
	return json(
		429,
		{
			ok: false,
			error: "locked",
			retryAfter: retryAfterSeconds,
			message: "Too many wrong tries. Wait " + retryAfterSeconds + " seconds and try again.",
		},
		{ "retry-after": String(retryAfterSeconds) },
	);
}

/**
 * The real store: caches.default under a synthetic URL. Any failure throws and
 * is caught by the callers above, which fall open. With no Cache API at all
 * (node --test) it quietly remembers nothing. On a workers.dev hostname the
 * Cache API does nothing, so there the lockout is simply off.
 */
export function cacheLockoutStore(): LockoutStore {
	const cache = (): Cache | undefined =>
		(globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
	return {
		async get(key) {
			const hit = await cache()?.match(key);
			return hit === undefined ? null : parseRecord(await hit.json());
		},
		async put(key, record) {
			await cache()?.put(
				key,
				new Response(JSON.stringify(record), {
					headers: {
						"content-type": "application/json",
						"cache-control": "max-age=" + LOCKOUT_MEMORY_SECONDS,
					},
				}),
			);
		},
		async delete(key) {
			await cache()?.delete(key);
		},
	};
}

/** An in-memory store, for tests. */
export function memoryLockoutStore(): LockoutStore & { map: Map<string, LockRecord> } {
	const map = new Map<string, LockRecord>();
	return {
		map,
		async get(key) {
			return map.get(key) ?? null;
		},
		async put(key, record) {
			map.set(key, { ...record });
		},
		async delete(key) {
			map.delete(key);
		},
	};
}

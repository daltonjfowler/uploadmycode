/**
 * Which boards students may compile for, set by the teacher.
 *
 * Arduino UNO is always on. ESP32 is off until a teacher switches it on from
 * /teacher.html, because its compiler is a bigger, dearer container
 * (Esp32Container in src/worker.ts) that should only ever wake for a class
 * that is using it. While it is off the page shows no board picker at all.
 *
 * The ESP32 failsafe (container/esp32-guard.js) refuses Wi-Fi and Bluetooth
 * attack tools such as ESP32 Marauder. A teacher can switch it off for a lesson;
 * that switch always has an expiry, so a forgotten override turns itself back
 * on. Switching ESP32 off also switches the failsafe back on.
 *
 * Stored in KV under BOARDS_KEY with no KV expiry: it is a setting, not a
 * session. KV reads can be up to 60 s stale, so a change can take a minute to
 * reach every compile; the override's expiry is checked against the clock here,
 * so that part is exact.
 *
 * Pure: no bindings, no clock. test/boards.test.mjs runs it directly.
 */

export const BOARDS_KEY = "boards";

export type Board = "uno" | "esp32";

/** What is stored in KV. */
export interface BoardsRecord {
	esp32: boolean;
	/** Unix ms the failsafe override ends; 0 when the failsafe is on. */
	wifiToolsUntil: number;
}

/** What a compile and the teacher page need to know, now. */
export interface BoardSettings {
	esp32: boolean;
	/** True only while ESP32 is on and the override has not expired. */
	allowWifiTools: boolean;
	/** When the override ends (Unix ms), 0 when it is not on. */
	wifiToolsUntil: number;
}

/** Overrides last at most one school day, like a class phrase. */
export const MAX_OVERRIDE_SECONDS = 43200;
export const MIN_OVERRIDE_SECONDS = 60;

/** Read back what KV returned. Anything unreadable means ESP32 off, failsafe on. */
export function boardSettings(value: unknown, now: number): BoardSettings {
	const record = (typeof value === "object" && value !== null ? value : {}) as Partial<BoardsRecord>;
	const esp32 = record.esp32 === true;
	const until = typeof record.wifiToolsUntil === "number" && Number.isFinite(record.wifiToolsUntil) ? record.wifiToolsUntil : 0;
	const allowWifiTools = esp32 && until > now;
	return { esp32, allowWifiTools, wifiToolsUntil: allowWifiTools ? until : 0 };
}

/**
 * The record to store for a teacher's request, or a sentence saying what is
 * wrong with it. `wifiToolsSeconds`: 0 or absent puts the failsafe on; a number
 * of seconds switches it off for that long (clamped to 1 minute .. 12 hours).
 */
export function boardsRecordFor(body: unknown, now: number): BoardsRecord | string {
	if (typeof body !== "object" || body === null) return "Body must be a JSON object.";
	const asked = body as { esp32?: unknown; wifiToolsSeconds?: unknown };
	if (typeof asked.esp32 !== "boolean") return "Say whether ESP32 is on: {\"esp32\": true} or false.";
	const seconds = asked.wifiToolsSeconds === undefined || asked.wifiToolsSeconds === null ? 0 : Number(asked.wifiToolsSeconds);
	if (!Number.isFinite(seconds) || seconds < 0) return "wifiToolsSeconds must be 0 or a number of seconds.";
	if (!asked.esp32 || seconds === 0) return { esp32: asked.esp32, wifiToolsUntil: 0 };
	const clamped = Math.min(MAX_OVERRIDE_SECONDS, Math.max(MIN_OVERRIDE_SECONDS, Math.floor(seconds)));
	return { esp32: true, wifiToolsUntil: now + clamped * 1000 };
}

/** The `x-board` header: absent or "uno" is the UNO, "esp32" is the ESP32, anything else is null. */
export function boardFromHeader(raw: string | null): Board | null {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "" || value === "uno") return "uno";
	if (value === "esp32") return "esp32";
	return null;
}

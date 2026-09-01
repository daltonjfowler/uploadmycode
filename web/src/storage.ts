/**
 * Sketch storage: named sketches in localStorage, nothing on the server.
 *
 * The whole library is one JSON array under one key. A class's worth of
 * sketches is a few tens of kilobytes, so rewriting the array on every save is
 * cheaper than being clever, and it keeps the ordering of the sketch list
 * stable and obvious.
 *
 * Every localStorage call is wrapped: a browser with site data blocked throws
 * on access, and a student should still get a working editor for that session
 * (they just lose autosave). Nothing here is allowed to break the page.
 */

import { BLANK_SKETCH } from "./examples.ts";

const SKETCHES_KEY = "uno-ide.v1.sketches";
const CURRENT_KEY = "uno-ide.v1.current";
const AUTOCOMPLETE_KEY = "uno-ide.v1.autocomplete";

/** Name given to the sketch created on a first visit. */
export const DEFAULT_SKETCH_NAME = "sketch";

export interface Sketch {
	name: string;
	code: string;
}

/** True once a read or write has thrown; the UI can mention it. */
let storageBroken = false;

export function isStorageBroken(): boolean {
	return storageBroken;
}

function readKey(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		storageBroken = true;
		return null;
	}
}

function writeKey(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Quota exceeded or storage blocked. Keep going with what is in memory.
		storageBroken = true;
	}
}

/**
 * Read the library. Anything unparseable is treated as "no sketches yet"
 * rather than thrown, so a corrupted key cannot brick the editor.
 */
export function loadSketches(): Sketch[] {
	const raw = readKey(SKETCHES_KEY);
	if (!raw) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const sketches: Sketch[] = [];
	for (const item of parsed) {
		if (item && typeof item === "object") {
			const { name, code } = item as { name?: unknown; code?: unknown };
			if (typeof name === "string" && name !== "" && typeof code === "string") {
				sketches.push({ name, code });
			}
		}
	}
	return sketches;
}

export function saveSketches(sketches: Sketch[]): void {
	writeKey(SKETCHES_KEY, JSON.stringify(sketches));
}

export function loadCurrentName(): string | null {
	return readKey(CURRENT_KEY);
}

export function saveCurrentName(name: string): void {
	writeKey(CURRENT_KEY, name);
}

export function loadAutocompleteEnabled(): boolean {
	// Default ON: only an explicit "off" turns it off.
	return readKey(AUTOCOMPLETE_KEY) !== "off";
}

export function saveAutocompleteEnabled(enabled: boolean): void {
	writeKey(AUTOCOMPLETE_KEY, enabled ? "on" : "off");
}

/**
 * A name that is not taken yet: "Blink", then "Blink 2", "Blink 3", ...
 * Comparison ignores case, because two sketches called "blink" and "Blink"
 * would be a trap in the dropdown.
 */
export function uniqueName(base: string, sketches: Sketch[]): string {
	const taken = new Set(sketches.map((s) => s.name.toLowerCase()));
	if (!taken.has(base.toLowerCase())) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

/**
 * Trim a name the student typed and refuse the empty string. Returns null when
 * there is nothing usable, so the caller can just do nothing.
 */
export function cleanName(input: string | null): string | null {
	if (input === null) return null;
	const trimmed = input.trim();
	return trimmed === "" ? null : trimmed;
}

/** The library a first-time visitor gets. */
export function starterLibrary(): Sketch[] {
	return [{ name: DEFAULT_SKETCH_NAME, code: BLANK_SKETCH }];
}

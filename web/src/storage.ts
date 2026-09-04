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

/**
 * What a new sketch starts as — the Arduino IDE's own template, character for
 * character. It is the only sketch text this project ships: there is no
 * examples menu, because the code students type or paste comes from the lesson.
 */
export const BLANK_SKETCH = `void setup() {
  // put your setup code here, to run once:

}

void loop() {
  // put your main code here, to run repeatedly:

}`;

const SKETCHES_KEY = "uno-ide.v1.sketches";
const CURRENT_KEY = "uno-ide.v1.current";
const AUTOCOMPLETE_KEY = "uno-ide.v1.autocomplete";
const MONITOR_OPEN_KEY = "uno-ide.v1.monitor-open";
const MONITOR_BAUD_KEY = "uno-ide.v1.monitor-baud";
const MONITOR_VIEW_KEY = "uno-ide.v1.monitor-view";
const CLIENT_ID_KEY = "uno-ide.v1.client-id";

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

export function loadMonitorOpen(): boolean {
	// Default OFF: the monitor panel takes room from the editor, and a student
	// who has never used it should not lose those lines of code on screen.
	return readKey(MONITOR_OPEN_KEY) === "open";
}

export function saveMonitorOpen(open: boolean): void {
	writeKey(MONITOR_OPEN_KEY, open ? "open" : "closed");
}

/**
 * The baud rate last used, or null. The caller checks it against the list it
 * offers, so a hand-edited key cannot put a nonsense rate in the picker.
 */
export function loadMonitorBaud(): number | null {
	const raw = readKey(MONITOR_BAUD_KEY);
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export function saveMonitorBaud(baudRate: number): void {
	writeKey(MONITOR_BAUD_KEY, String(baudRate));
}

/** Whether the monitor panel shows the text or the graph. */
export type MonitorView = "text" | "plot";

/**
 * Which of the two views the panel was left on. Default text: it is what a
 * student who has never pressed Plot is expecting, and a graph of a sketch
 * that prints words is an empty rectangle.
 */
export function loadMonitorView(): MonitorView {
	return readKey(MONITOR_VIEW_KEY) === "plot" ? "plot" : "text";
}

export function saveMonitorView(view: MonitorView): void {
	writeKey(MONITOR_VIEW_KEY, view);
}

/**
 * This browser's compile budget, as a name the server can count against.
 *
 * The Worker allows six compiles a minute per client id. It cannot count them
 * per IP: the whole school leaves through one public address, so thirty
 * students would be sharing six compiles a minute and one runaway tab would
 * starve the room. So each Chromebook mints one random id and keeps it.
 *
 * It is not a secret and it is not a login — it names a bucket, nothing more.
 * The class phrase is what decides whether a compile is allowed at all.
 *
 * localStorage, not sessionStorage: a student who reloads or opens a second tab
 * should keep the same budget rather than quietly getting a fresh one. If
 * storage is blocked the id lives for this page load only, which still gives
 * that machine its own compile and Auto indent budgets for the lesson.
 */
let clientId: string | null = null;

export function loadClientId(): string {
	if (clientId !== null) return clientId;

	const stored = readKey(CLIENT_ID_KEY);
	// Re-check the shape: the Worker refuses anything else and drops the request
	// into the shared per-IP bucket, which is the thing to avoid.
	if (stored !== null && /^[A-Za-z0-9-]{8,64}$/.test(stored)) {
		clientId = stored;
		return clientId;
	}

	clientId = newClientId();
	writeKey(CLIENT_ID_KEY, clientId);
	return clientId;
}

function newClientId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		// randomUUID needs a secure context, which a plain-http dev server is
		// not. Thirty-two hex characters do the same job: this is a bucket name,
		// not a secret, and getRandomValues works everywhere.
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	}
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

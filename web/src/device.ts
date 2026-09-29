/**
 * This browser's device id, sent as `x-device-id` with every request that
 * carries the class phrase.
 *
 * The Worker keys its wrong-guess lockout on it (src/lockout.ts), so a student
 * who types the phrase wrong five times locks only this Chromebook, never the
 * room: the whole school shares one public address. It is not a secret and not
 * a credential. teacher.js and display.js keep the same id under the same key.
 */

/** Shared with web/public/teacher.js and web/public/display.js. */
const DEVICE_KEY = "umc.device";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let deviceId: string | null = null;

function newDeviceId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		// randomUUID needs a secure context (a plain-http dev server is not one).
		// Build the same 8-4-4-4-12 shape from getRandomValues.
		const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
}

/** The id, made once and kept. If storage is blocked, one per page load. */
export function loadDeviceId(): string {
	if (deviceId !== null) return deviceId;
	try {
		const stored = window.localStorage.getItem(DEVICE_KEY);
		if (stored !== null && UUID.test(stored)) {
			deviceId = stored;
			return deviceId;
		}
	} catch {
		// Site data blocked. Fall through to an in-memory id.
	}
	deviceId = newDeviceId();
	try {
		window.localStorage.setItem(DEVICE_KEY, deviceId);
	} catch {
		// Ignored on purpose: the in-memory id still works for this page load.
	}
	return deviceId;
}

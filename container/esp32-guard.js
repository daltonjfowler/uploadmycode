/**
 * The ESP32 failsafe: no Wi-Fi or Bluetooth attack tools from this site.
 *
 * An ESP32 can send raw Wi-Fi frames, which is how firmware like ESP32
 * Marauder knocks people off their network (deauth), floods fake networks
 * (beacon spam) and sniffs other people's traffic (promiscuous mode). None of
 * that belongs in a classroom sketch, so a compile is refused when:
 *
 *   1. the sketch or one of the student's own libraries names one of these
 *      functions or tools (wordProblem): a friendly sentence before compiling;
 *   2. the student's COMPILED code (the sketch's and their own libraries'
 *      object files) defines or calls one of the functions (symbolProblem).
 *      This is the real gate. Macros or token pasting can hide a name from the
 *      text check, but a call is still an undefined reference in the object
 *      file. The linked .elf is not checked: Arduino's own Wi-Fi library links
 *      esp_wifi_set_promiscuous, so every Wi-Fi sketch would be refused.
 *
 * A teacher can switch this off for a lesson (teacher page, with an expiry);
 * the Worker then sends `x-allow-wifi-tools: 1` and server.js skips both checks.
 *
 * This stops attack firmware coming from THIS site. It cannot stop a student
 * flashing it with some other tool on a computer that lets them.
 *
 * No imports, so test/esp32-guard.test.mjs can load it without a server.
 */

/** Functions only attack or sniffing firmware needs. Checked in the text and in the .elf. */
export const BANNED_SYMBOLS = [
	"esp_wifi_80211_tx", // raw frame sender: deauth, beacon and probe floods
	"ieee80211_raw_frame_sanity_check", // what Marauder overrides to send deauth frames
	"esp_wifi_set_promiscuous", // sniff every packet in the air
	"esp_wifi_set_promiscuous_rx_cb",
	"esp_wifi_set_promiscuous_filter",
	"esp_wifi_set_promiscuous_ctrl_filter",
];

/** Names of attack tools, in the sketch, its comments or a library. Text check only. */
const BANNED_WORDS =
	/marauder|deauth|evil[\s_-]?portal|beacon[\s_-]?(?:spam|flood)|probe[\s_-]?(?:spam|flood)|apple[\s_-]?juice|sour[\s_-]?apple|ble[\s_-]?spam|wifi[\s_-]?jam|jammer|pmkid|handshake[\s_-]?(?:capture|sniff)/i;

export const BLOCKED_MESSAGE =
	"This sketch uses Wi-Fi or Bluetooth attack tools (like deauth, beacon spam or packet sniffing). " +
	"They are switched off on this site because they can knock other people off their network. Ask your teacher.";

/**
 * The first refusal for the sketch and the student's own libraries, as an
 * error line the editor can point at, or null.
 * @param {string} code
 * @param {{ name: string, files: { path: string, text: string }[] }[]} libraries
 * @returns {string | null}
 */
export function wordProblem(code, libraries) {
	const hit = (text) => {
		const lower = text.toLowerCase();
		if (BANNED_SYMBOLS.some((s) => lower.includes(s))) return true;
		return BANNED_WORDS.test(text);
	};
	const lines = code.split(/\r\n|\r|\n/);
	for (let i = 0; i < lines.length; i += 1) {
		if (hit(lines[i])) return `sketch.ino:${i + 1}:1: error: ${BLOCKED_MESSAGE}`;
	}
	for (const lib of libraries) {
		if (hit(lib.name)) return `${lib.name}: error: ${BLOCKED_MESSAGE}`;
		for (const file of lib.files) {
			if (hit(file.path) || hit(file.text)) return `${lib.name}/${file.path}: error: ${BLOCKED_MESSAGE}`;
		}
	}
	return null;
}

/**
 * Refusal for a linked program, from `nm` output (one symbol per line,
 * "address type name"), or null when none of the banned functions is in it.
 * @param {string} nmOutput
 * @returns {string | null}
 */
export function symbolProblem(nmOutput) {
	const names = new Set(nmOutput.split(/\r?\n/).map((line) => line.trim().split(/\s+/).pop()));
	return BANNED_SYMBOLS.some((s) => names.has(s)) ? `error: ${BLOCKED_MESSAGE}` : null;
}

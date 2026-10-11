/**
 * ESP32 build buckets: one reused build folder per COMBINATION of libraries.
 *
 * Why not two buckets like the UNO: on the ESP32, each library is compiled with
 * an -I for every other library the sketch uses, so a sketch that adds or drops
 * one library (WiFi, then WiFi + WebServer) recompiles all of them, plus a
 * library scan of every source file. Measured on 1 vCPU: 150-180 s, against
 * 6-16 s for a combination the folder has already seen (and a timed-out first
 * build is not lost: pressing Compile again finished in about 30 s). So each
 * combination gets a folder of its own, the common classroom combinations are
 * built into the image (esp32-warmup.mjs), and at most MAX_BUCKETS are kept,
 * dropping the least recently used.
 *
 * The key is the set of LIBRARIES the sketch includes, not the headers:
 * <WiFi.h> and <WiFiClient.h> are the same library, and a system header such as
 * <esp_wifi.h> or <freertos/task.h> is no library at all, so neither makes a new
 * combination. headerIndex() maps each library's headers to its name; a header
 * it does not know is left out of the key. The student's own libraries are
 * added by name. Only Node built-ins, so tests and the warm-up can load it.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const MAX_BUCKETS = 30;

const INCLUDE = /^[ \t]*(?:#|%:)[ \t]*include[ \t]*[<"]([^>"\r\n]+)[>"]/gm;
const HEADER = /\.(?:h|hh|hpp)$/i;

/**
 * Header file name -> library name, for every installed library: the ESP32
 * core's own (WiFi, WebServer, BLE...) and the ones installed with arduino-cli
 * (ESP32Servo, LiquidCrystal I2C). Built once at start-up.
 * @param {string[]} libraryRoots folders that each hold one folder per library
 * @returns {Map<string, string>}
 */
export function headerIndex(libraryRoots) {
	const index = new Map();
	for (const root of libraryRoots) {
		if (!existsSync(root)) continue;
		for (const lib of readdirSync(root, { withFileTypes: true })) {
			if (!lib.isDirectory()) continue;
			const src = path.join(root, lib.name, "src");
			const base = existsSync(src) ? src : path.join(root, lib.name);
			for (const file of readdirSync(base, { withFileTypes: true })) {
				if (file.isFile() && HEADER.test(file.name) && !index.has(file.name)) index.set(file.name, lib.name);
			}
		}
	}
	return index;
}

/** The library folders of this image, from the same environment arduino-cli reads. */
export function imageLibraryRoots() {
	const data = process.env.ARDUINO_DIRECTORIES_DATA || "";
	const user = process.env.ARDUINO_DIRECTORIES_USER || "";
	const roots = [];
	const cores = path.join(data, "packages", "esp32", "hardware", "esp32");
	if (data && existsSync(cores)) {
		for (const version of readdirSync(cores)) roots.push(path.join(cores, version, "libraries"));
	}
	if (user) roots.push(path.join(user, "libraries"));
	return roots;
}

/**
 * The folder name for this sketch and these libraries.
 * @param {string} code
 * @param {{ name: string }[]} [libraries]
 * @param {Map<string, string> | null} [index] header -> library; null keys by header (tests)
 * @returns {string}
 */
export function esp32Bucket(code, libraries = [], index = null) {
	const names = new Set();
	for (const match of code.matchAll(INCLUDE)) {
		const header = path.posix.basename(match[1].trim().replace(/\\/g, "/"));
		if (index === null) {
			if (header !== "Arduino.h") names.add(header);
		} else {
			const lib = index.get(header);
			if (lib !== undefined) names.add(lib);
		}
	}
	for (const lib of libraries) names.add(`user:${lib.name}`);
	if (names.size === 0) return "plain";
	const key = [...names].sort().join("\n");
	return `set-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * The library combinations warmed into the image: what classroom ESP32 sketches
 * mostly include. Each entry is the #include lines of one combination.
 */
export const WARM_SETS = [
	[],
	["WiFi.h"],
	["WiFi.h", "WebServer.h"],
	["WiFi.h", "HTTPClient.h"],
	["WiFi.h", "WiFiClientSecure.h", "HTTPClient.h"],
	["WiFi.h", "ESPmDNS.h", "WebServer.h"],
	["BluetoothSerial.h"],
	["BLEDevice.h", "BLEServer.h", "BLEUtils.h"],
	["ESP32Servo.h"],
	["Wire.h", "LiquidCrystal_I2C.h"],
	["Wire.h"],
	["Preferences.h"],
	["WiFi.h", "WebServer.h", "ESP32Servo.h"],
];

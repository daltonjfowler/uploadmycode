/**
 * The teacher's board switches (src/boards.ts): ESP32 on/off and the ESP32
 * Wi-Fi safety failsafe override, which must always expire.
 *
 * Run with `npm test`. Node runs src/boards.ts directly (it strips the types).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { boardFromHeader, boardSettings, boardsRecordFor, MAX_OVERRIDE_SECONDS } from "../src/boards.ts";

const NOW = 1_800_000_000_000;

test("nothing stored, or junk, means ESP32 off and the failsafe on", () => {
	for (const value of [null, undefined, "on", 7, {}, { esp32: "yes" }]) {
		assert.deepEqual(boardSettings(value, NOW), { esp32: false, allowWifiTools: false, wifiToolsUntil: 0 });
	}
});

test("ESP32 on with no override keeps the failsafe on", () => {
	assert.deepEqual(boardSettings({ esp32: true, wifiToolsUntil: 0 }, NOW), { esp32: true, allowWifiTools: false, wifiToolsUntil: 0 });
});

test("the override counts only until it expires", () => {
	const until = NOW + 60_000;
	assert.equal(boardSettings({ esp32: true, wifiToolsUntil: until }, NOW).allowWifiTools, true);
	assert.equal(boardSettings({ esp32: true, wifiToolsUntil: until }, until).allowWifiTools, false);
	assert.equal(boardSettings({ esp32: true, wifiToolsUntil: until }, until + 1).wifiToolsUntil, 0);
});

test("an override never counts while ESP32 is off", () => {
	assert.equal(boardSettings({ esp32: false, wifiToolsUntil: NOW + 60_000 }, NOW).allowWifiTools, false);
});

test("teacher requests: on, off, override clamped to a school day", () => {
	assert.deepEqual(boardsRecordFor({ esp32: true }, NOW), { esp32: true, wifiToolsUntil: 0 });
	assert.deepEqual(boardsRecordFor({ esp32: false, wifiToolsSeconds: 3600 }, NOW), { esp32: false, wifiToolsUntil: 0 });
	assert.deepEqual(boardsRecordFor({ esp32: true, wifiToolsSeconds: 3600 }, NOW), { esp32: true, wifiToolsUntil: NOW + 3_600_000 });
	assert.deepEqual(boardsRecordFor({ esp32: true, wifiToolsSeconds: 10 ** 9 }, NOW), {
		esp32: true,
		wifiToolsUntil: NOW + MAX_OVERRIDE_SECONDS * 1000,
	});
	assert.deepEqual(boardsRecordFor({ esp32: true, wifiToolsSeconds: 5 }, NOW), { esp32: true, wifiToolsUntil: NOW + 60_000 });
});

test("teacher requests that make no sense are refused", () => {
	for (const body of [null, "on", {}, { esp32: "true" }, { esp32: true, wifiToolsSeconds: -1 }, { esp32: true, wifiToolsSeconds: "lots" }]) {
		assert.equal(typeof boardsRecordFor(body, NOW), "string");
	}
});

test("x-board: absent or uno is the UNO, esp32 is the ESP32, anything else is refused", () => {
	assert.equal(boardFromHeader(null), "uno");
	assert.equal(boardFromHeader(""), "uno");
	assert.equal(boardFromHeader("UNO"), "uno");
	assert.equal(boardFromHeader(" esp32 "), "esp32");
	assert.equal(boardFromHeader("esp32s3"), null);
	assert.equal(boardFromHeader("mega"), null);
});

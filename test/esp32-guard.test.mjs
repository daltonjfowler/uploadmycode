/**
 * The ESP32 Wi-Fi safety failsafe (container/esp32-guard.js): no deauth,
 * beacon spam, packet sniffing or Marauder-style firmware from this site, while
 * ordinary Wi-Fi classroom sketches still compile.
 *
 * The text check is the friendly first layer; the symbol check on the linked
 * program is the real gate; it was also checked against real compiles in the
 * ESP32 image (a plain Wi-Fi sketch passes, a token-pasted esp_wifi_80211_tx
 * call that slips past the text check is refused).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BLOCKED_MESSAGE, symbolProblem, wordProblem } from "../container/esp32-guard.js";

test("ordinary Wi-Fi, web server and Bluetooth sketches pass", () => {
	const sketches = [
		'#include <WiFi.h>\nvoid setup() { WiFi.begin("school", "pw"); }\nvoid loop() {}',
		'#include <WebServer.h>\nWebServer server(80);\nvoid setup() { WiFi.softAP("ESP32"); server.begin(); }\nvoid loop() { server.handleClient(); }',
		'#include <BluetoothSerial.h>\nBluetoothSerial bt;\nvoid setup() { bt.begin("robot"); }\nvoid loop() {}',
		"int n = WiFi.scanNetworks(); // list nearby networks",
	];
	for (const code of sketches) assert.equal(wordProblem(code, []), null, code);
});

test("raw frame sending, sniffing and the sanity-check override are refused", () => {
	for (const call of [
		"esp_wifi_80211_tx(WIFI_IF_AP, frame, sizeof(frame), false);",
		"esp_wifi_set_promiscuous(true);",
		"esp_wifi_set_promiscuous_rx_cb(&sniffer);",
		'extern "C" int ieee80211_raw_frame_sanity_check(int32_t a, int32_t b, int32_t c) { return 0; }',
	]) {
		const problem = wordProblem(`void setup() {\n  ${call}\n}\nvoid loop() {}`, []);
		assert.ok(problem?.startsWith("sketch.ino:2:1: error: "), call);
		assert.ok(problem.includes(BLOCKED_MESSAGE));
	}
});

test("attack tool names are refused, even in a comment", () => {
	for (const line of ["// ESP32 Marauder port", "void deauthAll() {}", "#define BEACON_SPAM 1", "// evil portal", "bool appleJuice = true;"]) {
		assert.notEqual(wordProblem(line, []), null, line);
	}
});

test("a student's own library is checked too, by name, path and text", () => {
	const lib = (name, path, text) => [{ name, files: [{ path, text }] }];
	assert.match(wordProblem("", lib("Marauder", "a.h", "")) ?? "", /^Marauder: error/);
	assert.match(wordProblem("", lib("Tools", "deauth.cpp", "")) ?? "", /^Tools\/deauth\.cpp: error/);
	assert.match(wordProblem("", lib("Tools", "x.cpp", "esp_wifi_80211_tx(0,0,0,0);")) ?? "", /^Tools\/x\.cpp: error/);
	assert.equal(wordProblem("", lib("Motors", "motor.h", "void spin();")), null);
});

test("the student's compiled code is refused when it calls or defines a banned function", () => {
	const ok = "400d0000 T setup\n400d0010 T loop\n400d0100 T esp_wifi_start\n";
	assert.equal(symbolProblem(ok), null);
	assert.notEqual(symbolProblem(ok + "         U esp_wifi_80211_tx\n"), null);
	assert.notEqual(symbolProblem(ok + "400d2000 T esp_wifi_set_promiscuous\r\n"), null);
	// Only the exact name counts: a longer one that merely contains it is not the function.
	assert.equal(symbolProblem(ok + "400d2000 T my_esp_wifi_80211_tx_wrapper_name\n"), null);
});

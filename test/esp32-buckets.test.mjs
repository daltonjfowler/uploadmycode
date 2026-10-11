/**
 * ESP32 build folders are keyed by the set of LIBRARIES a sketch uses
 * (container/esp32-buckets.js), so the same mix of libraries always lands in
 * the same warm folder however the includes are written.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { esp32Bucket } from "../container/esp32-buckets.js";

const index = new Map([
	["WiFi.h", "WiFi"],
	["WiFiClient.h", "WiFi"],
	["WebServer.h", "WebServer"],
	["ESP32Servo.h", "ESP32Servo"],
]);

test("no library at all is the plain folder", () => {
	assert.equal(esp32Bucket("void setup() {}\nvoid loop() {}", [], index), "plain");
	assert.equal(esp32Bucket("#include <Arduino.h>\n#include <esp_wifi.h>\n#include <freertos/task.h>\n", [], index), "plain");
});

test("headers of the same library, system headers and order do not change the folder", () => {
	const a = esp32Bucket("#include <WiFi.h>\n#include <WebServer.h>\n", [], index);
	assert.equal(esp32Bucket('#include "WebServer.h"\n#include <WiFiClient.h>\n#include <WiFi.h>\n#include <esp_wifi.h>\n', [], index), a);
	assert.match(a, /^set-[0-9a-f]{16}$/);
});

test("a different set of libraries is a different folder", () => {
	const wifi = esp32Bucket("#include <WiFi.h>\n", [], index);
	assert.notEqual(esp32Bucket("#include <WiFi.h>\n#include <ESP32Servo.h>\n", [], index), wifi);
	assert.notEqual(esp32Bucket("#include <WiFi.h>\n", [{ name: "MyLib" }], index), wifi);
});

/**
 * Keeps the Reference dialog's list (web/src/reference.ts) in step with what the
 * compile images really bundle. Fails when:
 *   - a Dockerfile installs a library with no Reference entry for that board,
 *   - a Reference entry names an install line that is gone,
 *   - a Library dropdown entry (libraries.ts) has no UNO Reference entry,
 *   - a header the ESP32 image warms up has no ESP32 Reference entry,
 *   - the ESP32 GitHub links point at a different core than the image installs,
 *   - an entry has no links, a link is not https, or a link is listed twice.
 *
 * It does not fetch the links: that needs the network and a test that fails
 * when a website is down helps nobody. They were checked by hand on 2026-10-29.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { WARM_SETS } from "../../container/esp32-buckets.js";
import { LIBRARIES } from "../src/libraries.ts";
import { ESP32_CORE_VERSION, REFERENCE } from "../src/reference.ts";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

/** The library names in a Dockerfile's `arduino-cli lib install "Name@${VERSION}"` lines. */
function installed(file) {
	return [...read(file).matchAll(/arduino-cli lib install "([^"@]+)@/g)].map((m) => m[1]);
}

const IMAGES = [
	{ file: "container/Dockerfile", board: "uno" },
	{ file: "container/Dockerfile.esp32", board: "esp32" },
];

test("every library a Dockerfile installs has a Reference entry for that board", () => {
	for (const { file, board } of IMAGES) {
		const names = installed(file);
		assert.ok(names.length > 0, `${file}: found no install lines; did their format change?`);
		for (const name of names) {
			assert.ok(
				REFERENCE.some((entry) => entry.board === board && entry.install === name),
				`${file} installs "${name}" but web/src/reference.ts has no ${board} entry with install: "${name}"`,
			);
		}
	}
});

test("every Reference install name is still installed by its board's Dockerfile", () => {
	for (const { file, board } of IMAGES) {
		const names = installed(file);
		for (const entry of REFERENCE.filter((e) => e.board === board && e.install)) {
			assert.ok(names.includes(entry.install), `${entry.name}: "${entry.install}" is not installed by ${file}`);
		}
	}
});

test("every Library dropdown entry has a UNO Reference entry", () => {
	for (const library of LIBRARIES) {
		assert.ok(
			REFERENCE.some((entry) => entry.board === "uno" && entry.header === library.header),
			`${library.header} is in the Library dropdown but not in the Reference`,
		);
	}
});

test("every header the ESP32 image warms up has an ESP32 Reference entry", () => {
	// Headers that belong to a library listed under its main header.
	const SAME_LIBRARY = { "BLEServer.h": "BLEDevice.h", "BLEUtils.h": "BLEDevice.h" };
	for (const header of new Set(WARM_SETS.flat())) {
		const wanted = SAME_LIBRARY[header] ?? header;
		assert.ok(
			REFERENCE.some((entry) => entry.board === "esp32" && entry.header === wanted),
			`the ESP32 image warms up ${header} but the Reference has no ESP32 entry for ${wanted}`,
		);
	}
});

test("the ESP32 GitHub links name the core version the image installs", () => {
	const pinned = read("container/Dockerfile.esp32").match(/^ARG ESP32_CORE_VERSION=(\S+)/m)?.[1];
	assert.equal(ESP32_CORE_VERSION, pinned);
	for (const entry of REFERENCE) {
		for (const link of entry.links) {
			const tag = link.url.match(/github\.com\/espressif\/arduino-esp32\/tree\/([^/]+)\//)?.[1];
			if (tag) assert.equal(tag, pinned, `${entry.name}: ${link.url}`);
		}
	}
});

test("every entry says what it is for and has https links, none twice", () => {
	assert.ok(REFERENCE.some((entry) => entry.board === "any"), "the top section is empty");
	for (const entry of REFERENCE) {
		assert.ok(entry.name.trim() && entry.about.trim(), JSON.stringify(entry));
		assert.ok(["any", "uno", "esp32"].includes(entry.board), entry.name);
		assert.ok(entry.links.length > 0, `${entry.name} has no links`);
		const urls = entry.links.map((link) => link.url);
		assert.equal(new Set(urls).size, urls.length, `${entry.name} lists a link twice`);
		for (const link of entry.links) {
			assert.ok(link.label.trim(), `${entry.name}: a link has no text`);
			assert.match(link.url, /^https:\/\/[^\s"<>]+$/, `${entry.name}: ${link.url}`);
		}
	}
});

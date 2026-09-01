/**
 * The Intel HEX parser, checked against a real compiler artifact.
 *
 * `fixtures/blink.hex` is the exact text `POST /api/compile` returns for Blink
 * — 2615 characters, byte for byte what the live container produced on
 * 2026-09-01. Regenerate it with the README's local compile server, or with:
 *
 *   curl -s -H "content-type: application/json" \
 *        -d '{"code":"void setup(){pinMode(LED_BUILTIN,OUTPUT);}\nvoid loop(){}"}' \
 *        https://uploadmycode.com/api/compile
 *
 * Node runs web/src/flash/intel-hex.ts directly (it strips the types), so this
 * exercises the same file the browser bundle ships.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { HexParseError, parseIntelHex } from "../src/flash/intel-hex.ts";

const BLINK_HEX = readFileSync(join(import.meta.dirname, "fixtures", "blink.hex"), "utf8");

/** The smallest legal hex file: one data byte at 0, then the end record. */
const ONE_BYTE_AT_ZERO = ":01000000AA55";
const END_RECORD = ":00000001FF";

test("parses the real Blink hex into 924 bytes starting 0C 94 5C 00", () => {
	const image = parseIntelHex(BLINK_HEX);

	assert.equal(image.length, 924);
	assert.deepEqual(Array.from(image.slice(0, 4)), [0x0c, 0x94, 0x5c, 0x00]);

	// The file's last record is ":0C039000A1F30E940000F1CFF894FFCF11" — 12 bytes
	// at 0x0390 (912), which is what makes the image exactly 924 long.
	assert.deepEqual(
		Array.from(image.slice(912)),
		[0xa1, 0xf3, 0x0e, 0x94, 0x00, 0x00, 0xf1, 0xcf, 0xf8, 0x94, 0xff, 0xcf],
	);
});

test("catches a damaged checksum and names the line", () => {
	const lines = BLINK_HEX.split(/\r?\n/);
	// Same record, wrong checksum byte: CA -> CB.
	assert.ok(lines[0].endsWith("CA"), "fixture drifted; first record should end CA");
	lines[0] = `${lines[0].slice(0, -2)}CB`;

	assert.throws(
		() => parseIntelHex(lines.join("\n")),
		(error) => {
			assert.ok(error instanceof HexParseError);
			assert.match(error.message, /^Line 1: /);
			assert.match(error.message, /checksum does not match/);
			return true;
		},
	);
});

test("catches a flipped data byte, which is a checksum failure too", () => {
	const lines = BLINK_HEX.split(/\r?\n/);
	// ":100000000C945C00..." -> "...0D945C00...", checksum left alone.
	lines[0] = lines[0].replace(":100000000C", ":100000000D");
	assert.throws(() => parseIntelHex(lines.join("\n")), HexParseError);
});

test("fills the gaps with 0xFF, which is what erased flash reads as", () => {
	// One byte at 0x0004; everything before it is untouched flash.
	const image = parseIntelHex([":010004007A81", END_RECORD].join("\n"));

	assert.equal(image.length, 5);
	assert.deepEqual(Array.from(image), [0xff, 0xff, 0xff, 0xff, 0x7a]);
});

test("honours an extended segment address record", () => {
	// :020000020010EC sets the base to 0x0010 * 16 = 0x0100.
	const image = parseIntelHex([":020000020010EC", ONE_BYTE_AT_ZERO, END_RECORD].join("\n"));

	assert.equal(image.length, 0x101);
	assert.equal(image[0x100], 0xaa);
	assert.equal(image[0], 0xff);
});

test("honours an extended linear address record, and refuses what will not fit", () => {
	// :020000040000FA is base 0, so this one is just a normal little image.
	const atZero = parseIntelHex([":020000040000FA", ONE_BYTE_AT_ZERO, END_RECORD].join("\n"));
	assert.deepEqual(Array.from(atZero), [0xaa]);

	// :020000040001F9 is base 0x10000 — past the end of an Uno's flash.
	assert.throws(
		() => parseIntelHex([":020000040001F9", ONE_BYTE_AT_ZERO, END_RECORD].join("\n")),
		(error) => {
			assert.ok(error instanceof HexParseError);
			assert.match(error.message, /only has 32256/);
			return true;
		},
	);
});

test("refuses text that is not a hex file", () => {
	const cases = [
		["no colon", ["100000000C945C00CA", END_RECORD].join("\n"), /must start with ":"/],
		["odd digits", [":1000000", END_RECORD].join("\n"), /not a whole hex record/],
		["not hex", [":10000000ZZ", END_RECORD].join("\n"), /not a whole hex record/],
		["too short", [":0100", END_RECORD].join("\n"), /too short/],
		["length lies", [":10000000AA55", END_RECORD].join("\n"), /claims 16 data bytes/],
		["unknown type", [":000000FF01", END_RECORD].join("\n"), /record type FF/],
		["no end record", ONE_BYTE_AT_ZERO, /no end-of-file record/],
		["nothing in it", END_RECORD, /no program in it/],
	];

	for (const [name, text, pattern] of cases) {
		assert.throws(
			() => parseIntelHex(text),
			(error) => {
				assert.ok(error instanceof HexParseError, name);
				assert.match(error.message, pattern, name);
				return true;
			},
			name,
		);
	}
});

test("ignores blank lines and trailing junk after the end record", () => {
	const text = ["", ONE_BYTE_AT_ZERO, "", END_RECORD, "", "not a record at all", ""].join("\r\n");
	assert.deepEqual(Array.from(parseIntelHex(text)), [0xaa]);
});

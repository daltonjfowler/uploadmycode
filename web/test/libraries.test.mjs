/**
 * Checks the Library dropdown's one piece of logic: where an #include goes, and
 * when there is nothing to do because one is already there.
 *
 * Run with `npm test`. Node runs web/src/libraries.ts directly (it strips the
 * types), so this tests the exact file the browser bundle uses.
 *
 * On the matcher: it is line-anchored and dumb on purpose. A line counts as an
 * include only when it *starts* with the directive, whitespace aside, so a
 * commented-out include and one inside a string both count as absent — neither
 * compiles anything in. Spacing around `include` and the choice of `<>` or `""`
 * do not matter, and a trailing comment after the header does not either.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findIncludeLine, insertInclude, LIBRARIES } from "../src/libraries.ts";

const SKETCH = `void setup() {
}

void loop() {
}`;

test("an empty sketch gets the include and nothing else", () => {
	const result = insertInclude("", "Servo.h");
	assert.deepEqual(result, { code: "#include <Servo.h>", line: 1 });
});

test("a sketch with no includes gets one at the top, with a blank line under it", () => {
	const result = insertInclude(SKETCH, "Servo.h");
	assert.equal(result.code, `#include <Servo.h>\n\n${SKETCH}`);
	assert.equal(result.line, 1);
	// The sketch itself is untouched, just pushed down.
	assert.equal(result.code.split("\n").slice(2).join("\n"), SKETCH);
});

test("a second include lands after the last one, not before it", () => {
	const code = `#include <Servo.h>\n#include <Wire.h>\n\n${SKETCH}`;
	const result = insertInclude(code, "SPI.h");

	assert.equal(result.line, 3);
	assert.equal(result.code.split("\n")[2], "#include <SPI.h>");
	assert.equal(result.code, `#include <Servo.h>\n#include <Wire.h>\n#include <SPI.h>\n\n${SKETCH}`);
});

test("the reported line is the line the include is actually on", () => {
	const code = `// a comment\n\n#include <Wire.h>\n\n${SKETCH}`;
	const result = insertInclude(code, "SPI.h");

	assert.equal(result.line, 4);
	assert.equal(result.code.split("\n")[result.line - 1], "#include <SPI.h>");
});

test("an include that is already there is refused, however it is spaced", () => {
	const variants = [
		"#include <Servo.h>",
		"#include<Servo.h>",
		'#include "Servo.h"',
		"  #include <Servo.h>",
		"# include <Servo.h>",
		"#include <Servo.h>  // for the servo",
	];

	for (const line of variants) {
		const code = `${line}\n\n${SKETCH}`;
		assert.equal(insertInclude(code, "Servo.h"), null, line);
		assert.equal(findIncludeLine(code, "Servo.h"), 1, line);
	}
});

test("a header named in a comment or a string does not count as included", () => {
	const mentions = [
		"// #include <Servo.h>",
		"//#include <Servo.h>",
		'  Serial.println("#include <Servo.h>");',
		"int servo = 0; // needs #include <Servo.h>",
	];

	for (const line of mentions) {
		const code = `${line}\n\n${SKETCH}`;
		assert.equal(findIncludeLine(code, "Servo.h"), 0, line);

		const result = insertInclude(code, "Servo.h");
		assert.notEqual(result, null, line);
		assert.equal(result.line, 1, line);
		assert.equal(result.code.split("\n")[0], "#include <Servo.h>", line);
	}
});

test("one header is not mistaken for another that contains it", () => {
	const code = `#include <LiquidCrystal_I2C.h>\n\n${SKETCH}`;
	assert.equal(findIncludeLine(code, "LiquidCrystal_I2C.h"), 1);
	assert.equal(findIncludeLine(code, "LiquidCrystal.h"), 0);
	assert.notEqual(insertInclude(code, "LiquidCrystal.h"), null);
});

test("every library in the menu inserts once and only once", () => {
	assert.equal(LIBRARIES.length, 8);

	const headers = LIBRARIES.map((library) => library.header);
	assert.equal(new Set(headers).size, headers.length, "duplicate header in LIBRARIES");

	for (const library of LIBRARIES) {
		assert.match(library.header, /^[A-Za-z0-9_]+\.h$/);

		const first = insertInclude(SKETCH, library.header);
		assert.notEqual(first, null, library.header);
		assert.equal(first.code.split("\n")[first.line - 1], `#include <${library.header}>`);
		// Picking the same one again is a no-op.
		assert.equal(insertInclude(first.code, library.header), null, library.header);
	}
});

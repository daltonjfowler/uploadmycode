/**
 * Checks the compiler-error parser against real arduino-cli output.
 *
 * Run with `npm test`. Node runs web/src/errors.ts directly (it strips the
 * types), so this tests the exact file the browser bundle uses — there is no
 * build step and no second copy of the regex to keep in sync.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { errorLines, firstErrorSummary, parseCompileErrors } from "../src/errors.ts";

test("finds the line in the T1 missing-semicolon error", () => {
	const stderr = "sketch.ino:10:3: error: expected ';' before 'delay'";
	const errors = parseCompileErrors(stderr);

	assert.equal(errors.length, 1);
	assert.equal(errors[0].line, 10);
	assert.equal(errors[0].column, 3);
	assert.equal(errors[0].severity, "error");
	assert.equal(errors[0].message, "expected ';' before 'delay'");
	assert.deepEqual(errorLines(errors), [10]);
	assert.equal(firstErrorSummary(errors), "Line 10: expected ';' before 'delay'");
});

test("reads a full gcc block, CRLF or LF", () => {
	const lines = [
		"sketch.ino: In function 'void loop()':",
		"sketch.ino:10:3: error: expected ';' before 'delay'",
		"   10 |   digitalWrite(LED_BUILTIN, HIGH)",
		"      |   ^",
		"",
		"Error during build: exit status 1",
	];

	for (const newline of ["\n", "\r\n"]) {
		const errors = parseCompileErrors(lines.join(newline));
		assert.equal(errors.length, 1, `newline ${JSON.stringify(newline)}`);
		assert.equal(errors[0].line, 10);
		assert.equal(errors[0].column, 3);
	}
});

test("keeps several diagnostics in order and de-duplicates the lines", () => {
	const stderr = [
		"sketch.ino:4:10: warning: unused variable 'x' [-Wunused-variable]",
		"sketch.ino:10:3: error: expected ';' before 'delay'",
		"sketch.ino:10:3: note: previous declaration was here",
		"sketch.ino:12:1: error: expected '}' at end of input",
	].join("\n");

	const errors = parseCompileErrors(stderr);
	assert.equal(errors.length, 4);
	assert.deepEqual(
		errors.map((e) => e.line),
		[4, 10, 10, 12],
	);
	// Only the hard errors are highlighted when there are any.
	assert.deepEqual(errorLines(errors), [10, 12]);
	assert.equal(firstErrorSummary(errors), "Line 10: expected ';' before 'delay'");
});

test("highlights warnings when there is nothing worse", () => {
	const errors = parseCompileErrors("sketch.ino:4:10: warning: unused variable 'x'");
	assert.deepEqual(errorLines(errors), [4]);
});

test("handles a column-less diagnostic and a surviving path prefix", () => {
	const errors = parseCompileErrors(
		["sketch.ino:7: error: something broke", "/tmp/uno-ide-x1/sketch/sketch.ino:9:2: error: and again"].join(
			"\n",
		),
	);
	assert.equal(errors.length, 2);
	assert.equal(errors[0].line, 7);
	assert.equal(errors[0].column, 0);
	assert.equal(errors[1].line, 9);
	assert.equal(errors[1].column, 2);
});

test("ignores output with nothing to point at", () => {
	assert.deepEqual(parseCompileErrors(""), []);
	assert.deepEqual(parseCompileErrors("Sketch is too large."), []);
	assert.deepEqual(parseCompileErrors("sketch.ino:0:1: error: bad line number"), []);
	assert.equal(firstErrorSummary([]), null);
});

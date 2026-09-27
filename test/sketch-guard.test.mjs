/**
 * The container's refusal of sketches that name a file outside themselves.
 *
 * This is the second layer: the first is that container/server.js deletes each
 * sketch as soon as its compile ends, so there is nothing of another student's
 * left to read. What is tested here is that the obvious ways of reaching for a
 * file are refused with a sentence the editor can point at, and that ordinary
 * classroom sketches are never caught by it.
 *
 * Run with `npm test`. container/sketch-guard.js has no imports, so it loads
 * without starting the server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sketchProblem } from "../container/sketch-guard.js";

const PATH_REFUSAL = /^sketch\.ino:(\d+):1: error: #include can only name a library/;

/** The line number a refusal points at, or null if the sketch was allowed. */
function refusedLine(code, pattern = /^sketch\.ino:(\d+):1: error: /) {
	const problem = sketchProblem(code);
	if (problem === null) return null;
	const match = pattern.exec(problem);
	assert.ok(match, `unexpected refusal shape: ${problem}`);
	return Number(match[1]);
}

// ------------------------------------------------------ ordinary sketches pass

test("ordinary classroom sketches are never refused", () => {
	const sketches = [
		"void setup() {}\nvoid loop() {}\n",
		'#include <Servo.h>\nServo s;\nvoid setup() { s.attach(9); }\nvoid loop() {}\n',
		'#include "Arduino_SensorKit.h"\nvoid setup() { Oled.begin(); }\nvoid loop() {}\n',
		"#include <LiquidCrystal_I2C.h>\n#include <Wire.h>\nvoid setup() {}\nvoid loop() {}\n",
		'#include "notes.h"\nvoid setup() {}\nvoid loop() {}\n',
		'#include <avr/pgmspace.h>\nconst char msg[] PROGMEM = "hi";\nvoid setup() {}\nvoid loop() {}\n',
		// A path in a string or a comment is not an include.
		'void setup() { Serial.println("#include \\"/etc/passwd\\""); }\nvoid loop() {}\n',
		'// #include "/dev/zero" would be bad\nvoid setup() {}\nvoid loop() {}\n',
		'/*\n#include "../secret.h"\n*/\nvoid setup() {}\nvoid loop() {}\n',
		// Two dots that are not a path step, and asm that reads nothing.
		'void setup() { float x = 1.5; x = x / 2.; }\nvoid loop() { asm volatile ("nop"); }\n',
		// A raw string holding a comment opener, then an ordinary include.
		'const char* s = R"(/* not a comment)";\n#include <Servo.h>\nvoid setup() {}\nvoid loop() {}\n',
	];
	for (const code of sketches) {
		assert.equal(sketchProblem(code), null, code);
	}
});

// ------------------------------------------------------- reaching outside

test("an absolute #include is refused, pointing at its line", () => {
	assert.equal(refusedLine('void setup() {}\n#include "/dev/zero"\nvoid loop() {}\n', PATH_REFUSAL), 2);
	assert.equal(refusedLine('#include "/opt/arduino/build/general/sketch/sketch.ino"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine("#include </etc/passwd>\n", PATH_REFUSAL), 1);
	assert.equal(refusedLine('#include "C:\\Users\\x.h"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine('#include "\\\\server\\share\\x.h"\n', PATH_REFUSAL), 1);
});

test("any .. in an #include is refused", () => {
	assert.equal(refusedLine('#include "../sensorkit/sketch/sketch.ino"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine("#include <../../../etc/passwd>\n", PATH_REFUSAL), 1);
	assert.equal(refusedLine('#include "sub/../../x.h"\n', PATH_REFUSAL), 1);
});

test("#include_next and #import are held to the same rule", () => {
	assert.equal(refusedLine('#include_next "/etc/passwd"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine('#import "/etc/passwd"\n', PATH_REFUSAL), 1);
});

test("a computed #include is refused, because its file cannot be checked", () => {
	const code = '#define SECRET "/opt/arduino/build/general/sketch/sketch.ino"\n#include SECRET\n';
	assert.equal(refusedLine(code, /^sketch\.ino:(\d+):1: error: #include has to name its file/), 2);
});

test(".incbin and .include in assembly are refused", () => {
	const asm = /^sketch\.ino:(\d+):1: error: \.incbin and \.include are not allowed/;
	assert.equal(
		refusedLine('void setup() {}\nasm(".incbin \\"/opt/arduino/build/general/out/sketch.ino.hex\\"");\n', asm),
		2,
	);
	assert.equal(refusedLine('__asm__(".INCBIN \\"/x\\"");\n', asm), 1, "any case");
	assert.equal(refusedLine('asm(".include \\"/etc/passwd\\"");\n', asm), 1);
});

// -------------------------------------------------- the obvious disguises

test("spacing, the %: digraph and a comment inside the directive do not hide it", () => {
	assert.equal(refusedLine('   #   include   "/dev/zero"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine('\t#include\t< /etc/passwd >\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine('%:include "/dev/zero"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine('#/* hidden */include "/dev/zero"\n', PATH_REFUSAL), 1);
	assert.equal(refusedLine('# include /* hidden */ "/dev/zero"\n', PATH_REFUSAL), 1);
});

test("a backslash-newline inside the directive does not hide it, and lines stay true", () => {
	assert.equal(refusedLine('void setup() {}\n#inc\\\nlude "/dev/zero"\n', PATH_REFUSAL), 2);
	assert.equal(refusedLine('#include "/dev/\\\nzero"\n', PATH_REFUSAL), 1);
	// A splice earlier in the file does not shift the line reported later.
	assert.equal(refusedLine('int a = 1 + \\\n 2;\nvoid setup() {}\n#include "/x"\n', PATH_REFUSAL), 4);
	// Windows line endings too.
	assert.equal(refusedLine('#inc\\\r\nlude "/dev/zero"\r\n', PATH_REFUSAL), 1);
});

test("a string or raw string cannot fake a comment that hides the next lines", () => {
	// If the "/*" inside the literal were taken for a comment, the include
	// after it would be hidden. The compiler sees it, so the check must too.
	assert.equal(refusedLine('const char* a = "/*";\n#include "/dev/zero"\n// */\n', PATH_REFUSAL), 2);
	assert.equal(refusedLine("char c = '\"';\n#include \"/dev/zero\"\n", PATH_REFUSAL), 2);
	assert.equal(refusedLine('const char* r = R"x(" /* )x";\n#include "/dev/zero"\n// */\n', PATH_REFUSAL), 2);
	assert.equal(refusedLine('auto r = u8R"(/*)";\n#include "/dev/zero"\n', PATH_REFUSAL), 2);
});

test("a name ending in R is not a raw string, so it cannot swallow lines either", () => {
	// fooR"(" is the name fooR and then an ordinary string. Treating it as a
	// raw string would skip everything up to a later )" — including the include.
	const code = '#define fooR\nconst char* s = fooR"(";\n#include "/dev/zero"\n// )"\n';
	assert.equal(refusedLine(code, PATH_REFUSAL), 3);
});

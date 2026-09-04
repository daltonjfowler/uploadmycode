/**
 * Checks the plain-English hints against real avr-gcc wording.
 *
 * Every case below is written as the compiler prints it — the whole
 * `sketch.ino:LINE:COL: severity: message` line — and then run through the real
 * parser, so the hint table is fed exactly what the error panel feeds it and
 * there is no second copy of the message text to drift.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hintFor, matchHint, HINT_RULES } from "../src/error-hints.ts";
import { parseCompileErrors } from "../src/errors.ts";

/** The hint for one line of real compiler output. */
function hintForLine(gccLine) {
	const errors = parseCompileErrors(gccLine);
	assert.equal(errors.length, 1, `parser did not read: ${gccLine}`);
	return hintFor(errors[0].message);
}

/** The rule that answered, so a test can pin the order down. */
function ruleForLine(gccLine) {
	const errors = parseCompileErrors(gccLine);
	assert.equal(errors.length, 1, `parser did not read: ${gccLine}`);
	return matchHint(errors[0].message)?.id ?? null;
}

test("the missing semicolon from the T2 gate", () => {
	assert.equal(
		hintForLine("sketch.ino:34:3: error: expected ';' before 'delay'"),
		"Every statement ends with a semicolon. Check the line above.",
	);
	// The same error when the next thing is the end of the block.
	assert.equal(
		hintForLine("sketch.ino:36:1: error: expected ';' before '}' token"),
		"Every statement ends with a semicolon. Check the line above.",
	);
});

test("unclosed brackets name the pair that is open", () => {
	assert.equal(
		hintForLine("sketch.ino:35:1: error: expected '}' at end of input"),
		"Every { needs a matching }. One of your blocks is never closed.",
	);
	assert.equal(
		hintForLine("sketch.ino:33:34: error: expected ')' before ';' token"),
		"Every ( needs a matching ). Count the brackets on this line.",
	);
	assert.equal(
		hintForLine("sketch.ino:12:18: error: expected ']' before ';' token"),
		"Every [ needs a matching ]. Check the square brackets here.",
	);
});

test("one closing brace too many is its own hint, not the pair hint", () => {
	assert.equal(
		hintForLine("sketch.ino:37:1: error: expected declaration before '}' token"),
		"There is one closing brace too many.",
	);
	assert.equal(ruleForLine("sketch.ino:37:1: error: expected declaration before '}' token"), "extra-closing-brace");
});

test("a wrong-case name says the right spelling outright", () => {
	// What `serial.println("hi");` actually produces.
	const hint = hintForLine("sketch.ino:9:3: error: 'serial' was not declared in this scope");
	assert.ok(hint.includes("Serial"), `no Serial in: ${hint}`);
	assert.equal(hint, "Capital letters matter: write Serial, not serial.");

	// Newer gcc adds its own suggestion after a semicolon; the rule still fires.
	const withSuggestion = hintForLine(
		"sketch.ino:9:3: error: 'serial' was not declared in this scope; did you mean 'Serial'?",
	);
	assert.ok(withSuggestion.includes("Serial"), `no Serial in: ${withSuggestion}`);

	assert.equal(
		hintForLine("sketch.ino:5:3: error: 'digitalwrite' was not declared in this scope"),
		"Capital letters matter: write digitalWrite, not digitalwrite.",
	);
	assert.equal(
		hintForLine("sketch.ino:4:15: error: 'led_builtin' was not declared in this scope"),
		"Capital letters matter: write LED_BUILTIN, not led_builtin.",
	);
});

test("an unknown name that is not a case mistake gets the general hint", () => {
	assert.equal(
		hintForLine("sketch.ino:11:3: error: 'ledPin' was not declared in this scope"),
		"The name is unknown here. Check spelling and capital letters (code cares about case).",
	);
});

test("first match wins, and the narrow rules sit above the wide ones", () => {
	// Both of these match NOT_DECLARED; only the first is a known name in the
	// wrong case, and it must be answered by the earlier rule.
	assert.equal(ruleForLine("sketch.ino:9:3: error: 'serial' was not declared in this scope"), "wrong-case-name");
	assert.equal(ruleForLine("sketch.ino:9:3: error: 'ledPin' was not declared in this scope"), "not-declared");

	// Same shape one rung down: a stray '#' is a stray character too.
	assert.equal(ruleForLine("sketch.ino:4:1: error: stray '#' in program"), "stray-hash");
	assert.equal(ruleForLine("sketch.ino:6:11: error: stray '\\342' in program"), "stray-character");

	// And the order those depend on is the order the table declares.
	const ids = HINT_RULES.map((entry) => entry.id);
	assert.ok(ids.indexOf("wrong-case-name") < ids.indexOf("not-declared"));
	assert.ok(ids.indexOf("stray-hash") < ids.indexOf("stray-character"));
	assert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
});

test("an unknown type points at spelling and at the Library menu", () => {
	assert.equal(
		hintForLine("sketch.ino:11:1: error: 'Servoo' does not name a type"),
		"This type is unknown. Check the spelling, or add its library from the Library menu.",
	);
});

test("a header that is not there", () => {
	assert.equal(
		hintForLine("sketch.ino:1:10: fatal error: Servoo.h: No such file or directory"),
		"That library is not installed here. Pick it from the Library menu, or check the spelling.",
	);
});

test("the same thing declared twice", () => {
	assert.equal(
		hintForLine("sketch.ino:14:6: error: redefinition of 'void setup()'"),
		"This name is made twice in the sketch. Delete one of the two copies.",
	);
});

test("wrong things inside the parentheses", () => {
	assert.equal(
		hintForLine("sketch.ino:18:19: error: no matching function for call to 'Servo::attach()'"),
		"Check inside the parentheses. The number or kind of things does not fit.",
	);
	assert.equal(
		hintForLine("sketch.ino:33:35: error: too many arguments to function 'void delay(long unsigned int)'"),
		"There are too many things inside the parentheses. Take one out.",
	);
	assert.equal(
		hintForLine("sketch.ino:33:29: error: too few arguments to function 'void digitalWrite(uint8_t, uint8_t)'"),
		"Something is missing inside the parentheses. Add what it needs.",
	);
});

test("a sketch with no setup or no loop", () => {
	// The linker reports this against main.cpp, not sketch.ino, so it is fed to
	// the table directly the way the panel's parser would never see it.
	const expected = "Your sketch needs both void setup() { } and void loop() { }.";
	assert.equal(hintFor("undefined reference to `setup'"), expected);
	assert.equal(hintFor("undefined reference to `loop'"), expected);
	assert.equal(hintFor("undefined reference to 'setup'"), expected);
});

test("= where == was meant, as an error and as a warning", () => {
	const expected = "= sets a value; == compares. You may want ==.";
	assert.equal(
		hintForLine("sketch.ino:20:7: error: lvalue required as left operand of assignment"),
		expected,
	);
	assert.equal(
		hintForLine(
			"sketch.ino:21:11: warning: suggest parentheses around assignment used as truth value [-Wparentheses]",
		),
		expected,
	);
});

test("a comment that never closes, and a stray hash", () => {
	assert.equal(
		hintForLine("sketch.ino:5:1: error: unterminated comment"),
		"A comment opened with /* needs a */ to close it.",
	);
	assert.equal(
		hintForLine("sketch.ino:4:1: error: stray '#' in program"),
		"A # belongs only on an #include line at the top.",
	);
	assert.equal(
		hintForLine("sketch.ino:2:1: error: expected unqualified-id before '{' token"),
		"Something extra is here. Look for a spare brace, semicolon or keyword.",
	);
});

test("no hint is better than a wrong hint", () => {
	assert.equal(hintForLine("sketch.ino:9:14: error: cannot convert 'const char*' to 'int' in initialization"), null);
	assert.equal(hintForLine("sketch.ino:7:9: error: 'class Servo' has no member named 'wrte'"), null);
	assert.equal(hintFor("internal compiler error: Segmentation fault"), null);
	assert.equal(hintFor(""), null);
	assert.equal(hintFor("   "), null);
});

test("every hint stays one short sentence a beginner can read", () => {
	const samples = [
		"expected ';' before 'delay'",
		"expected '}' at end of input",
		"expected ')' before ';' token",
		"expected ']' before ';' token",
		"expected declaration before '}' token",
		"'serial' was not declared in this scope",
		"'led_builtin' was not declared in this scope",
		"'ledPin' was not declared in this scope",
		"'Servoo' does not name a type",
		"Servoo.h: No such file or directory",
		"redefinition of 'void setup()'",
		"no matching function for call to 'Servo::attach()'",
		"too many arguments to function 'void delay(long unsigned int)'",
		"too few arguments to function 'void digitalWrite(uint8_t, uint8_t)'",
		"undefined reference to `setup'",
		"lvalue required as left operand of assignment",
		"suggest parentheses around assignment used as truth value [-Wparentheses]",
		"unterminated comment",
		"stray '#' in program",
		"stray '\\342' in program",
		"expected unqualified-id before '{' token",
	];

	for (const sample of samples) {
		const hint = hintFor(sample);
		assert.ok(hint !== null, `no hint for: ${sample}`);
		assert.ok(hint.length <= 90, `hint too long (${hint.length}): ${hint}`);
		assert.ok(!hint.includes("\n"), `hint has a line break: ${hint}`);
	}

	// Nothing in the table is unreachable: every rule answered one sample above.
	const answered = new Set(samples.map((sample) => matchHint(sample)?.id));
	answered.add(matchHint("undefined reference to `loop'")?.id);
	for (const entry of HINT_RULES) {
		assert.ok(answered.has(entry.id), `no sample reaches rule: ${entry.id}`);
	}
});

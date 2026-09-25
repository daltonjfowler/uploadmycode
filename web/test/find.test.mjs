/**
 * Find & replace: the query the panel builds, the count it shows, and why the
 * defaults are what they are.
 *
 * Run with `npm test`. Node runs web/src/find.ts directly (it strips the
 * types), so this tests the exact query builder the panel uses. The panel's
 * DOM and CodeMirror's replaceAll command need a real browser and are covered
 * by the click-through steps in docs/T2-TEST.md; what is pinned here is the
 * part that decides which characters a Replace all would touch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorSelection, EditorState } from "@codemirror/state";

import { COUNT_LIMIT, countMatches, makeQuery, matchLabel } from "../src/find.ts";

const LOOP = [
	"void setup() {",
	"  Serial.begin(9600);",
	"  pinMode(LED_BUILTIN, OUTPUT);",
	"}",
	"",
	"int led = 13;",
	"",
	"void loop() {",
	"  for (int i = 0; i < 10; i++) {",
	"    Serial.println(i);",
	'    Serial.print("\\t");',
	"  }",
	"  digitalWrite(led, HIGH);",
	"}",
].join("\n");

/** The panel's starting options: Whole word and Match case ticked. */
function query(search, overrides = {}) {
	return makeQuery({ search, replace: "", wholeWord: true, caseSensitive: true, ...overrides });
}

function matches(doc, q) {
	const state = EditorState.create({ doc });
	return [...{ [Symbol.iterator]: () => q.getCursor(state) }].map((m) => doc.slice(m.from, m.to));
}

/** What Replace all does, done the same way: every match, one change set. */
function replaceEvery(doc, q, insert) {
	const state = EditorState.create({ doc });
	const changes = [...{ [Symbol.iterator]: () => q.getCursor(state) }].map((m) => ({ ...m, insert }));
	return state.update({ changes }).state.doc.toString();
}

test("renaming i to count leaves int, println and print alone", () => {
	const renamed = replaceEvery(LOOP, query("i"), "count");
	assert.match(renamed, /for \(int count = 0; count < 10; count\+\+\)/);
	assert.match(renamed, /Serial\.println\(count\);/);
	assert.match(renamed, /Serial\.print\("\\t"\);/);
	assert.match(renamed, /void setup\(\)/);
	assert.match(renamed, /pinMode\(LED_BUILTIN, OUTPUT\)/);
});

test("with Whole word off the same search would have hit the i inside other words", () => {
	// The reason the box starts ticked.
	const loose = matches(LOOP, query("i", { wholeWord: false }));
	assert.ok(loose.length > 4, `expected more than the 4 real i's, got ${loose.length}`);
	assert.equal(matches(LOOP, query("i")).length, 4);
});

test("Match case keeps led apart from LED_BUILTIN and LED", () => {
	const doc = "int led = 13;\nint LED = 12;\ndigitalWrite(led, HIGH);\npinMode(LED_BUILTIN, OUTPUT);";
	assert.deepEqual(matches(doc, query("led")), ["led", "led"]);
	// Case off would pull in LED as well (LED_BUILTIN is one word either way).
	assert.deepEqual(matches(doc, query("led", { caseSensitive: false })), ["led", "LED", "led"]);
});

test("searches are literal: a typed \\t is a backslash and a t, not a tab", () => {
	assert.deepEqual(matches(LOOP, query('"\\t"')), ['"\\t"']);
	const tabbed = "Serial.print(x);\tSerial.print(y);";
	assert.deepEqual(matches(tabbed, query("\\t")), []);
});

test("a replacement is inserted as typed too", () => {
	const out = replaceEvery('Serial.print(" ");', query('" "'), '"\\t"');
	assert.equal(out, 'Serial.print("\\t");');
});

test("countMatches: null for an empty search, total and place otherwise", () => {
	const state = EditorState.create({ doc: LOOP });
	assert.equal(countMatches(state, query("")), null);
	assert.deepEqual(countMatches(state, query("i")), { total: 4, current: 0, capped: false });
	assert.deepEqual(countMatches(state, query("nothing here")), { total: 0, current: 0, capped: false });

	// Put the selection on the second i and the count says which one it is.
	const at = LOOP.indexOf("i = 0");
	const second = LOOP.indexOf("i <");
	assert.ok(at > 0 && second > at);
	const selected = state.update({ selection: EditorSelection.single(second, second + 1) }).state;
	assert.deepEqual(countMatches(selected, query("i")), { total: 4, current: 2, capped: false });
});

test("countMatches stops at the limit and says so", () => {
	const state = EditorState.create({ doc: "x ".repeat(COUNT_LIMIT + 5) });
	assert.deepEqual(countMatches(state, query("x")), { total: COUNT_LIMIT, current: 0, capped: true });
	const exact = countMatches(state, query("x"), Number.POSITIVE_INFINITY);
	assert.deepEqual(exact, { total: COUNT_LIMIT + 5, current: 0, capped: false });
});

test("matchLabel", () => {
	assert.equal(matchLabel(null), "");
	assert.equal(matchLabel({ total: 0, current: 0, capped: false }), "Not found");
	assert.equal(matchLabel({ total: 1, current: 0, capped: false }), "1 match");
	assert.equal(matchLabel({ total: 3, current: 0, capped: false }), "3 matches");
	assert.equal(matchLabel({ total: 3, current: 2, capped: false }), "2 of 3");
	assert.equal(matchLabel({ total: 999, current: 0, capped: true }), "999+ matches");
	assert.equal(matchLabel({ total: 999, current: 7, capped: true }), "7 of 999+");
});

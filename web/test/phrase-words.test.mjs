/**
 * The teacher page's Generate button: how many phrases it can make, and that
 * every one of them is something a class can type and the Worker will take.
 *
 * Run with `npm test`. web/public/phrase-words.js is a plain script, not a
 * module (teacher.html loads it with a script tag), so it is run here in a
 * small sandbox with the real Web Crypto, exactly as the browser runs it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { isUsablePhrase, normalizePhrase } from "../../src/phrase.ts";

function loadGenerator() {
	const source = readFileSync(new URL("../public/phrase-words.js", import.meta.url), "utf8");
	const sandbox = { crypto: globalThis.crypto };
	vm.runInNewContext(source, sandbox);
	return sandbox.uploadmycodePhrase;
}

const { WORDS, NUMBER_COUNT, generatePhrase } = loadGenerator();

test("the phrase space is at least 2^28, so guessing at 120 a minute is hopeless", () => {
	const n = WORDS.length;
	// Three different words in order, then a number.
	const phrases = n * (n - 1) * (n - 2) * NUMBER_COUNT;
	assert.ok(phrases >= 2 ** 28, `only ${phrases} phrases (2^${Math.log2(phrases).toFixed(2)})`);
	// And what that means at the per-address limit: well over a year of trying.
	const minutesToTryHalf = phrases / 2 / 120;
	assert.ok(minutesToTryHalf > 365 * 24 * 60, `${minutesToTryHalf} minutes`);
});

test("every word is plain, short, lowercase and listed once", () => {
	assert.equal(new Set(WORDS).size, WORDS.length, "no duplicates");
	for (const word of WORDS) {
		assert.match(word, /^[a-z]{4,7}$/, word);
	}
});

test("a generated phrase is three different words and a two-digit number", () => {
	for (let i = 0; i < 2000; i += 1) {
		const phrase = generatePhrase();
		const match = /^([a-z]+)-([a-z]+)-([a-z]+)-([1-9][0-9])$/.exec(phrase);
		assert.ok(match, phrase);
		const words = match.slice(1, 4);
		assert.equal(new Set(words).size, 3, phrase);
		for (const word of words) assert.ok(WORDS.includes(word), word);
	}
});

test("every generated phrase is one the Worker accepts, already in its tidy form", () => {
	for (let i = 0; i < 2000; i += 1) {
		const phrase = generatePhrase();
		assert.equal(normalizePhrase(phrase), phrase, "nothing for the Worker to tidy");
		assert.equal(isUsablePhrase(phrase), true, phrase);
	}
});

test("the words a class sees on the board are the words it can type in any case", () => {
	const phrase = generatePhrase();
	assert.equal(normalizePhrase(phrase.toUpperCase()), phrase);
	assert.equal(normalizePhrase("  " + phrase + " "), phrase);
});

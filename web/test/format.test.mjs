/**
 * The Auto indent button's two pieces of logic: deciding what to do with a
 * formatted sketch, and reading the server's answer.
 *
 * Run with `npm test`. Node runs web/src/format.ts directly (it strips the
 * types), so this tests the exact file the browser bundle uses. `formatEdit` is
 * pure; the request tests stub `globalThis.fetch`, which is all `requestFormat`
 * touches besides the client id in storage.
 *
 * What `formatEdit` is really pinning down: the page must never put a shorter
 * document back and then ask CodeMirror for a line that is no longer in it, and
 * it must never announce a tidy that did not happen.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatEdit, requestFormat } from "../src/format.ts";

const MESSY = "void setup() {\n\t\tpinMode(13,OUTPUT);\n}\n";
const TIDY = "void setup() {\n  pinMode(13, OUTPUT);\n}\n";

// ------------------------------------------------------------- did it change

test("a sketch that came back different is applied", () => {
	const edit = formatEdit(MESSY, TIDY, 2);
	assert.equal(edit.code, TIDY);
	assert.equal(edit.caretLine, 2);
});

test("a sketch that came back identical is not applied at all", () => {
	const edit = formatEdit(TIDY, TIDY, 2);
	assert.equal(edit.code, null, "null is what tells the page to say 'Already tidy'");
	assert.equal(edit.caretLine, 2, "and the caret still has somewhere sensible to be");
});

test("a difference of one space still counts as a change", () => {
	// Byte-for-byte, deliberately. clang-format adding the final newline a file
	// was missing IS a change to the file, and saying "already tidy" about it
	// would be a lie the next press would contradict.
	assert.equal(formatEdit("void loop() {}", "void loop() {}\n", 1).code, "void loop() {}\n");
});

// ------------------------------------------------------------ caret clamping

test("the caret keeps its line number when the tidy leaves that line there", () => {
	const before = "a\nb\nc\nd\ne\n";
	const after = "a\n  b\n  c\nd\ne\n";
	assert.equal(formatEdit(before, after, 4).caretLine, 4);
});

test("a tidy that removes lines pulls the caret back to the last one left", () => {
	// Five blank lines collapsing to one is exactly what MaxEmptyLinesToKeep
	// does, and it is how the caret ends up pointing past the end.
	const before = "void loop() {\n\n\n\n\n}\n";
	const after = "void loop() {\n\n}\n";
	const edit = formatEdit(before, after, 7);
	assert.equal(edit.code, after);
	// `after` is four lines: the brace, the blank, the closing brace, and the
	// empty line the trailing newline leaves behind.
	assert.equal(edit.caretLine, 4, "clamped to the last line of the new text, not line 7");
});

test("the clamp counts lines the way CodeMirror does", () => {
	// A trailing newline makes an empty final line, and that line is real: the
	// caret may sit on it. Three newlines therefore means four lines.
	assert.equal(formatEdit("x", "a\nb\nc\n", 99).caretLine, 4);
	assert.equal(formatEdit("x", "", 99).caretLine, 1, "the empty document is one line");
	assert.equal(formatEdit("x", "one line", 99).caretLine, 1);
});

test("a caret line below the first line is pulled up to it", () => {
	assert.equal(formatEdit("x", TIDY, 0).caretLine, 1);
	assert.equal(formatEdit("x", TIDY, -12).caretLine, 1);
});

test("a caret line that is not a whole number, or not a number, is survivable", () => {
	assert.equal(formatEdit("x", TIDY, 2.9).caretLine, 2);
	assert.equal(formatEdit("x", TIDY, Number.NaN).caretLine, 1);
	assert.equal(formatEdit("x", TIDY, Number.POSITIVE_INFINITY).caretLine, 1);
});

// ------------------------------------------------------- reading the answer

/** Stand in for the network for one call, and hand back what was sent. */
async function withFetch(reply, run) {
	const real = globalThis.fetch;
	const sent = {};
	globalThis.fetch = async (url, init) => {
		sent.url = url;
		sent.init = init;
		return reply;
	};
	try {
		return { outcome: await run(), sent };
	} finally {
		globalThis.fetch = real;
	}
}

function jsonReply(status, body) {
	return new Response(JSON.stringify(body), { status });
}

test("a tidied sketch comes back as the new code", async () => {
	const { outcome, sent } = await withFetch(jsonReply(200, { ok: true, code: TIDY }), () =>
		requestFormat(MESSY, "red-robot-maple"),
	);
	assert.deepEqual(outcome, { kind: "formatted", code: TIDY });
	assert.equal(sent.url, "/api/format");
	assert.equal(sent.init.headers["x-class-phrase"], "red-robot-maple");
	assert.equal(JSON.parse(sent.init.body).code, MESSY);
});

test("a 403 sends the page back to the phrase field, with the server's words", async () => {
	const said = "Wrong class phrase. Ask your teacher for today's phrase.";
	const { outcome } = await withFetch(jsonReply(403, { ok: false, error: said }), () =>
		requestFormat(MESSY, "yesterdays-phrase"),
	);
	assert.deepEqual(outcome, { kind: "phrase-required", message: said });
});

test("a 429 is shown word for word rather than paraphrased", async () => {
	const said = "That is a lot of tidying in one minute. Wait a moment and try again.";
	const { outcome } = await withFetch(jsonReply(429, { ok: false, error: said }), () =>
		requestFormat(MESSY, "red-robot-maple"),
	);
	assert.deepEqual(outcome, { kind: "service-error", message: said });
});

test("a 413 is shown word for word too", async () => {
	const said = "That sketch is too big to compile. The limit is 100 KB.";
	const { outcome } = await withFetch(jsonReply(413, { ok: false, error: said }), () =>
		requestFormat(MESSY, "red-robot-maple"),
	);
	assert.deepEqual(outcome, { kind: "service-error", message: said });
});

test("a 503 is the container waking up, which is its own kind of answer", async () => {
	const said = "The compiler is busy or starting up. Wait a few seconds and try again.";
	const { outcome } = await withFetch(jsonReply(503, { ok: false, error: said }), () =>
		requestFormat(MESSY, "red-robot-maple"),
	);
	assert.deepEqual(outcome, { kind: "busy", message: said });
});

test("a clang-format failure arrives as a 200 with an error, and changes nothing", async () => {
	const said = "Could not tidy this sketch. Check for a missing bracket or quote, then try again.";
	const { outcome } = await withFetch(jsonReply(200, { ok: false, error: said }), () =>
		requestFormat("void setup() {", "red-robot-maple"),
	);
	assert.deepEqual(outcome, { kind: "service-error", message: said });
});

test("an unreachable server is one sentence, not an exception", async () => {
	const real = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new TypeError("Failed to fetch");
	};
	try {
		const outcome = await requestFormat(MESSY, "red-robot-maple");
		assert.equal(outcome.kind, "service-error");
		assert.match(outcome.message, /Check the Wi-Fi/);
	} finally {
		globalThis.fetch = real;
	}
});

test("a reply that is not JSON, and a reply of the wrong shape, are both survivable", async () => {
	const notJson = await withFetch(new Response("<html>502</html>", { status: 502 }), () =>
		requestFormat(MESSY, "p"),
	);
	assert.equal(notJson.outcome.kind, "service-error");
	assert.match(notJson.outcome.message, /HTTP 502/);

	// ok: true but no code at all. Nothing to apply, so nothing is applied.
	const wrongShape = await withFetch(jsonReply(200, { ok: true }), () => requestFormat(MESSY, "p"));
	assert.equal(wrongShape.outcome.kind, "service-error");
	assert.match(wrongShape.outcome.message, /Unexpected reply/);
});

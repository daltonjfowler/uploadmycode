/**
 * The container's check of libraries a student uploads (container/user-libraries.js).
 *
 * Uploaded library files are untrusted the same way a sketch is, so they get the
 * same sketch-guard check, and only source files with plain names are written to
 * disk. Run with `npm test`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkLibraries, forgetLibraries, MAX_LIBRARIES, MAX_LIBRARY_BYTES, writeLibraries } from "../container/user-libraries.js";

const lib = (name, files) => ({ name, files: Object.entries(files).map(([p, text]) => ({ path: p, text })) });
const good = lib("MyBlink", { "MyBlink.h": "#pragma once\nvoid blink();\n", "MyBlink.cpp": '#include "MyBlink.h"\n#include "utility/pin.h"\n', "utility/pin.h": "#define PIN 13\n" });

test("no libraries is fine", () => {
	assert.deepEqual(checkLibraries(undefined), { libraries: [] });
	assert.deepEqual(checkLibraries([]), { libraries: [] });
});

test("an ordinary library with a utility folder passes", () => {
	const out = checkLibraries([good]);
	assert.ok("libraries" in out);
	assert.equal(out.libraries[0].files.length, 3);
});

test("a library file is checked like a sketch, and the error names the file", () => {
	const bad = lib("Sneaky", { "Sneaky.h": "#pragma once\n#include \"/etc/passwd\"\n" });
	const out = checkLibraries([bad]);
	assert.match(out.problem, /^Sneaky\/Sneaky\.h:2:1: error: #include can only name a library/);
	assert.match(checkLibraries([lib("A", { "a.cpp": "asm(\".incbin \\\"/x\\\"\");" })]).problem, /^A\/a\.cpp:1:1: error: \.incbin/);
});

test("paths that climb out, hide, or are not source files are refused", () => {
	for (const p of ["../x.h", "a/../../x.h", "/abs.h", ".hidden.h", "a\\b.h", "x.S", "x.ino", "x", "a//b.h", "C:x.h"]) {
		const out = checkLibraries([lib("L", { [p]: "int x;" })]);
		assert.ok("problem" in out, `${p} was allowed`);
	}
});

test("library names must be plain, and unique ignoring case", () => {
	for (const name of ["", "../x", "a b", ".x", "x/y", "a".repeat(65)]) assert.ok("problem" in checkLibraries([lib(name, { "a.h": "" })]), `name ${name}`);
	assert.match(checkLibraries([lib("Foo", { "a.h": "" }), lib("foo", { "b.h": "" })]).problem, /both called foo/);
});

test("too many libraries or too much text is refused with a plain sentence", () => {
	const many = Array.from({ length: MAX_LIBRARIES + 1 }, (_, i) => lib(`L${i}`, { "a.h": "" }));
	assert.match(checkLibraries(many).problem, /up to 8/);
	assert.match(checkLibraries([lib("Big", { "a.h": "x".repeat(MAX_LIBRARY_BYTES + 1) })]).problem, /bigger than 512 KB/);
});

test("malformed shapes are refused, never thrown", () => {
	for (const raw of [{}, "x", [null], [{ name: "A" }], [{ name: "A", files: [{ path: "a.h" }] }], [{ name: "A", files: [] }]]) {
		assert.ok("problem" in checkLibraries(raw));
	}
});

test("writeLibraries lays out an arduino-cli library under user_, and forgetLibraries empties it", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "uml-libs-"));
	try {
		const dir = path.join(root, "libraries");
		const build = path.join(root, "build");
		await mkdir(dir, { recursive: true });
		await writeLibraries(dir, checkLibraries([good]).libraries);
		assert.match(await readFile(path.join(dir, "user_MyBlink", "library.properties"), "utf8"), /^name=user_MyBlink$/m);
		assert.equal(await readFile(path.join(dir, "user_MyBlink", "src", "utility", "pin.h"), "utf8"), "#define PIN 13\n");

		await mkdir(path.join(build, "libraries", "user_MyBlink"), { recursive: true });
		await mkdir(path.join(build, "libraries", "Servo"), { recursive: true });
		await writeFile(path.join(build, "libraries", "Servo", "Servo.cpp.o"), "");
		await forgetLibraries(dir, build);
		assert.deepEqual(await readdir(dir), []);
		assert.deepEqual(await readdir(path.join(build, "libraries")), ["Servo"]); // installed ones keep their cache
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * The page's side of "Add your own library": reading a library .zip (web/src/unzip.ts)
 * and picking out the code the compiler needs (web/src/user-libraries.ts).
 *
 * The zips are built here with node:zlib, deflated like GitHub's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { addLibrary, cleanLibraryName, libraryFromFiles, LibraryProblem, MAX_LIBRARIES, readLibrary } from "../web/src/user-libraries.ts";

/** A real .zip: one local header + data per file, then the central directory. */
function zip(files) {
	const parts = [];
	const central = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const raw = Buffer.from(text);
		const packed = deflateRawSync(raw);
		const nameBuf = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
		cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(raw.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
		parts.push(local, nameBuf, packed);
		central.push(cd, nameBuf);
		offset += 30 + nameBuf.length + packed.length;
	}
	const cdBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
	end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, cdBuf, end]);
}

const asFile = (name, buf) => ({ name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

test("a GitHub-style zip with src/: only src is kept, name and header come from library.properties", async () => {
	const lib = await readLibrary([asFile("Adafruit_NeoPixel-master.zip", zip({
		"Adafruit_NeoPixel-master/library.properties": "name=Adafruit NeoPixel\nversion=1.12.0\nincludes=Adafruit_NeoPixel.h\n",
		"Adafruit_NeoPixel-master/src/Adafruit_NeoPixel.h": "#pragma once\n",
		"Adafruit_NeoPixel-master/src/Adafruit_NeoPixel.cpp": '#include "Adafruit_NeoPixel.h"\n',
		"Adafruit_NeoPixel-master/src/utility/esp.c": "int x;\n",
		"Adafruit_NeoPixel-master/examples/simple/simple.ino": "void setup(){}\n",
		"Adafruit_NeoPixel-master/README.md": "# hi\n",
	}))]);
	assert.equal(lib.name, "Adafruit_NeoPixel");
	assert.equal(lib.header, "Adafruit_NeoPixel.h");
	assert.deepEqual(lib.files.map((f) => f.path).sort(), ["Adafruit_NeoPixel.cpp", "Adafruit_NeoPixel.h", "utility/esp.c"]);
});

test("an old-style zip (files at the top, utility/) keeps those and skips examples", async () => {
	const lib = await readLibrary([asFile("TM1637-1.2.0.zip", zip({
		"TM1637/TM1637Display.h": "#pragma once\n",
		"TM1637/TM1637Display.cpp": "\n",
		"TM1637/utility/bits.h": "\n",
		"TM1637/examples/x/x.cpp": "\n",
	}))]);
	assert.equal(lib.name, "TM1637");
	assert.equal(lib.header, "TM1637Display.h");
	assert.deepEqual(lib.files.map((f) => f.path).sort(), ["TM1637Display.cpp", "TM1637Display.h", "utility/bits.h"]);
});

test("loose .h and .cpp files become one library named after the header", async () => {
	const lib = await readLibrary([asFile("Buzzer.h", Buffer.from("#pragma once\n")), asFile("Buzzer.cpp", Buffer.from("\n"))]);
	assert.equal(lib.name, "Buzzer");
	assert.equal(lib.header, "Buzzer.h");
});

test("things that are not libraries get a sentence, not a crash", async () => {
	await assert.rejects(readLibrary([asFile("notes.zip", zip({ "notes/readme.txt": "hi" }))]), LibraryProblem);
	await assert.rejects(readLibrary([asFile("broken.zip", Buffer.from("not a zip at all"))]), /not a \.zip/);
	await assert.rejects(readLibrary([asFile("a.zip", zip({ "a.h": "" })), asFile("b.zip", zip({ "b.h": "" }))]), /one library \.zip at a time/);
	assert.throws(() => libraryFromFiles("X", [{ path: "my file.h", text: "" }]), /name that cannot be used/);
});

test("names are cleaned to what the server accepts", () => {
	assert.equal(cleanLibraryName("LiquidCrystal I2C-master.zip"), "LiquidCrystal_I2C");
	assert.equal(cleanLibraryName("My-Lib-v2.0.1.zip"), "My-Lib");
	assert.equal(cleanLibraryName("***.zip"), "MyLibrary");
});

test("adding replaces a library with the same name and stops at the limit", () => {
	const make = (name) => ({ name, header: `${name}.h`, files: [{ path: `${name}.h`, text: "" }] });
	const first = addLibrary([], make("A"));
	assert.equal(first.replaced, false);
	const again = addLibrary(first.list, make("a"));
	assert.equal(again.replaced, true);
	assert.equal(again.list.length, 1);
	const full = Array.from({ length: MAX_LIBRARIES }, (_, i) => make(`L${i}`));
	assert.throws(() => addLibrary(full, make("One more")), /up to 8/);
});

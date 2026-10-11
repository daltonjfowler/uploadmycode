/**
 * Build-time only (Dockerfile.esp32): compile every combination in WARM_SETS
 * into the exact folder server.js will use for it, TWICE with two different
 * sketches, the same as the UNO warm-up (see Dockerfile): a folder that has
 * seen only one sketch rebuilds its libraries the first time a different one
 * arrives. Then delete everything a sketch left behind, like forgetSketch.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { esp32Bucket, headerIndex, imageLibraryRoots, WARM_SETS } from "./esp32-buckets.js";

const FQBN = process.argv[2];
const ROOT = process.env.BUILD_ROOT;
if (!FQBN || !ROOT) throw new Error("usage: BUILD_ROOT=... node esp32-warmup.mjs <fqbn>");

// The same header -> library index server.js uses, so the folder names match.
const index = headerIndex(imageLibraryRoots());
const done = new Set();

const bodies = [
	"void setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  delay(100);\n}\n",
	"void setup() {\n  // put your setup code here, to run once:\n\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n\n}\n",
];

for (const set of WARM_SETS) {
	const includes = set.map((h) => `#include <${h}>\n`).join("");
	const bucket = esp32Bucket(includes, [], index);
	if (done.has(bucket)) continue;
	done.add(bucket);
	const dir = path.join(ROOT, bucket);
	mkdirSync(path.join(dir, "sketch"), { recursive: true });
	mkdirSync(path.join(dir, "libraries"), { recursive: true });
	for (const body of bodies) {
		writeFileSync(path.join(dir, "sketch", "sketch.ino"), includes + body);
		const started = Date.now();
		const run = spawnSync(
			"arduino-cli",
			["compile", "--fqbn", FQBN, "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), "--libraries", path.join(dir, "libraries"), path.join(dir, "sketch")],
			{ encoding: "utf8" },
		);
		if (run.status !== 0) throw new Error(`warm-up failed for ${set.join(", ") || "(none)"}:\n${run.stderr || run.stdout}`);
		console.log(`${bucket} [${set.join(", ")}] ${((Date.now() - started) / 1000).toFixed(1)} s`);
	}
	rmSync(path.join(dir, "sketch", "sketch.ino"), { force: true });
	rmSync(path.join(dir, "out"), { recursive: true, force: true });
	rmSync(path.join(dir, "build", "sketch"), { recursive: true, force: true });
	for (const name of readdirSync(path.join(dir, "build"))) {
		if (name.startsWith("sketch.ino.")) rmSync(path.join(dir, "build", name), { force: true });
	}
}

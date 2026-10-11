/**
 * Guard against the September 2026 bill bug coming back: a compile container
 * that never goes to sleep.
 *
 * server.js runs as PID 1 in both images, and Linux ignores an unhandled
 * SIGTERM for PID 1, so the platform's idle stop never landed and an awake
 * instance billed until the next deploy. Three things keep sleep working, and
 * this file fails if any of them is lost:
 *   1. server.js handles SIGTERM and exits;
 *   2. every Dockerfile starts node in exec form (CMD ["node", ...]), so node
 *      itself is PID 1 and gets the signal, not a shell that swallows it;
 *   3. every Container class in the Worker sets a sleepAfter.
 * Checked live on 2026-10-10 as well: `docker stop` on the ESP32 image took
 * 0.4 s with exit code 0.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("server.js exits on SIGTERM", () => {
	const server = read("container/server.js");
	assert.match(server, /process\.on\(\s*"SIGTERM"/);
	assert.match(server, /process\.exit\(0\)/);
});

test("every image starts node directly, so node is PID 1 and gets SIGTERM", () => {
	for (const file of ["container/Dockerfile", "container/Dockerfile.esp32"]) {
		const cmds = read(file).split(/\r?\n/).filter((l) => /^\s*(CMD|ENTRYPOINT)\b/.test(l));
		assert.deepEqual(cmds, ['CMD ["node", "/app/server.js"]'], file);
	}
});

test("every Container class sets sleepAfter", () => {
	const worker = read("src/worker.ts");
	const classes = [...worker.matchAll(/export class (\w+) extends Container \{([\s\S]*?)\n\}/g)];
	assert.deepEqual(classes.map((c) => c[1]).sort(), ["CompilerContainer", "Esp32Container"]);
	for (const [, name, body] of classes) assert.match(body, /override sleepAfter = "\d+m"/, name);
});

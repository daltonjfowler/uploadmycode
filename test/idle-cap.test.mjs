// The compilers' idle cap (src/idle-cap.ts). Guards the November 2026 leak on the sister sites: a
// container the library still counted as busy sat awake for hours with nobody using it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { IDLE_CAP_MS, idleCapAction, idleCapReached, KILL_AFTER_MS, LONGEST_COMPILE_MS, SLEEP_AFTER_MS } from "../src/idle-cap.ts";

const MIN = 60_000;

test("the cap can never cut off a real compile or beat the normal sleep clock", () => {
	const server = readFileSync(new URL("../container/server.js", import.meta.url), "utf8");
	const m = server.match(/COMPILE_TIMEOUT_MS = ESP32 \? ([\d_]+) : ([\d_]+)/);
	assert.ok(m, "COMPILE_TIMEOUT_MS not found in container/server.js");
	const longest = Math.max(Number(m[1].replace(/_/g, "")), Number(m[2].replace(/_/g, "")));
	assert.equal(LONGEST_COMPILE_MS, longest, "LONGEST_COMPILE_MS must follow container/server.js");
	// a draining line answers at least once per compile, so the cap needs only a few compiles of slack
	assert.ok(IDLE_CAP_MS >= 4 * LONGEST_COMPILE_MS);
	assert.ok(IDLE_CAP_MS > SLEEP_AFTER_MS);
	assert.match(server, /process\.on\("SIGTERM"/, "server.js must exit on SIGTERM or the stop cannot land");
});

test("stop after the cap, kill a minute later if still up, nothing while in use", () => {
	const t0 = 1_000_000;
	assert.equal(idleCapAction(t0 + IDLE_CAP_MS - 1, t0, true, null), "none");
	assert.equal(idleCapAction(t0 + IDLE_CAP_MS, t0, true, null), "stop");
	const sent = t0 + IDLE_CAP_MS;
	assert.equal(idleCapAction(sent + KILL_AFTER_MS - 1, t0, true, sent), "none");
	assert.equal(idleCapAction(sent + KILL_AFTER_MS, t0, true, sent), "kill");
	assert.equal(idleCapReached(t0 + 60 * MIN, t0, false), false, "a stopped container is left alone");
	// activity after a stop starts the clock again: no kill for an old stop
	assert.equal(idleCapAction(sent + 2 * MIN, sent + MIN, true, sent), "none");
});

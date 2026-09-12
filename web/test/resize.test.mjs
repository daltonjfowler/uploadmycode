/**
 * The clamp math behind the two panel handles.
 *
 * Run with `npm test`. Node runs web/src/resize.ts directly (it strips the
 * types), so this tests the exact functions the browser uses. Everything below
 * is pure arithmetic on pixel numbers: the DOM half of resize.ts — measuring,
 * pointer capture, writing the custom property — is not reachable from here and
 * is what the click-through steps in docs/T2-TEST.md are for.
 *
 * The one rule the whole file is checking: a panel may take every pixel the
 * editor can spare and not one more. "Can spare" means the editor stays at or
 * above its 12rem floor, which is also what keeps the toolbar and the footer on
 * screen — the column only outgrows the viewport once the editor is under it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	clampHeight,
	dragHeight,
	EDITOR_MIN_REM,
	heightLimits,
	KEY_STEP_REM,
	MONITOR_LOG_MIN_REM,
	OUTPUT_MIN_REM,
	resolveHeight,
} from "../src/resize.ts";

/** One rem at the browser default, which is what the page uses. */
const REM = 16;
const EDITOR_MIN = EDITOR_MIN_REM * REM; // 192
const OUTPUT_MIN = OUTPUT_MIN_REM * REM; // 56
const MONITOR_MIN = MONITOR_LOG_MIN_REM * REM; // 64

/** A roomy Chromebook: the editor has 300px more than its floor to give. */
function roomy(startHeight, min = OUTPUT_MIN) {
	return heightLimits({
		min,
		startHeight,
		editorHeight: EDITOR_MIN + 300,
		editorMin: EDITOR_MIN,
	});
}

test("the floors are the ones the stylesheet and the task agreed on", () => {
	assert.equal(EDITOR_MIN_REM, 12);
	assert.equal(OUTPUT_MIN_REM, 3.5);
	assert.equal(MONITOR_LOG_MIN_REM, 4);
	assert.equal(KEY_STEP_REM, 1);
});

// ------------------------------------------------------------------- limits

test("the ceiling is the panel's own height plus every pixel the editor can spare", () => {
	const limits = heightLimits({
		min: OUTPUT_MIN,
		startHeight: 120,
		editorHeight: 500,
		editorMin: EDITOR_MIN,
	});
	assert.equal(limits.min, OUTPUT_MIN);
	// 500 - 192 = 308 spare, on top of the 120 the panel already has.
	assert.equal(limits.max, 428);
});

test("an editor sitting exactly on its floor has nothing left to give", () => {
	const limits = heightLimits({
		min: OUTPUT_MIN,
		startHeight: 200,
		editorHeight: EDITOR_MIN,
		editorMin: EDITOR_MIN,
	});
	assert.equal(limits.max, 200, "the panel may keep what it has and grow no further");
});

test("a viewport too short for the floors sends the panel to its smallest", () => {
	// The page is already scrolling: the editor is 40px under its floor.
	const limits = heightLimits({
		min: OUTPUT_MIN,
		startHeight: 200,
		editorHeight: EDITOR_MIN - 40,
		editorMin: EDITOR_MIN,
	});
	// 200 - 40 = 160, still above the floor, so the panel gives back 40px.
	assert.equal(limits.max, 160);
});

test("the ceiling never drops under the floor, however short the window is", () => {
	const limits = heightLimits({
		min: MONITOR_MIN,
		startHeight: 80,
		editorHeight: 20,
		editorMin: EDITOR_MIN,
	});
	assert.equal(limits.min, MONITOR_MIN);
	assert.equal(limits.max, MONITOR_MIN, "inverted limits would clamp to nonsense");
	assert.ok(limits.max >= limits.min);
});

// -------------------------------------------------------------------- clamp

test("a height inside its limits is kept, rounded to whole pixels", () => {
	const limits = roomy(120);
	assert.equal(clampHeight(240, limits), 240);
	assert.equal(clampHeight(240.4, limits), 240);
	assert.equal(clampHeight(239.6, limits), 240);
});

test("below the floor comes back as the floor", () => {
	const limits = roomy(120);
	assert.equal(clampHeight(0, limits), OUTPUT_MIN);
	assert.equal(clampHeight(-4000, limits), OUTPUT_MIN);
	assert.equal(clampHeight(OUTPUT_MIN - 1, limits), OUTPUT_MIN);
});

test("above the ceiling comes back as the ceiling", () => {
	const limits = roomy(120); // max 420
	assert.equal(limits.max, 420);
	assert.equal(clampHeight(421, limits), 420);
	assert.equal(clampHeight(99999, limits), 420);
});

test("nonsense is not a height: it reads as the floor, never as NaN on screen", () => {
	const limits = roomy(120);
	assert.equal(clampHeight(Number.NaN, limits), OUTPUT_MIN);
	assert.equal(clampHeight(Number.POSITIVE_INFINITY, limits), OUTPUT_MIN);
	assert.equal(clampHeight(Number.NEGATIVE_INFINITY, limits), OUTPUT_MIN);
});

// --------------------------------------------------------------------- drag

test("dragging up grows the panel one pixel per pixel", () => {
	const limits = roomy(120);
	// The handle started at y=400 and the pointer is now 60px higher.
	assert.equal(dragHeight(120, 400, 340, limits), 180);
});

test("dragging down shrinks it the same way", () => {
	const limits = roomy(120);
	assert.equal(dragHeight(120, 400, 440, limits), 80);
});

test("a drag that never moved leaves the height alone", () => {
	const limits = roomy(120);
	assert.equal(dragHeight(120, 400, 400, limits), 120);
});

test("dragging past the editor's floor stops at the ceiling", () => {
	const limits = roomy(120); // 300px of slack, so max 420
	// Flung to the top of the screen: 400px of travel, only 300 of it allowed.
	assert.equal(dragHeight(120, 400, 0, limits), 420);
});

test("dragging past the panel's floor stops at the floor", () => {
	const limits = roomy(120);
	assert.equal(dragHeight(120, 400, 900, limits), OUTPUT_MIN);
});

test("the monitor log has its own floor and is clamped against it", () => {
	const limits = roomy(200, MONITOR_MIN);
	assert.equal(dragHeight(200, 300, 800, limits), MONITOR_MIN);
	assert.equal(dragHeight(200, 300, 290, limits), 210);
});

// ------------------------------------------------------- restore, and reset

test("a height saved on a big monitor is cut down to fit a Chromebook", () => {
	const saved = 700; // dragged on a 1440p screen
	// Restored on a 768px Chromebook: the output is at its automatic 180px and
	// the editor has 140px to spare.
	const limits = heightLimits({
		min: OUTPUT_MIN,
		startHeight: 180,
		editorHeight: EDITOR_MIN + 140,
		editorMin: EDITOR_MIN,
	});
	assert.equal(resolveHeight(saved, limits), 320, "180 + 140, and not a pixel of the editor's floor");
});

test("the same saved height is given back in full on the big screen again", () => {
	const saved = 700;
	const limits = heightLimits({
		min: OUTPUT_MIN,
		startHeight: 180,
		editorHeight: EDITOR_MIN + 900,
		editorMin: EDITOR_MIN,
	});
	assert.equal(resolveHeight(saved, limits), 700);
});

test("a saved height smaller than the floor is lifted to the floor", () => {
	const limits = roomy(120, MONITOR_MIN);
	assert.equal(resolveHeight(8, limits), MONITOR_MIN);
});

test("reset is null, and null survives every clamp untouched", () => {
	assert.equal(resolveHeight(null, roomy(120)), null);
	assert.equal(resolveHeight(null, roomy(700, MONITOR_MIN)), null);
	// Even when the window is far too short to hold anything.
	const squeezed = heightLimits({
		min: OUTPUT_MIN,
		startHeight: 300,
		editorHeight: 10,
		editorMin: EDITOR_MIN,
	});
	assert.equal(
		resolveHeight(null, squeezed),
		null,
		"null means 'let the stylesheet decide', which is not a number to clamp",
	);
});

// ------------------------------------------------------------------- arrows

test("one arrow press moves a handle one rem, and repeats stack up", () => {
	const limits = roomy(120);
	const step = KEY_STEP_REM * REM;

	let height = 120;
	for (let press = 0; press < 3; press += 1) height = clampHeight(height + step, limits);
	assert.equal(height, 120 + 3 * step);

	for (let press = 0; press < 3; press += 1) height = clampHeight(height - step, limits);
	assert.equal(height, 120);
});

test("holding an arrow down cannot walk past either limit", () => {
	const limits = roomy(120); // 56 .. 420
	const step = KEY_STEP_REM * REM;

	let height = 120;
	for (let press = 0; press < 100; press += 1) height = clampHeight(height + step, limits);
	assert.equal(height, limits.max);

	for (let press = 0; press < 100; press += 1) height = clampHeight(height - step, limits);
	assert.equal(height, limits.min);
});

/**
 * Drag-to-resize for the Output and Serial Monitor panels.
 *
 * The model, in one sentence: **a handle sets an explicit pixel height on the
 * one box below it that is allowed to change size, and the editor — the only
 * `flex: 1 1 0` row in the column — absorbs the difference.**
 *
 * Which box that is differs by panel, and deliberately so:
 *
 * - The Output handle sizes the whole `.output` section. Everything in it is
 *   content, and the section is already the panel's one scroll container.
 * - The Serial Monitor handle sizes the monitor's *log box* — the `<pre>` in
 *   text view, the canvas in plot view, which share one height. The control
 *   rows above and the message box below are fixed chrome that must stay on
 *   screen at every size, so they are not the monitor's to give away. Dragging
 *   the handle still moves the top of the whole section one pixel per pixel,
 *   because that chrome never changes height, so it reads exactly the same as
 *   the Output handle from the outside.
 *
 * Heights are written as a CSS custom property rather than a plain inline
 * height, so the stylesheet keeps the say over which box the number sizes and
 * what the automatic size is when there is no number at all.
 *
 * The clamp math at the top has no DOM in it, so `web/test/resize.test.mjs`
 * runs it directly. The wiring below is the part that measures and listens.
 */

// ---------------------------------------------------------------- the floors

/**
 * The editor's own floor, in rem. It is `min-height` on `.editor` in the
 * stylesheet; this is the fallback used when that cannot be read, and the
 * number the tests are written against.
 */
export const EDITOR_MIN_REM = 12;

/** Output: the head strip and one line of message under it. */
export const OUTPUT_MIN_REM = 3.5;

/** The monitor's log box: about two lines, enough to see that it is alive. */
export const MONITOR_LOG_MIN_REM = 4;

/** How far one press of an arrow key moves a handle. */
export const KEY_STEP_REM = 1;

// ------------------------------------------------------------- the clamp math

export interface HeightLimits {
	/** Smallest the box may be, in px. */
	min: number;
	/** Largest it may be before the editor would drop through its floor, in px. */
	max: number;
}

export interface LimitInput {
	/** The panel's own floor, in px. */
	min: number;
	/** What the box measures right now, in px. */
	startHeight: number;
	/** What the editor measures right now, in px. */
	editorHeight: number;
	/** The editor's floor, in px. */
	editorMin: number;
}

/**
 * What a panel is allowed to be, given what is on screen right now.
 *
 * The ceiling is the whole trick. Every pixel the panel takes comes straight
 * out of the editor, so `startHeight + editorHeight` does not change while a
 * handle is dragged — which makes "the editor keeps its floor" the same
 * sentence as "the panel stops at its start height plus the editor's slack".
 * That is also why the ceiling can be worked out once, when the drag starts,
 * instead of measured on every pointer move.
 *
 * It is what keeps the toolbar and the footer on screen too: they are only
 * pushed off the bottom once the column is taller than the viewport, and the
 * column can only get taller than the viewport once the editor is under its
 * floor.
 *
 * On a viewport too short to hold the floors at all the slack is negative, the
 * ceiling would land under the floor, and the floor wins: the panel goes to its
 * smallest and the page scrolls, which is what `html { overflow-y: auto }` is
 * there for.
 */
export function heightLimits(input: LimitInput): HeightLimits {
	const slack = input.editorHeight - input.editorMin;
	return { min: input.min, max: Math.max(input.min, input.startHeight + slack) };
}

/** A height, rounded to whole pixels and kept inside its limits. */
export function clampHeight(desired: number, limits: HeightLimits): number {
	if (!Number.isFinite(desired)) return limits.min;
	return Math.min(limits.max, Math.max(limits.min, Math.round(desired)));
}

/**
 * The height to put on screen for what the student asked for. `null` stays
 * `null`: that is "no override", and the stylesheet's automatic size is then
 * the answer. Double-clicking a handle is exactly this, with `null`.
 */
export function resolveHeight(wish: number | null, limits: HeightLimits): number | null {
	return wish === null ? null : clampHeight(wish, limits);
}

/**
 * Where a drag lands. Up is bigger: the handle sits on the panel's top edge, so
 * dragging it towards the toolbar grows the panel under it, one pixel per
 * pixel, which is what every other pane splitter does.
 */
export function dragHeight(
	startHeight: number,
	startY: number,
	currentY: number,
	limits: HeightLimits,
): number {
	return clampHeight(startHeight + (startY - currentY), limits);
}

// ------------------------------------------------------------------ the wiring

export interface PanelResizeOptions {
	/** The grab bar. Also the element the ARIA values are written to. */
	handle: HTMLElement;
	/** Where the custom property is written. It may inherit down to the real box. */
	styleTarget: HTMLElement;
	/** The custom property that carries the height, e.g. `--output-height`. */
	property: string;
	/** Measures the box that property sizes, as it is right now. */
	measure(): number;
	/** The one flexible row, which absorbs whatever the panel takes or gives. */
	editor: HTMLElement;
	/** The panel's floor, in rem. */
	minRem: number;
	/** A height the student chose, or null for "back to automatic". Persist it. */
	onChange(height: number | null): void;
	/** Called after every size change, so a canvas below can re-fit. */
	onResized(): void;
}

export interface PanelResize {
	/** Put a remembered height back, clamped against the screen it is landing on. */
	restore(stored: number | null): void;
	/** Re-clamp what is on screen. For window resizes and for panels appearing. */
	reclamp(): void;
	/** Back to the stylesheet's automatic size, and forget the stored height. */
	reset(): void;
}

function remToPx(rem: number): number {
	const root = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
	return rem * (Number.isFinite(root) && root > 0 ? root : 16);
}

/**
 * The editor's floor, read off the element so the stylesheet stays the one
 * place it is written down. The constant is only the fallback.
 */
function editorFloor(editor: HTMLElement): number {
	const declared = Number.parseFloat(window.getComputedStyle(editor).minHeight);
	return Number.isFinite(declared) && declared > 0 ? declared : remToPx(EDITOR_MIN_REM);
}

interface Drag {
	pointerId: number;
	startY: number;
	startHeight: number;
	limits: HeightLimits;
}

/** Wire one handle to one panel. */
export function createPanelResize(options: PanelResizeOptions): PanelResize {
	const { handle, styleTarget, property, editor } = options;

	/** What the student asked for, before clamping. null means automatic. */
	let wish: number | null = null;
	let drag: Drag | null = null;

	function limitsAt(startHeight: number): HeightLimits {
		return heightLimits({
			min: remToPx(options.minRem),
			startHeight,
			editorHeight: editor.offsetHeight,
			editorMin: editorFloor(editor),
		});
	}

	/**
	 * Where the handle is and how far it may go, in pixels. A focusable
	 * separator is a slider in ARIA's eyes and owes a screen reader all three
	 * numbers, including on a first visit where nothing has been dragged yet.
	 */
	function refreshAria(landed: number): void {
		const limits = limitsAt(landed);
		handle.setAttribute("aria-valuenow", String(Math.round(landed)));
		handle.setAttribute("aria-valuemin", String(Math.round(limits.min)));
		handle.setAttribute("aria-valuemax", String(Math.round(limits.max)));
	}

	/**
	 * Write a height. The measurement is taken after the write, so what goes
	 * into the ARIA value is the height really on screen and not the one that
	 * was asked for.
	 */
	function apply(height: number | null): void {
		if (height === null) styleTarget.style.removeProperty(property);
		else styleTarget.style.setProperty(property, `${Math.round(height)}px`);
		refreshAria(options.measure());
		options.onResized();
	}

	/** Arrow keys: one rem a press, in the same direction a drag would go. */
	function nudge(deltaPx: number): void {
		const startHeight = options.measure();
		const next = clampHeight(startHeight + deltaPx, limitsAt(startHeight));
		wish = next;
		apply(next);
		options.onChange(next);
	}

	function reset(): void {
		wish = null;
		apply(null);
		options.onChange(null);
	}

	function restore(stored: number | null): void {
		if (stored === null || !Number.isFinite(stored)) return;
		wish = stored;
		if (handle.hidden) {
			// A collapsed panel has no box to measure, so there is nothing to clamp
			// against yet. Write the number and let the clamp happen when it opens,
			// which is what setMonitorOpen's reclamp is for.
			styleTarget.style.setProperty(property, `${Math.round(stored)}px`);
			return;
		}
		apply(resolveHeight(stored, limitsAt(options.measure())));
	}

	function reclamp(): void {
		if (handle.hidden) return;
		if (wish === null) {
			// Nothing to put back, but the ceiling moved with the window, and this
			// is also the call that gives the handle its first set of values.
			refreshAria(options.measure());
			return;
		}
		apply(resolveHeight(wish, limitsAt(options.measure())));
	}

	handle.addEventListener("pointerdown", (event) => {
		// Left button only. Touch and pen both report 0 here, so they come through.
		if (event.button !== 0) return;
		const startHeight = options.measure();
		drag = {
			pointerId: event.pointerId,
			startY: event.clientY,
			startHeight,
			limits: limitsAt(startHeight),
		};
		// The capture is what makes a drag survive the pointer leaving the 10px
		// bar, which on a fast drag it does immediately.
		handle.setPointerCapture(event.pointerId);
		handle.dataset.dragging = "";
		document.body.classList.add("resizing");
		event.preventDefault();
		handle.focus();
	});

	handle.addEventListener("pointermove", (event) => {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		const next = dragHeight(drag.startHeight, drag.startY, event.clientY, drag.limits);
		if (next === wish) return;
		wish = next;
		apply(next);
	});

	function endDrag(event: PointerEvent): void {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
		drag = null;
		delete handle.dataset.dragging;
		document.body.classList.remove("resizing");
		// Saved once, at the end, rather than on every pointer move.
		options.onChange(wish);
	}

	handle.addEventListener("pointerup", endDrag);
	handle.addEventListener("pointercancel", endDrag);

	handle.addEventListener("dblclick", reset);

	handle.addEventListener("keydown", (event) => {
		if (event.key === "ArrowUp") {
			event.preventDefault();
			nudge(remToPx(KEY_STEP_REM));
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			nudge(-remToPx(KEY_STEP_REM));
		} else if (event.key === "Enter") {
			event.preventDefault();
			reset();
		}
	});

	return { restore, reclamp, reset };
}

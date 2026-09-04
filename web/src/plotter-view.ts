/**
 * The serial plotter's canvas: grid, gridline labels, up to four polylines and
 * a legend.
 *
 * Deliberately hand-drawn 2D canvas rather than a charting library. The whole
 * bundle is already 540 kB and a chart library would be a third of that again
 * on a Chromebook's first load, to draw four polylines. Everything below is
 * `moveTo`/`lineTo`/`fillText`, and it is commented at the level of "what is
 * this number for" because a teacher maintains it.
 *
 * Two rules keep it honest:
 *
 * - Every colour comes from a CSS custom property read at draw time, so light
 *   and dark mode both work and neither has a colour hard-coded here.
 * - It never draws while the panel is hidden. A canvas with no layout has a
 *   client width of 0, and a sketch printing flat out would otherwise burn a
 *   frame's work every 50 ms behind a collapsed panel.
 */

import { formatValue, niceScale, type PlotData, type PlotSeries } from "./plotter.ts";

/** Room above the grid for the legend strip, in CSS pixels. */
const LEGEND_HEIGHT = 20;
/** Gap between the legend and the top gridline. */
const LEGEND_GAP = 6;
/** Breathing room on the right, so the newest sample is not on the edge. */
const PAD_RIGHT = 8;
/** Half a line of text below the bottom gridline, so its label is not clipped. */
const PAD_BOTTOM = 12;
/** Narrowest and widest the gridline-label column is allowed to get. */
const AXIS_MIN_WIDTH = 28;
const AXIS_MAX_WIDTH = 72;
/** Gap between a gridline label and the grid itself. */
const AXIS_GAP = 6;

const LABEL_FONT = "10px ui-monospace, 'Cascadia Mono', Consolas, monospace";
const LEGEND_FONT = "11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Legend swatch size, and the gap between one legend entry and the next. */
const SWATCH = 9;
const LEGEND_SPACING = 14;

export interface PlotView {
	/**
	 * Something changed. Draws on the next frame — or not at all, if the panel
	 * is hidden or frozen. Safe to call on every arriving line.
	 */
	requestDraw(): void;
	/** Tell it whether the panel is on screen. Turning it on draws immediately. */
	setVisible(visible: boolean): void;
	/**
	 * Pause: hold the picture that is on screen now. The caller keeps filling
	 * the data — this only stops the drawing.
	 *
	 * The freeze lives in here rather than in the caller because this object
	 * has listeners of its own: a window resize or a theme flip would otherwise
	 * repaint a "frozen" graph with samples that arrived after it was frozen,
	 * which is the one thing Pause promises will not happen.
	 */
	setFrozen(frozen: boolean): void;
	/** Drop the listeners. Nothing calls this today; the page lives as long as the tab. */
	dispose(): void;
}

/**
 * Wire a canvas to a `PlotData`. The caller pushes samples into the data and
 * calls `requestDraw`; this owns everything to do with pixels.
 */
export function createPlotView(canvas: HTMLCanvasElement, data: PlotData): PlotView {
	const context = canvas.getContext("2d");
	let visible = false;
	let frozen = false;
	let frame = 0;

	// A theme flip repaints the page but not a canvas, so ask for a redraw when
	// the system switches between light and dark.
	const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
	const onThemeChange = (): void => requestDraw();
	darkQuery.addEventListener("change", onThemeChange);

	// The panel is inside a flex column, so it resizes without the window
	// resizing — but the window resizing is the common case and the cheap one.
	const onResize = (): void => requestDraw();
	window.addEventListener("resize", onResize);

	function requestDraw(): void {
		if (!visible || frozen || frame !== 0) return;
		frame = window.requestAnimationFrame(() => {
			frame = 0;
			draw();
		});
	}

	function cancelFrame(): void {
		if (frame === 0) return;
		window.cancelAnimationFrame(frame);
		frame = 0;
	}

	function setVisible(next: boolean): void {
		if (visible === next) return;
		visible = next;
		// Coming back into view keeps whatever is already in the canvas when
		// frozen — requestDraw refuses — which is exactly right: the picture
		// being held is still the picture on screen.
		if (visible) requestDraw();
		else cancelFrame();
	}

	function setFrozen(next: boolean): void {
		if (frozen === next) return;
		frozen = next;
		// A frame already queued would land after the freeze and show one sample
		// more than was on screen when Pause was pressed.
		if (frozen) cancelFrame();
		else requestDraw();
	}

	function dispose(): void {
		setVisible(false);
		darkQuery.removeEventListener("change", onThemeChange);
		window.removeEventListener("resize", onResize);
	}

	/**
	 * Match the backing store to the CSS box times the device pixel ratio, then
	 * scale the drawing so every coordinate below is a CSS pixel. Without this
	 * the graph is a blurry mess on any screen that is not exactly 1x, which on
	 * a Chromebook it usually is not.
	 *
	 * Returns the CSS size, or null when the canvas has no layout — which is
	 * what "the panel is hidden" looks like from here.
	 */
	function resize(): { width: number; height: number } | null {
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		if (width <= 0 || height <= 0 || !context) return null;

		const ratio = window.devicePixelRatio || 1;
		const backingWidth = Math.round(width * ratio);
		const backingHeight = Math.round(height * ratio);
		// Assigning width or height also clears the canvas, so only do it when
		// the size really changed.
		if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
			canvas.width = backingWidth;
			canvas.height = backingHeight;
		}
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		return { width, height };
	}

	/** One CSS custom property off the canvas, so the theme decides the colour. */
	function readColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
		const value = styles.getPropertyValue(name).trim();
		return value === "" ? fallback : value;
	}

	function draw(): void {
		if (!context) return;
		const size = resize();
		if (!size) return;

		const styles = window.getComputedStyle(canvas);
		const background = readColor(styles, "--editor-bg", "#ffffff");
		const gridColor = readColor(styles, "--plot-grid", "#e6e9ee");
		const textColor = readColor(styles, "--muted", "#5b6570");
		const seriesColors = [
			readColor(styles, "--plot-1", "#1a63c8"),
			readColor(styles, "--plot-2", "#b3261e"),
			readColor(styles, "--plot-3", "#1a7f37"),
			readColor(styles, "--plot-4", "#8250df"),
		];

		context.clearRect(0, 0, size.width, size.height);
		context.fillStyle = background;
		context.fillRect(0, 0, size.width, size.height);

		const series = data.getSeries();
		const extent = data.extent();
		// No data yet still gets a grid: an empty panel with axes reads as
		// "waiting", where an empty white rectangle reads as "broken".
		const scale = niceScale(extent?.min ?? Number.NaN, extent?.max ?? Number.NaN);

		// The gridline labels decide how much room the axis column needs, so
		// measure them before deciding where the grid starts.
		context.font = LABEL_FONT;
		let axisWidth = AXIS_MIN_WIDTH;
		for (const tick of scale.ticks) {
			const text = formatValue(tick, scale.decimals);
			axisWidth = Math.max(axisWidth, context.measureText(text).width + AXIS_GAP);
		}
		axisWidth = Math.min(AXIS_MAX_WIDTH, axisWidth);

		const left = axisWidth;
		const right = size.width - PAD_RIGHT;
		const top = LEGEND_HEIGHT + LEGEND_GAP;
		const bottom = size.height - PAD_BOTTOM;
		const plotWidth = right - left;
		const plotHeight = bottom - top;
		// A panel squeezed to nothing — a very short window — draws the legend
		// and stops rather than drawing a grid inside out.
		if (plotWidth <= 4 || plotHeight <= 4) {
			drawLegend(context, series, seriesColors, textColor, scale.decimals, size.width);
			return;
		}

		// The vertical span never divides by zero: niceScale pads a flat line
		// out to a range of 2, and the empty scale is 0..1.
		const span = scale.max - scale.min || 1;
		const yOf = (value: number): number => bottom - ((value - scale.min) / span) * plotHeight;

		// --- grid and its labels
		context.strokeStyle = gridColor;
		context.fillStyle = textColor;
		context.lineWidth = 1;
		context.textAlign = "right";
		context.textBaseline = "middle";
		for (const tick of scale.ticks) {
			// The 0.5 offset puts a 1px line on a pixel instead of across two,
			// which is the difference between a crisp hairline and a grey smear.
			const y = Math.round(yOf(tick)) + 0.5;
			context.beginPath();
			context.moveTo(left, y);
			context.lineTo(right, y);
			context.stroke();
			context.fillText(formatValue(tick, scale.decimals), left - AXIS_GAP, y);
		}

		// --- the series themselves
		context.lineWidth = 1.5;
		context.lineJoin = "round";
		context.lineCap = "round";
		for (let s = 0; s < series.length; s += 1) {
			const buffer = series[s].buffer;
			const count = buffer.length;
			if (count === 0) continue;
			context.strokeStyle = seriesColors[s % seriesColors.length];

			if (count === 1) {
				// One sample is not a line. Draw the dot so the first reading of a
				// slow sketch is visible instead of nothing at all.
				context.fillStyle = context.strokeStyle;
				context.beginPath();
				context.arc(left + plotWidth / 2, yOf(buffer.at(0)), 2, 0, Math.PI * 2);
				context.fill();
				continue;
			}

			// The samples always span the full width: the oldest one held is at
			// the left edge and the newest at the right. While the buffer fills
			// the line stretches; once it is full — 500 samples — it scrolls,
			// which is what the desktop plotter does and what a student expects.
			context.beginPath();
			for (let i = 0; i < count; i += 1) {
				const x = left + (i / (count - 1)) * plotWidth;
				const y = yOf(buffer.at(i));
				if (i === 0) context.moveTo(x, y);
				else context.lineTo(x, y);
			}
			context.stroke();
		}

		// --- legend, and the "nothing yet" line
		drawLegend(context, series, seriesColors, textColor, scale.decimals, size.width);
		if (data.isEmpty()) {
			context.fillStyle = textColor;
			context.font = LEGEND_FONT;
			context.textAlign = "center";
			context.textBaseline = "middle";
			context.fillText(
				"Waiting for numbers. Print them with Serial.println.",
				left + plotWidth / 2,
				top + plotHeight / 2,
			);
		}
	}

	/**
	 * The strip along the top: a coloured square, the series name, and what it
	 * reads right now. Entries that would run off the right-hand edge are left
	 * out rather than overlapping — with four series and short names that does
	 * not happen, and with long names a clipped legend beats a smeared one.
	 */
	function drawLegend(
		ctx: CanvasRenderingContext2D,
		series: readonly PlotSeries[],
		colors: string[],
		textColor: string,
		decimals: number,
		width: number,
	): void {
		ctx.font = LEGEND_FONT;
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		const middle = LEGEND_HEIGHT / 2;
		let x = 2;

		for (let s = 0; s < series.length; s += 1) {
			const entry = series[s];
			const reading = entry.buffer.length === 0 ? "-" : formatValue(entry.buffer.last(), decimals);
			const text = `${entry.label}  ${reading}`;
			const entryWidth = SWATCH + 4 + ctx.measureText(text).width;
			if (x + entryWidth > width - 2) break;

			ctx.fillStyle = colors[s % colors.length];
			ctx.fillRect(x, middle - SWATCH / 2, SWATCH, SWATCH);
			ctx.fillStyle = textColor;
			ctx.fillText(text, x + SWATCH + 4, middle);
			x += entryWidth + LEGEND_SPACING;
		}
	}

	return { requestDraw, setVisible, setFrozen, dispose };
}

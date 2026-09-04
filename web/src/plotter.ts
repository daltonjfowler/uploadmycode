/**
 * The serial plotter's arithmetic: read numbers out of a line, keep the last
 * few hundred of them, and work out where the gridlines go.
 *
 * Nothing here touches the DOM or a canvas — `plotter-view.ts` does the
 * drawing — so every rule below is checked by `node --test` instead of by
 * squinting at a graph. That matters most for the parser: whether a line is a
 * data line or ordinary text decides whether it appears on the graph at all,
 * and getting that wrong is invisible until a student's sketch prints
 * something slightly unusual.
 */

/**
 * How many lines are kept per series. 500 samples at the 50 ms most lesson
 * sketches print at is 25 seconds of history, which is about as much as fits
 * across a Chromebook's screen legibly.
 */
export const PLOT_CAPACITY = 500;

/**
 * How many series are drawn. The desktop plotter allows more; four is as many
 * as stay tellable apart on a panel this short, and four colours is as many as
 * read clearly in both themes.
 */
export const MAX_SERIES = 4;

/** One number pulled off a line, with the label that was written in front of it. */
export interface PlotValue {
	/** The `label` of `label:value`, or null when the number arrived bare. */
	label: string | null;
	value: number;
}

/**
 * A number, and nothing else, in the shapes `Serial.print` produces: `12`,
 * `-3.5`, `.5`, `1e3`. Deliberately strict — `Number("")` is 0 and
 * `Number(" 12 ")` is 12, so `Number` alone would turn blank and padded
 * gibberish into data. `inf`, `nan` and `ovf`, which the Uno prints for a
 * broken float, all fail this and keep their line off the graph.
 */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Values are separated by any run of spaces, tabs or commas. */
const SEPARATORS = /[\s,]+/;

/**
 * Read one line from the board as plot data, or return null to leave it as
 * text in the monitor and nothing else.
 *
 * What counts as data, in the order the rules are applied:
 *
 * - Values are separated by spaces, tabs or commas, in any mixture, so
 *   `1 2 3`, `1,2,3` and `1,\t2 3` are the same three numbers.
 * - `temp:23.5` names the series it belongs to. So does `temp: 23.5` with a
 *   space after the colon — that second form is what `Serial.print("temp: ")`
 *   followed by `Serial.println(x)` actually sends, and it is what the
 *   classroom's own counter sketch prints, so a plotter that ignored it would
 *   look broken to exactly the students most likely to try it.
 * - **Every** value on the line must be a number. One word anywhere and the
 *   whole line is text: `counter ready` and `you said: hello` belong in the
 *   monitor, not on the graph, and a line that is half-and-half is far more
 *   likely to be a sentence than a reading.
 * - Past four values the rest are dropped rather than the line being refused.
 *
 * An empty line is not data; it is what a board sends between paragraphs.
 */
export function parsePlotLine(line: string): PlotValue[] | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;

	const tokens = trimmed.split(SEPARATORS);
	const values: PlotValue[] = [];
	/** A `name:` token with nothing after it, waiting for the next token. */
	let pendingLabel: string | null = null;

	for (const token of tokens) {
		if (token === "") continue;

		let label = pendingLabel;
		let numberText = token;

		// The last colon splits the pair, so a label may contain one.
		const colon = token.lastIndexOf(":");
		if (colon >= 0) {
			const name = token.slice(0, colon).trim();
			const after = token.slice(colon + 1);
			if (after === "") {
				// `temp:` on its own: the number is the next token along. Two labels
				// in a row is not a reading, it is prose.
				if (pendingLabel !== null || name === "") return null;
				pendingLabel = name;
				continue;
			}
			// `temp:23.5` carries its own label, so a label still pending in front
			// of it was never a label at all.
			if (pendingLabel !== null) return null;
			label = name === "" ? null : name;
			numberText = after;
		}

		if (!NUMBER.test(numberText)) return null;
		const value = Number(numberText);
		if (!Number.isFinite(value)) return null;

		values.push({ label, value });
		pendingLabel = null;
	}

	// A label with no number behind it, or a line of separators.
	if (pendingLabel !== null || values.length === 0) return null;

	return values.slice(0, MAX_SERIES);
}

/**
 * A fixed-size ring of numbers: pushing past the end drops the oldest one.
 *
 * A ring rather than an array with `shift()` because a sketch printing flat
 * out pushes thousands of samples a minute and `shift()` on a 500-element
 * array copies it every time. Here every push is one array write.
 */
export class PlotBuffer {
	readonly capacity: number;
	private readonly data: Float64Array;
	/** Where the oldest sample sits in `data`. */
	private start = 0;
	private count = 0;

	constructor(capacity: number = PLOT_CAPACITY) {
		this.capacity = Math.max(1, Math.floor(capacity));
		this.data = new Float64Array(this.capacity);
	}

	get length(): number {
		return this.count;
	}

	push(value: number): void {
		this.data[(this.start + this.count) % this.capacity] = value;
		if (this.count < this.capacity) {
			this.count += 1;
		} else {
			// Full: the write above landed on the oldest sample, so that slot is
			// now the newest and the one after it is the oldest.
			this.start = (this.start + 1) % this.capacity;
		}
	}

	/** Sample `index` counting from the oldest. Out of range gives NaN. */
	at(index: number): number {
		if (index < 0 || index >= this.count) return Number.NaN;
		return this.data[(this.start + index) % this.capacity];
	}

	/** The newest sample, or NaN when there is nothing yet. */
	last(): number {
		return this.at(this.count - 1);
	}

	/** Oldest first. Used by the tests and by nothing on the hot path. */
	toArray(): number[] {
		const out: number[] = new Array(this.count);
		for (let i = 0; i < this.count; i += 1) out[i] = this.at(i);
		return out;
	}

	clear(): void {
		this.start = 0;
		this.count = 0;
	}
}

/** One line on the graph. */
export interface PlotSeries {
	/** What the legend says. `Series 1` until the board sends a label. */
	label: string;
	buffer: PlotBuffer;
}

/**
 * The up-to-four series, filled from parsed lines.
 *
 * Series are matched by position, not by name: the first number on every line
 * is series one. That is what the desktop plotter does, it is what makes an
 * unlabelled `1 2 3` work at all, and it means a sketch that renames its
 * columns mid-run moves the label rather than starting a fifth line.
 *
 * Each series keeps its own ring, so a line that prints fewer numbers than
 * usual simply does not extend the missing ones. A sketch printing the same
 * columns every time — which is every sketch a lesson produces — keeps them
 * exactly in step.
 */
export class PlotData {
	private series: PlotSeries[] = [];
	private readonly capacity: number;
	/** Bumped on every change, so a renderer can skip idle frames. */
	private revision = 0;

	constructor(capacity: number = PLOT_CAPACITY) {
		this.capacity = capacity;
	}

	getSeries(): readonly PlotSeries[] {
		return this.series;
	}

	getRevision(): number {
		return this.revision;
	}

	isEmpty(): boolean {
		return this.series.every((s) => s.buffer.length === 0);
	}

	/** Add one parsed line. Values past the fourth were dropped by the parser. */
	ingest(values: readonly PlotValue[]): void {
		for (let i = 0; i < values.length && i < MAX_SERIES; i += 1) {
			const value = values[i];
			let series = this.series[i];
			if (!series) {
				series = { label: `Series ${i + 1}`, buffer: new PlotBuffer(this.capacity) };
				this.series[i] = series;
			}
			// A named column keeps its name; an unnamed one does not wipe it.
			if (value.label !== null) series.label = value.label;
			series.buffer.push(value.value);
		}
		this.revision += 1;
	}

	/** Forget everything, including the labels and how many series there were. */
	clear(): void {
		this.series = [];
		this.revision += 1;
	}

	/**
	 * The lowest and highest sample across every series, or null when there is
	 * nothing to show yet. One shared vertical scale for all four lines: two
	 * series on two scales look alike and mean different things, which is worse
	 * than one series being drawn flat because its neighbour is bigger.
	 */
	extent(): { min: number; max: number } | null {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const series of this.series) {
			for (let i = 0; i < series.buffer.length; i += 1) {
				const value = series.buffer.at(i);
				if (value < min) min = value;
				if (value > max) max = value;
			}
		}
		return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
	}

	/** The longest series, which is how wide the graph has to be. */
	longest(): number {
		let longest = 0;
		for (const series of this.series) longest = Math.max(longest, series.buffer.length);
		return longest;
	}
}

export interface Scale {
	/** The bottom of the axis: at or below the lowest sample. */
	min: number;
	/** The top of the axis: at or above the highest sample. */
	max: number;
	/** Where the gridlines go, low to high, `min` and `max` included. */
	ticks: number[];
	/** Decimal places the ticks need, so the labels agree with each other. */
	decimals: number;
}

/** How many gridlines to aim for. The result is allowed to land on 4, 5 or 6. */
const TARGET_TICKS = 5;
const MIN_TICKS = 4;
const MAX_TICKS = 6;

/**
 * Round the axis outwards to friendly numbers.
 *
 * The step is always 1, 2 or 5 times a power of ten, so the labels read 0, 25,
 * 50, 75, 100 rather than 0, 23.7, 47.4 — which is the whole point of an
 * autoscaling graph a student is meant to read a value off.
 *
 * The awkward cases, all of which a real sketch produces:
 *
 * - A flat line (`analogRead` on an untouched pin) has min === max, so there
 *   is no range to divide. It gets ±1 around the value, which keeps the line
 *   in the middle of the panel instead of on an edge.
 * - A tiny range, e.g. 0.001 to 0.002, uses the same ladder of steps; the step
 *   just comes out very small and `decimals` grows to match.
 * - Nothing at all, or NaN, gives 0..1 rather than throwing.
 */
export function niceScale(min: number, max: number): Scale {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return { ...EMPTY_SCALE };
	if (min > max) [min, max] = [max, min];

	// One value, or 500 copies of it: invent a range around it.
	if (min === max) {
		min -= 1;
		max += 1;
	}

	let step = niceStep((max - min) / (TARGET_TICKS - 1));

	// The 1-2-5 rounding can land on one step more or fewer than asked for.
	// Widening or narrowing the step by one notch is enough to pull it back
	// into 4..6; the loop is bounded so a pathological range cannot spin.
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const count = tickCount(min, max, step);
		if (count > MAX_TICKS) {
			step = nextStepUp(step);
		} else if (count < MIN_TICKS) {
			step = nextStepDown(step);
		} else {
			break;
		}
	}

	// Given the choice, take the whole-number rung: 0, 2, 4, 6, 8, 10 reads
	// better than 0, 2.5, 5, 7.5, 10 for data that is whole numbers anyway. The
	// 2.5 rung only survives where nothing else fits in 4..6 gridlines, which is
	// exactly the 0..1023 case it was added for.
	if (rungOf(step).index === STEPS.indexOf(2.5)) {
		const plainer = nextStepDown(step);
		const count = tickCount(min, max, plainer);
		if (count >= MIN_TICKS && count <= MAX_TICKS) step = plainer;
	}

	const decimals = decimalsFor(step);
	const low = Math.floor(min / step) * step;
	const high = Math.ceil(max / step) * step;

	const ticks: number[] = [];
	const count = tickCount(min, max, step);
	for (let i = 0; i < count; i += 1) {
		// Multiplying out from `low` rather than adding repeatedly: adding 0.1
		// five times is 0.5000000000000001, and that lands in a tick label.
		ticks.push(round(low + i * step, decimals));
	}

	// Rounding the bounds to the labels' own precision can shave a hair off
	// them — three steps of 1e-4 is 0.00030000000000000003, and 0.0003 is below
	// it — and a bound that no longer contains the data clips the top of the
	// trace off the panel. So the rounded bound is only taken when it is the
	// wider of the two. The gridlines stay on the round numbers either way;
	// the difference is far under a pixel.
	return {
		min: Math.min(round(low, decimals), min),
		max: Math.max(round(high, decimals), max),
		ticks,
		decimals,
	};
}

/** What the axis reads before a single number has arrived. */
const EMPTY_SCALE: Scale = { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], decimals: 2 };

/** How many gridlines `step` produces between the rounded-out bounds. */
function tickCount(min: number, max: number, step: number): number {
	const low = Math.floor(min / step);
	const high = Math.ceil(max / step);
	// +1 because both ends are drawn. Rounding guards the division: 3 / 0.1 is
	// 29.999999999999996, and flooring that would lose a whole gridline.
	return Math.round(high - low) + 1;
}

/**
 * The ladder of allowed steps, as multipliers of a power of ten.
 *
 * 2.5 is in there for one specific reason: `analogRead` gives 0..1023, and on
 * a plain 1-2-5 ladder the only step with a sane number of gridlines is 500,
 * which puts the top of the axis at 1500 and squashes a full-sweep
 * potentiometer into two thirds of the panel. 250 puts it at 1250, and 250 is
 * a perfectly readable gridline. Quarters are how people count anyway.
 */
const STEPS = [1, 2, 2.5, 5, 10] as const;

/** floor(log10(n)), nudged so log10(1000) landing on 2.999… does not cost a decade. */
function exponentOf(value: number): number {
	return Math.floor(Math.log10(value) + 1e-9);
}

/** The rung of `STEPS` nearest `raw`. The 4..6 loop fixes it if it guessed wrong. */
function niceStep(raw: number): number {
	if (!(raw > 0)) return 1;
	const power = Math.pow(10, exponentOf(raw));
	const fraction = raw / power;
	// Midpoints between the rungs, so "nearest" really is nearest.
	if (fraction < 1.5) return power;
	if (fraction < 2.25) return 2 * power;
	if (fraction < 3.75) return 2.5 * power;
	if (fraction < 7.5) return 5 * power;
	return 10 * power;
}

/** Which rung of `STEPS` a step is on, and at what power of ten. */
function rungOf(step: number): { power: number; index: number } {
	const power = Math.pow(10, exponentOf(step));
	const fraction = step / power;
	let index = 0;
	// The closest rung, so floating-point drift in `step` cannot fall between two.
	for (let i = 1; i < STEPS.length; i += 1) {
		if (Math.abs(fraction - STEPS[i]) < Math.abs(fraction - STEPS[index])) {
			index = i;
		}
	}
	return { power, index };
}

/** 1 → 2 → 2.5 → 5 → 10, used when there are too many gridlines. */
function nextStepUp(step: number): number {
	const { power, index } = rungOf(step);
	// Off the top of the ladder is the bottom of the next decade.
	if (index >= STEPS.length - 1) return 10 * power;
	return STEPS[index + 1] * power;
}

/** The reverse, for when there are too few. */
function nextStepDown(step: number): number {
	const { power, index } = rungOf(step);
	if (index <= 0) return 5 * (power / 10);
	return STEPS[index - 1] * power;
}

/**
 * Decimal places a step needs, so every tick label is written the same width.
 *
 * A step of 25 needs none and a step of 0.05 needs two — that is just the
 * power of ten. The one extra place is for the 2.5 rung: 0.25 needs two
 * decimals where 0.1 needs one. Capped at six, so a step that came out as
 * 1e-9 through floating-point drift cannot produce a label wider than the
 * panel it is drawn in.
 */
function decimalsFor(step: number): number {
	if (!(step > 0)) return 0;
	const { power, index } = rungOf(step);
	const half = STEPS[index] === 2.5 ? 1 : 0;
	return Math.min(6, Math.max(0, -exponentOf(power) + half));
}

function round(value: number, decimals: number): number {
	const factor = Math.pow(10, decimals);
	// +0 turns -0 back into 0, so a tick never reads "-0".
	return Math.round(value * factor) / factor + 0;
}

/**
 * A number as the legend and the axis write it. Fixed decimals so a value
 * jittering around 100 does not make the legend jump between three widths.
 */
export function formatValue(value: number, decimals: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toFixed(decimals);
}

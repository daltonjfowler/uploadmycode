/**
 * The serial plotter's arithmetic.
 *
 * Three things are checked here, in order of how much damage getting them
 * wrong would do:
 *
 * 1. The parser. It decides whether a line is a reading or a sentence, and a
 *    wrong answer is silent — either a sketch's numbers never appear on the
 *    graph, or the word "ready" gets plotted as zero. Every shape a lesson
 *    sketch actually prints is in here.
 * 2. The ring buffer, including the wrap, because after 500 samples every
 *    sample is a wrap and an off-by-one there scrambles the whole graph.
 * 3. `niceScale`, on the ranges real sensors produce: 0..1023 from
 *    `analogRead`, a dead-flat line from an untouched pin, negatives, and
 *    fractions small enough to break a naive step.
 *
 * The last test drives the parser through the real `SerialMonitor` and a fake
 * port, so the split-chunk and CR+LF handling the monitor already has is what
 * feeds the plotter — not a second, hopeful copy of it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SerialMonitor } from "../src/monitor.ts";
import {
	MAX_SERIES,
	PlotBuffer,
	PlotData,
	formatValue,
	niceScale,
	parsePlotLine,
} from "../src/plotter.ts";

/** Just the numbers, when the labels are not what the test is about. */
function numbers(line) {
	const parsed = parsePlotLine(line);
	return parsed === null ? null : parsed.map((v) => v.value);
}

/** `label=value` pairs, written compactly so the assertions stay readable. */
function pairs(line) {
	const parsed = parsePlotLine(line);
	return parsed === null ? null : parsed.map((v) => `${v.label ?? "-"}=${v.value}`);
}

// -------------------------------------------------------------------- parsing

test("values are separated by spaces, tabs or commas, in any mixture", () => {
	assert.deepEqual(numbers("1 2 3"), [1, 2, 3]);
	assert.deepEqual(numbers("1\t2\t3"), [1, 2, 3]);
	assert.deepEqual(numbers("1,2,3"), [1, 2, 3]);
	assert.deepEqual(numbers("1, 2, 3"), [1, 2, 3]);
	// A sketch built out of print() calls produces exactly this kind of mess.
	assert.deepEqual(numbers("1,\t2   3"), [1, 2, 3]);
	// Leading and trailing whitespace is the board's, not the student's.
	assert.deepEqual(numbers("  7  "), [7]);
});

test("the number shapes Serial.print produces all parse", () => {
	assert.deepEqual(numbers("12"), [12]);
	assert.deepEqual(numbers("-3.5"), [-3.5]);
	assert.deepEqual(numbers("+4"), [4]);
	assert.deepEqual(numbers("0.00"), [0]);
	assert.deepEqual(numbers(".5"), [0.5]);
	assert.deepEqual(numbers("23."), [23]);
	assert.deepEqual(numbers("1e3 2E-2"), [1000, 0.02]);
});

test("label:value names the series", () => {
	assert.deepEqual(pairs("temp:23.5 light:512"), ["temp=23.5", "light=512"]);
	// The form a print("temp: ") + println(x) pair actually sends: the space
	// after the colon splits the token, and the label carries to the next one.
	assert.deepEqual(pairs("temp: 23.5"), ["temp=23.5"]);
	assert.deepEqual(pairs("count: 1"), ["count=1"]);
	// Mixed: some columns named, some bare.
	assert.deepEqual(pairs("temp:23.5 512 light:3"), ["temp=23.5", "-=512", "light=3"]);
	assert.deepEqual(pairs("1 2 3"), ["-=1", "-=2", "-=3"]);
	// The last colon splits the pair, so a label may contain one.
	assert.deepEqual(pairs("a:b:1"), ["a:b=1"]);
});

test("five or more values keep the first four", () => {
	assert.deepEqual(numbers("1 2 3 4 5 6 7"), [1, 2, 3, 4]);
	assert.deepEqual(pairs("a:1 b:2 c:3 d:4 e:5"), ["a=1", "b=2", "c=3", "d=4"]);
	assert.equal(parsePlotLine("1 2 3 4 5").length, MAX_SERIES);
});

test("a line that is not all numbers is not data", () => {
	// The notices and prose a lesson sketch prints around its readings.
	assert.equal(parsePlotLine("counter ready"), null);
	assert.equal(parsePlotLine("you said: hello"), null);
	assert.equal(parsePlotLine("Setup complete."), null);
	// Half and half is prose too: a sentence with a number in it.
	assert.equal(parsePlotLine("5 hello"), null);
	assert.equal(parsePlotLine("temp: 23.5 is warm"), null);
	// Two labels running is a colon in a sentence, not two columns.
	assert.equal(parsePlotLine("temp: light: 3"), null);
	// A label with nothing behind it at all.
	assert.equal(parsePlotLine("temp:"), null);
	// What the Uno prints for a broken float. Number() would take all three.
	assert.equal(parsePlotLine("nan"), null);
	assert.equal(parsePlotLine("inf"), null);
	assert.equal(parsePlotLine("ovf"), null);
	// Hexadecimal is a shape Number() accepts and Serial.print never sends.
	assert.equal(parsePlotLine("0x1F"), null);
	// Blank lines are what a board sends between paragraphs.
	assert.equal(parsePlotLine(""), null);
	assert.equal(parsePlotLine("   "), null);
	assert.equal(parsePlotLine(",,,"), null);
});

// --------------------------------------------------------------- ring buffer

test("the ring buffer keeps the newest samples and drops the oldest", () => {
	const buffer = new PlotBuffer(4);
	assert.equal(buffer.length, 0);
	assert.ok(Number.isNaN(buffer.last()), "an empty buffer has no last sample");

	buffer.push(1);
	buffer.push(2);
	buffer.push(3);
	assert.equal(buffer.length, 3);
	assert.deepEqual(buffer.toArray(), [1, 2, 3]);
	assert.equal(buffer.last(), 3);

	// Exactly full: nothing has wrapped yet.
	buffer.push(4);
	assert.equal(buffer.length, 4);
	assert.deepEqual(buffer.toArray(), [1, 2, 3, 4]);

	// Every push from here is a wrap.
	buffer.push(5);
	assert.equal(buffer.length, 4);
	assert.deepEqual(buffer.toArray(), [2, 3, 4, 5]);
	assert.equal(buffer.at(0), 2);
	assert.equal(buffer.at(3), 5);

	// Round the ring several times over: the order must not drift.
	for (let n = 6; n <= 20; n += 1) buffer.push(n);
	assert.deepEqual(buffer.toArray(), [17, 18, 19, 20]);
	assert.equal(buffer.last(), 20);

	// Out of range is NaN, not a stale sample from the other side of the ring.
	assert.ok(Number.isNaN(buffer.at(-1)));
	assert.ok(Number.isNaN(buffer.at(4)));

	buffer.clear();
	assert.equal(buffer.length, 0);
	assert.deepEqual(buffer.toArray(), []);
	buffer.push(99);
	assert.deepEqual(buffer.toArray(), [99], "a cleared ring starts from the beginning again");
});

test("a capacity of one still works", () => {
	const buffer = new PlotBuffer(1);
	buffer.push(1);
	buffer.push(2);
	assert.deepEqual(buffer.toArray(), [2]);
});

// ------------------------------------------------------------------ the series

test("series are matched by position and keep the names they are given", () => {
	const data = new PlotData(10);
	assert.equal(data.isEmpty(), true);
	assert.equal(data.extent(), null, "no data means no scale to draw");

	data.ingest(parsePlotLine("temp:20 light:100"));
	data.ingest(parsePlotLine("temp:22 light:300"));
	assert.equal(data.isEmpty(), false);

	const series = data.getSeries();
	assert.equal(series.length, 2);
	assert.deepEqual(
		series.map((s) => s.label),
		["temp", "light"],
	);
	assert.deepEqual(series[0].buffer.toArray(), [20, 22]);
	assert.deepEqual(series[1].buffer.toArray(), [100, 300]);
	assert.deepEqual(data.extent(), { min: 20, max: 300 });
	assert.equal(data.longest(), 2);

	// An unnamed value must not wipe a name the board already gave.
	data.ingest(parsePlotLine("24 500"));
	assert.deepEqual(
		data.getSeries().map((s) => s.label),
		["temp", "light"],
	);

	// Unnamed from the start gets a placeholder the legend can print.
	const bare = new PlotData(10);
	bare.ingest(parsePlotLine("1 2 3"));
	assert.deepEqual(
		bare.getSeries().map((s) => s.label),
		["Series 1", "Series 2", "Series 3"],
	);

	data.clear();
	assert.equal(data.getSeries().length, 0);
	assert.equal(data.isEmpty(), true);
	assert.equal(data.extent(), null);
});

test("the fifth column is never opened", () => {
	const data = new PlotData(10);
	data.ingest(parsePlotLine("1 2 3 4 5 6"));
	assert.equal(data.getSeries().length, MAX_SERIES);
});

// ------------------------------------------------------------------ the scale

/** The gridline count the drawing code is written against. */
function assertTickCount(scale, where) {
	assert.ok(
		scale.ticks.length >= 4 && scale.ticks.length <= 6,
		`${where}: expected 4-6 gridlines, got ${scale.ticks.length} (${scale.ticks.join(", ")})`,
	);
}

test("an ordinary range gets round gridlines that cover it", () => {
	const scale = niceScale(300, 700);
	assertTickCount(scale, "300..700");
	assert.deepEqual(scale.ticks, [300, 400, 500, 600, 700]);
	assert.equal(scale.min, 300);
	assert.equal(scale.max, 700);
	assert.equal(scale.decimals, 0);

	// The bounds always contain the data, whatever the step lands on.
	const odd = niceScale(17, 143);
	assertTickCount(odd, "17..143");
	assert.ok(odd.min <= 17 && odd.max >= 143);
	assert.equal(odd.ticks[0], odd.min);
	assert.equal(odd.ticks.at(-1), odd.max);
});

test("analogRead's full 0..1023 sweep gets a readable axis", () => {
	const scale = niceScale(0, 1023);
	assertTickCount(scale, "0..1023");
	assert.deepEqual(scale.ticks, [0, 250, 500, 750, 1000, 1250]);
	// The trace must not be squashed into a corner of the panel: the axis is
	// allowed to overshoot the data, but not by half again.
	assert.ok(scale.max < 1023 * 1.5, `axis top ${scale.max} wastes too much of the panel`);
});

test("a flat line is padded rather than divided by zero", () => {
	// An untouched analog pin reading the same value 500 times running.
	const scale = niceScale(512, 512);
	assertTickCount(scale, "flat 512");
	assert.equal(scale.min, 511);
	assert.equal(scale.max, 513);
	assert.ok(scale.ticks.includes(512), "the flat line itself should be on a gridline");

	const zero = niceScale(0, 0);
	assert.equal(zero.min, -1);
	assert.equal(zero.max, 1);
	assertTickCount(zero, "flat 0");
});

test("negative and straddling ranges work", () => {
	const below = niceScale(-100, -20);
	assertTickCount(below, "-100..-20");
	assert.ok(below.min <= -100 && below.max >= -20);

	const across = niceScale(-50, 50);
	assertTickCount(across, "-50..50");
	assert.deepEqual(across.ticks, [-50, -25, 0, 25, 50]);
	// Never "-0".
	assert.ok(!across.ticks.some((t) => Object.is(t, -0)));
});

test("a tiny range still gets sensible gridlines and enough decimals", () => {
	const scale = niceScale(0.001, 0.002);
	assertTickCount(scale, "0.001..0.002");
	assert.ok(scale.min <= 0.001 && scale.max >= 0.002);
	assert.ok(scale.decimals >= 3, `expected room for the digits, got ${scale.decimals}`);
	// Floating point must not leak into a label: 0.30000000000000004 on an axis
	// is the classic tell of a hand-rolled chart.
	for (const tick of scale.ticks) {
		assert.equal(
			formatValue(tick, scale.decimals),
			tick.toFixed(scale.decimals),
			`tick ${tick} does not round-trip through its own label`,
		);
		assert.ok(String(tick).length < 12, `tick ${tick} carries floating-point noise`);
	}
});

test("no data, or nonsense, gives an axis rather than a crash", () => {
	for (const [min, max] of [
		[Number.NaN, Number.NaN],
		[Number.NaN, 5],
		[Number.POSITIVE_INFINITY, 1],
	]) {
		const scale = niceScale(min, max);
		assertTickCount(scale, `${min}..${max}`);
		assert.ok(Number.isFinite(scale.min) && Number.isFinite(scale.max));
	}

	// Handed round the wrong way, which `extent()` cannot produce but a caller
	// could: swapped, not thrown.
	const swapped = niceScale(700, 300);
	assert.ok(swapped.min <= 300 && swapped.max >= 700);
});

test("gridline counts stay in range across every decade a sensor might use", () => {
	for (let power = -4; power <= 6; power += 1) {
		const unit = Math.pow(10, power);
		for (const width of [1, 1.7, 2, 3, 4.5, 7, 9.9]) {
			const scale = niceScale(0, unit * width);
			assertTickCount(scale, `0..${unit * width}`);
			assert.ok(scale.max >= unit * width, `axis top ${scale.max} is under the data`);
		}
	}
});

test("formatValue writes one width, and says so when there is nothing to say", () => {
	assert.equal(formatValue(1, 2), "1.00");
	assert.equal(formatValue(-3.456, 1), "-3.5");
	assert.equal(formatValue(512, 0), "512");
	assert.equal(formatValue(Number.NaN, 0), "—");
});

// ------------------------------------------ the real stream, through the monitor

/**
 * The smallest port `SerialMonitor` will accept, built out of real web streams
 * — the same trick monitor.test.mjs uses. The point here is not the port, it is
 * that the plotter is fed by the monitor's own decoder and line splitter.
 */
class FakePort {
	constructor() {
		this.readable = null;
		this.writable = null;
		this.controller = null;
	}

	async open() {
		this.readable = new ReadableStream({
			start: (controller) => {
				this.controller = controller;
			},
		});
		this.writable = new WritableStream({ write: () => {} });
	}

	async close() {
		this.readable = null;
		this.writable = null;
		this.controller = null;
	}

	pushText(text) {
		this.controller.enqueue(new TextEncoder().encode(text));
	}
}

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("CR+LF lines split across chunks reach the plotter as clean numbers", async () => {
	const port = new FakePort();
	const data = new PlotData(100);
	/** Lines the monitor handed over that were not data. */
	const rejected = [];

	const monitor = new SerialMonitor({
		reopenDelayMs: 0,
		onLine(line) {
			if (line.kind !== "in") return;
			const values = parsePlotLine(line.text);
			if (values === null) rejected.push(line.text);
			else data.ingest(values);
		},
	});

	await monitor.connect(port, 9600);

	// A CR+LF board, with the chunk boundaries falling in the worst places: in
	// the middle of a number, and between the CR and the LF of one line ending.
	// If the monitor's stray-CR handling ever regressed, "23.5\r" would fail the
	// number test and the whole line would vanish off the graph — which is a
	// bug you would never find by looking at the text view.
	port.pushText("raw:400 smooth:39");
	port.pushText("5.5\r");
	port.pushText("\nraw:402 smooth:397.0\r\n");
	port.pushText("sensor ready\r\n");
	port.pushText("raw:404 smooth:399.5\r\n");
	await tick();

	const series = data.getSeries();
	assert.deepEqual(
		series.map((s) => s.label),
		["raw", "smooth"],
	);
	assert.deepEqual(series[0].buffer.toArray(), [400, 402, 404]);
	assert.deepEqual(series[1].buffer.toArray(), [395.5, 397, 399.5]);

	// The word line went to the monitor and nowhere else.
	assert.deepEqual(rejected, ["sensor ready"]);
	// And it is still in the text, so nothing was lost by not plotting it.
	assert.match(monitor.text(), /sensor ready/);

	// One number a line, the space-after-colon form, is just as good.
	port.pushText("count: 7\n");
	await tick();
	assert.equal(data.getSeries()[0].buffer.last(), 7);

	await monitor.disconnect();
});

test("the plot buffer survives the pause an upload needs", async () => {
	const port = new FakePort();
	const data = new PlotData(100);
	const monitor = new SerialMonitor({
		reopenDelayMs: 0,
		reopenAttempts: 2,
		onLine(line) {
			if (line.kind !== "in") return;
			const values = parsePlotLine(line.text);
			if (values !== null) data.ingest(values);
		},
	});

	await monitor.connect(port, 9600);
	port.pushText("1\n2\n3\n");
	await tick();
	assert.deepEqual(data.getSeries()[0].buffer.toArray(), [1, 2, 3]);

	// The whole T4 handover: the port goes to the flasher and comes back.
	assert.equal(await monitor.pauseForUpload(), true);
	await monitor.resumeAfterUpload();
	assert.equal(monitor.getState(), "connected");

	// The history is still there and the new samples land on the end of it. A
	// plotter that cleared on pause would throw away the "before" half of
	// exactly the comparison an upload is being made for.
	port.pushText("4\n5\n");
	await tick();
	assert.deepEqual(data.getSeries()[0].buffer.toArray(), [1, 2, 3, 4, 5]);

	// The monitor's own notices are not readings, however numeric they look.
	assert.match(monitor.text(), /-- Paused for upload/);
	assert.equal(data.getSeries().length, 1);

	await monitor.disconnect();
});

/**
 * The serial monitor, against a fake port.
 *
 * `FakePort` has the four members `MonitorPort` asks for, built out of real
 * web streams, so the monitor's reader, writer, decoder and teardown are the
 * production ones. What the fake adds is bookkeeping: every `open` with its
 * baud rate, every `close`, every byte written, and — the one that matters for
 * the Upload button — whether a `close` ever happened while a lock was still
 * held. A port closed with the reader still attached is exactly the bug that
 * would make "Upload while the monitor is open" fail on a real board.
 *
 * Node runs `web/src/monitor.ts` directly (it strips the types), so this
 * exercises the same file the browser bundle ships.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	BOARD_DISCONNECTED_MESSAGE,
	MonitorError,
	SerialMonitor,
} from "../src/monitor.ts";

class FakePort {
	constructor() {
		/** One entry per open(), with the options the monitor passed. */
		this.opens = [];
		this.closes = 0;
		/** Every chunk handed to the writer. */
		this.written = [];
		this.readable = null;
		this.writable = null;
		this.controller = null;
		/** Set if close() was ever called while the reader or writer still held a lock. */
		this.closedWhileLocked = false;
		/** An error to throw from the next open(), then forget. */
		this.failNextOpen = null;
		/** An error to throw from every open(). */
		this.failEveryOpen = null;
	}

	async open(options) {
		this.opens.push({ ...options });
		if (this.failEveryOpen) throw this.failEveryOpen;
		if (this.failNextOpen) {
			const failure = this.failNextOpen;
			this.failNextOpen = null;
			throw failure;
		}
		this.readable = new ReadableStream({
			start: (controller) => {
				this.controller = controller;
			},
		});
		this.writable = new WritableStream({
			write: (chunk) => {
				this.written.push(Uint8Array.from(chunk));
			},
		});
	}

	async close() {
		if (this.readable?.locked === true || this.writable?.locked === true) {
			this.closedWhileLocked = true;
		}
		this.closes += 1;
		this.readable = null;
		this.writable = null;
		this.controller = null;
	}

	// ------------------------------------------------------------ the board's side

	/** Bytes arriving from the board. */
	push(bytes) {
		this.controller.enqueue(Uint8Array.from(bytes));
	}

	pushText(text) {
		this.push(new TextEncoder().encode(text));
	}

	/** The board leaves. Chrome errors the stream when the device goes away. */
	unplug() {
		this.controller.error(new Error("The device has been lost."));
	}

	/** Everything the monitor has sent, as text. */
	sentText() {
		const total = this.written.reduce((sum, chunk) => sum + chunk.length, 0);
		const joined = new Uint8Array(total);
		let at = 0;
		for (const chunk of this.written) {
			joined.set(chunk, at);
			at += chunk.length;
		}
		return new TextDecoder().decode(joined);
	}
}

/** Real timings would make the reopen tests wait; nothing here needs them. */
function newMonitor(options = {}) {
	return new SerialMonitor({ reopenDelayMs: 0, reopenAttempts: 2, ...options });
}

/** Let the read loop's microtasks and any queued timer run. */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check, what) {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(`timed out waiting for ${what}`);
}

function lines(monitor) {
	return monitor.text().split("\n");
}

// ------------------------------------------------------------------- decoding

test("a chunk boundary splits neither a line nor a multi-byte character", async () => {
	const port = new FakePort();
	const monitor = newMonitor();
	await monitor.connect(port, 9600);

	const all = new TextEncoder().encode("count: 1\ncount: 2\ncafé au lait\n");
	// "café" is 4 characters but 5 bytes: the split lands between the two bytes
	// of "é", and mid-line, so both halves of the guard are exercised at once.
	const split = 22;
	assert.equal(all[split - 1], 0xc3, "expected the first byte of é just before the split");
	assert.equal(all[split], 0xa9, "expected the second byte of é just after the split");

	port.push(all.slice(0, split));
	await tick();
	// The half character must not have produced a replacement character yet.
	assert.equal(monitor.text().endsWith("caf"), true, monitor.text());

	port.push(all.slice(split));
	await tick();

	assert.deepEqual(lines(monitor), [
		"-- Connected at 9600 baud.",
		"count: 1",
		"count: 2",
		"café au lait",
	]);

	await monitor.disconnect();
});

test("a line arriving one byte at a time is one line", async () => {
	const port = new FakePort();
	const monitor = newMonitor();
	await monitor.connect(port, 9600);

	for (const byte of new TextEncoder().encode("slow\r\n")) port.push([byte]);
	await tick();

	// The CR of a CR+LF board is not left dangling on the end of the line.
	assert.deepEqual(lines(monitor), ["-- Connected at 9600 baud.", "slow"]);
	await monitor.disconnect();
});

// ------------------------------------------------------------- the line buffer

test("the buffer keeps only the last lines and counts what it dropped", async () => {
	const port = new FakePort();
	const monitor = newMonitor({ maxLines: 5 });
	await monitor.connect(port, 9600);

	for (let n = 1; n <= 20; n += 1) port.pushText(`count: ${n}\n`);
	await tick();

	assert.equal(monitor.lineCount(), 5);
	assert.deepEqual(lines(monitor), [
		"count: 16",
		"count: 17",
		"count: 18",
		"count: 19",
		"count: 20",
	]);
	// One connect notice plus twenty lines, five kept.
	assert.equal(monitor.droppedLines(), 16);

	monitor.clear();
	assert.equal(monitor.lineCount(), 0);
	assert.equal(monitor.text(), "");

	await monitor.disconnect();
});

test("a sketch that never sends a newline cannot grow one line forever", async () => {
	const port = new FakePort();
	const monitor = newMonitor({ maxLines: 10 });
	await monitor.connect(port, 9600);

	port.pushText("x".repeat(5000));
	await tick();

	// Past 4096 characters the run is pushed as a line instead of being held as
	// a partial that grows for as long as the sketch keeps printing.
	assert.equal(monitor.lineCount(), 2);
	const shown = lines(monitor);
	assert.equal(shown[1].length, 5000);
	assert.equal(shown[2], undefined);

	await monitor.disconnect();
});

// -------------------------------------------------------------------- sending

test("Enter sends the typed text with the chosen line ending", async () => {
	const port = new FakePort();
	const monitor = newMonitor();
	await monitor.connect(port, 9600);

	// Newline is the default, the same default the Arduino IDE ships.
	assert.equal(monitor.getLineEnding(), "newline");
	await monitor.send("hello");
	assert.equal(port.sentText(), "hello\n");

	monitor.setLineEnding("crlf");
	await monitor.send("again");
	assert.equal(port.sentText(), "hello\nagain\r\n");

	monitor.setLineEnding("none");
	await monitor.send("raw");
	assert.equal(port.sentText(), "hello\nagain\r\nraw");

	// What was sent is echoed into the buffer, marked so it cannot be mistaken
	// for something the board said.
	assert.deepEqual(lines(monitor), [
		"-- Connected at 9600 baud.",
		"> hello",
		"> again",
		"> raw",
	]);

	await monitor.disconnect();
});

test("sending before connecting is refused with a sentence", async () => {
	const monitor = newMonitor();
	await assert.rejects(() => monitor.send("hello"), (error) => {
		assert.ok(error instanceof MonitorError);
		assert.match(error.message, /Connect to the board/);
		return true;
	});
});

// ------------------------------------------------------------- upload handover

test("pause hands the port over cleanly and resume picks it back up", async () => {
	const port = new FakePort();
	const monitor = newMonitor();

	await monitor.connect(port, 19200);
	assert.deepEqual(port.opens, [{ baudRate: 19200, bufferSize: 4096 }]);

	port.pushText("count: 1\n");
	await tick();

	// --- Upload starts.
	const paused = await monitor.pauseForUpload();
	assert.equal(paused, true);
	assert.equal(monitor.getState(), "paused");

	// The three things the flasher needs: no reader, no writer, port closed.
	assert.equal(port.closedWhileLocked, false, "the port was closed with a lock still held");
	assert.equal(port.closes, 1);
	assert.equal(port.readable, null);
	assert.equal(port.writable, null);
	assert.match(monitor.text(), /-- Paused for upload/);

	// --- The flasher would open, program and close the port here. Reopening it
	// proves the monitor is not holding anything the flasher would trip over.
	await port.open({ baudRate: 115200 });
	await port.close();
	assert.equal(port.closedWhileLocked, false);

	// --- Upload finished.
	await monitor.resumeAfterUpload();
	assert.equal(monitor.getState(), "connected");
	// Same port object, same baud rate as before the upload.
	assert.equal(port.opens.length, 3);
	assert.deepEqual(port.opens.at(-1), { baudRate: 19200, bufferSize: 4096 });
	assert.match(monitor.text(), /-- Resumed at 19200 baud\./);

	// And it is really reading again, not just claiming to be.
	port.pushText("count: 2\n");
	await tick();
	assert.deepEqual(lines(monitor), [
		"-- Connected at 19200 baud.",
		"count: 1",
		"-- Paused for upload…",
		"-- Resumed at 19200 baud.",
		"count: 2",
	]);

	await monitor.disconnect();
});

test("pausing when nothing is connected does nothing and says so", async () => {
	const monitor = newMonitor();
	assert.equal(await monitor.pauseForUpload(), false);
	// Resume after a pause that never happened must not open anything.
	await monitor.resumeAfterUpload();
	assert.equal(monitor.getState(), "disconnected");
});

test("a port that will not reopen after an upload gives up as text, not as a throw", async () => {
	const port = new FakePort();
	const monitor = newMonitor({ reopenAttempts: 2 });
	await monitor.connect(port, 9600);
	await monitor.pauseForUpload();

	const gone = new Error("device gone");
	gone.name = "NetworkError";
	port.failEveryOpen = gone;

	await monitor.resumeAfterUpload();

	// Both attempts were made, and neither threw out of resumeAfterUpload: an
	// upload that worked must not be reported as an upload that failed.
	assert.equal(port.opens.length, 3);
	assert.equal(monitor.getState(), "disconnected");
	assert.match(monitor.text(), /-- Could not reopen the board:/);
	assert.match(monitor.text(), /click Connect again/);
});

// ----------------------------------------------------------------- disconnect

test("an unplug mid-session ends the session and Connect works again", async () => {
	const port = new FakePort();
	const monitor = newMonitor();
	await monitor.connect(port, 9600);

	port.pushText("count: 1\n");
	await tick();

	port.unplug();
	await waitFor(() => monitor.getState() === "disconnected", "the monitor to notice the unplug");

	assert.match(monitor.text(), new RegExp(`-- ${BOARD_DISCONNECTED_MESSAGE}`));
	assert.equal(port.closes, 1);
	assert.equal(port.closedWhileLocked, false);

	// A replug hands out a new SerialPort. Connecting to it must just work.
	const replugged = new FakePort();
	await monitor.connect(replugged, 9600);
	assert.equal(monitor.getState(), "connected");

	replugged.pushText("count: 2\n");
	await tick();
	assert.equal(lines(monitor).at(-1), "count: 2");

	await monitor.disconnect();
	assert.equal(monitor.getState(), "disconnected");
	assert.equal(replugged.closes, 1);
	assert.equal(replugged.closedWhileLocked, false);
});

test("a half-finished line survives the disconnect that interrupted it", async () => {
	const port = new FakePort();
	const monitor = newMonitor();
	await monitor.connect(port, 9600);

	port.pushText("count: 4");
	await tick();
	await monitor.disconnect();

	assert.deepEqual(lines(monitor), ["-- Connected at 9600 baud.", "count: 4", "-- Disconnected."]);
});

test("a port that will not open is reported in words a student can act on", async () => {
	const port = new FakePort();
	const busy = new Error("Failed to open serial port.");
	busy.name = "NetworkError";
	port.failNextOpen = busy;

	const monitor = newMonitor();
	await assert.rejects(() => monitor.connect(port, 9600), (error) => {
		assert.ok(error instanceof MonitorError);
		assert.match(error.message, /Could not open the board's port/);
		assert.match(error.message, /click Connect again/);
		return true;
	});
	assert.equal(monitor.getState(), "disconnected");
});

// ----------------------------------------------------------------- timestamps

test("timestamps are per line and optional", async () => {
	const port = new FakePort();
	// 1970-01-01T00:00:00Z plus 12h34m56.789s, read in whatever zone the machine
	// is in — so only the shape of the stamp is asserted, not the hour.
	const monitor = newMonitor({ now: () => 45296789 });
	await monitor.connect(port, 9600);

	port.pushText("count: 1\n");
	await tick();

	assert.equal(monitor.text().endsWith("count: 1"), true);
	assert.match(monitor.text({ timestamps: true }), /^\[\d\d:\d\d:\d\d\.\d\d\d] -- Connected/);
	assert.match(monitor.text({ timestamps: true }), /\[\d\d:\d\d:56\.789] count: 1$/);

	await monitor.disconnect();
});

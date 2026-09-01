/**
 * The serial monitor: open a port, read it into a capped line buffer, send
 * lines back, and get out of the way when an upload needs the board.
 *
 * Nothing here touches the DOM, and the port is an interface rather than a
 * `SerialPort`, so the whole thing runs under `node --test` against a fake
 * port — including the pause/resume dance the Upload button depends on, which
 * is the part that is hardest to check twice in a row on a real board.
 *
 * `main.ts` owns the widgets and asks this object questions; this object owns
 * the reader, the writer, the decoder and the text.
 */

import { describeOpenFailure } from "./flash/serial.ts";
import { sleep } from "./flash/stk500v1.ts";

/** Baud rates the picker offers. 9600 is what almost every lesson uses. */
export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;

export const DEFAULT_BAUD_RATE = 9600;

/**
 * How many lines are kept. A sketch printing flat out at 115200 makes a few
 * thousand lines a minute, and a Chromebook has no memory to spare, so the
 * oldest lines are dropped rather than scrolled.
 */
export const MAX_LINES = 2000;

/**
 * A "line" with no newline in it cannot grow forever either — `Serial.print`
 * in a tight loop never sends one. Past this it is cut and pushed as a line.
 */
const MAX_LINE_CHARS = 4096;

/** What Enter appends to the text a student typed. */
export type LineEnding = "newline" | "crlf" | "none";

export const LINE_ENDING_TEXT: Record<LineEnding, string> = {
	newline: "\n",
	crlf: "\r\n",
	none: "",
};

export const LINE_ENDING_LABELS: Record<LineEnding, string> = {
	newline: "Newline",
	crlf: "Carriage return + newline",
	none: "No line ending",
};

/** Where a line came from. Only the prefix in front of it differs. */
export type LineKind = "in" | "out" | "notice";

export interface MonitorLine {
	/** When the first character of the line arrived. */
	at: number;
	kind: LineKind;
	text: string;
}

/**
 * `paused` is the upload state: the port is closed and handed to the flasher,
 * but the monitor still remembers which port it was and at what baud.
 */
export type MonitorState = "disconnected" | "connecting" | "connected" | "paused";

/** A monitor failure whose `message` is already written for a student to read. */
export class MonitorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MonitorError";
	}
}

/** Shown when the board leaves mid-session. Asserted by the tests. */
export const BOARD_DISCONNECTED_MESSAGE =
	"Board disconnected. Plug the USB cable back in, then click Connect.";

/**
 * The slice of a Web Serial port the monitor uses. `SerialPortLike` in
 * `flash/serial.ts` has all of this and more, so a real port is passed
 * straight in; the tests pass an object built out of plain web streams.
 */
export interface MonitorPort {
	open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
	close(): Promise<void>;
	readonly readable: ReadableStream<Uint8Array> | null;
	readonly writable: WritableStream<Uint8Array> | null;
}

export interface MonitorOptions {
	/** The line buffer changed. Cheap and frequent — schedule a redraw, do not draw. */
	onChange?: () => void;
	/** The state changed. Rare — relabel the buttons here. */
	onState?: (state: MonitorState) => void;
	/** Clock, so the tests can pin timestamps. */
	now?: () => number;
	maxLines?: number;
	/** Reopening after an upload: the board is still resetting, so wait and retry. */
	reopenAttempts?: number;
	reopenDelayMs?: number;
}

export class SerialMonitor {
	private readonly onChange: () => void;
	private readonly onState: (state: MonitorState) => void;
	private readonly now: () => number;
	private readonly maxLines: number;
	private readonly reopenAttempts: number;
	private readonly reopenDelayMs: number;

	private state: MonitorState = "disconnected";
	private port: MonitorPort | null = null;
	private baudRate: number = DEFAULT_BAUD_RATE;
	private lineEnding: LineEnding = "newline";

	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private loop: Promise<void> | null = null;
	private decoder: TextDecoder | null = null;
	/** True while we are the ones ending the read loop, so it is not read as an unplug. */
	private stopping = false;

	private lines: MonitorLine[] = [];
	/** The line still arriving: text since the last newline. */
	private partial = "";
	private partialAt = 0;
	private dropped = 0;
	private revision = 0;

	constructor(options: MonitorOptions = {}) {
		this.onChange = options.onChange ?? (() => {});
		this.onState = options.onState ?? (() => {});
		this.now = options.now ?? ((): number => Date.now());
		this.maxLines = options.maxLines ?? MAX_LINES;
		this.reopenAttempts = options.reopenAttempts ?? 3;
		this.reopenDelayMs = options.reopenDelayMs ?? 250;
	}

	// ------------------------------------------------------------ what it looks like

	getState(): MonitorState {
		return this.state;
	}

	getBaudRate(): number {
		return this.baudRate;
	}

	getLineEnding(): LineEnding {
		return this.lineEnding;
	}

	setLineEnding(ending: LineEnding): void {
		this.lineEnding = ending;
	}

	/** Bumped on every change to the text, so a renderer can skip idle frames. */
	getRevision(): number {
		return this.revision;
	}

	/** Lines held right now, including notices. Never more than `maxLines`. */
	lineCount(): number {
		return this.lines.length;
	}

	/** Lines thrown away because the buffer was full. */
	droppedLines(): number {
		return this.dropped;
	}

	/**
	 * The whole buffer as text. Sent lines are prefixed `> ` and the monitor's
	 * own remarks `-- `, so a student can tell them from the board's output.
	 */
	text(options: { timestamps?: boolean } = {}): string {
		const stamp = options.timestamps === true;
		const out = this.lines.map((line) => formatLine(line, stamp));
		if (this.partial.length > 0) {
			out.push(formatLine({ at: this.partialAt, kind: "in", text: this.partial }, stamp));
		}
		return out.join("\n");
	}

	/** Empty the buffer. The connection is untouched. */
	clear(): void {
		this.lines = [];
		this.partial = "";
		this.dropped = 0;
		this.bump();
	}

	/** Add one of the monitor's own lines, e.g. why it stopped. */
	notice(text: string): void {
		this.pushLine("notice", text);
	}

	// ------------------------------------------------------------------- connecting

	/**
	 * Open `port` and start reading. Throws `MonitorError` with a sentence the
	 * page can show as-is; the caller picked the port, so it also owns the
	 * "no board chosen" case.
	 */
	async connect(port: MonitorPort, baudRate: number = this.baudRate): Promise<void> {
		if (this.state !== "disconnected") return;

		this.port = port;
		this.baudRate = baudRate;
		this.setState("connecting");
		try {
			await this.openPort();
		} catch (cause) {
			this.port = null;
			this.setState("disconnected");
			throw cause;
		}
		this.notice(`Connected at ${baudRate} baud.`);
		this.setState("connected");
	}

	/** Close up at the student's request. Safe to call in any state. */
	async disconnect(): Promise<void> {
		if (this.state === "disconnected") return;
		await this.stop();
		this.port = null;
		this.notice("Disconnected.");
		this.setState("disconnected");
	}

	/**
	 * Change baud. While connected the port is closed and reopened, which also
	 * resets the board — the same thing the Arduino IDE's monitor does.
	 */
	async setBaudRate(baudRate: number): Promise<void> {
		if (baudRate === this.baudRate) return;
		this.baudRate = baudRate;
		if (this.state !== "connected") return;
		await this.stop();
		await this.reopen(`Now listening at ${baudRate} baud.`);
	}

	// -------------------------------------------------------------- sharing the port

	/**
	 * Hand the port to the flasher: release the reader and the writer, close
	 * the port, and remember which port it was. Returns true when there was
	 * something to pause — the caller's cue to call `resumeAfterUpload` later.
	 */
	async pauseForUpload(): Promise<boolean> {
		if (this.state !== "connected") return false;
		await this.stop();
		this.notice("Paused for upload…");
		this.setState("paused");
		return true;
	}

	/**
	 * Reopen the same port at the same baud after an upload. Never throws: the
	 * upload itself worked, and a monitor that cannot come back is a line of
	 * text, not a failed upload.
	 */
	async resumeAfterUpload(): Promise<void> {
		if (this.state !== "paused") return;
		await this.reopen(`Resumed at ${this.baudRate} baud.`);
	}

	// ---------------------------------------------------------------------- sending

	/** Send one line, with whatever ending is selected. */
	async send(text: string): Promise<void> {
		const writer = this.writer;
		if (this.state !== "connected" || !writer) {
			throw new MonitorError("Connect to the board before sending a message.");
		}

		this.pushLine("out", text);
		try {
			await writer.write(new TextEncoder().encode(text + LINE_ENDING_TEXT[this.lineEnding]));
		} catch (cause) {
			// Sending fails for the same reason reading does: the board left.
			this.notice(`Could not send that (${messageOf(cause)}).`);
			void this.handleLoss();
		}
	}

	// --------------------------------------------------------------------- internals

	private setState(state: MonitorState): void {
		if (this.state === state) return;
		this.state = state;
		this.onState(state);
	}

	private bump(): void {
		this.revision += 1;
		this.onChange();
	}

	private pushLine(kind: LineKind, text: string, at: number = this.now()): void {
		this.lines.push({ at, kind, text });
		if (this.lines.length > this.maxLines) {
			const extra = this.lines.length - this.maxLines;
			this.lines.splice(0, extra);
			this.dropped += extra;
		}
		this.bump();
	}

	/**
	 * Close the port and open it again, keeping the same `SerialPort` object —
	 * which is what lets an upload borrow the board without the student being
	 * asked to pick it a second time. Reports failure as a line of text.
	 */
	private async reopen(successNotice: string): Promise<void> {
		this.setState("connecting");

		for (let attempt = 1; attempt <= this.reopenAttempts; attempt += 1) {
			// Chrome needs a moment to hand the port back after the flasher
			// closed it, and the board is busy resetting into the new sketch.
			await sleep(this.reopenDelayMs);
			try {
				await this.openPort();
				this.notice(successNotice);
				this.setState("connected");
				return;
			} catch (cause) {
				if (attempt === this.reopenAttempts) {
					this.port = null;
					this.notice(`Could not reopen the board: ${messageOf(cause)}`);
					this.setState("disconnected");
				}
			}
		}
	}

	/** Open the port and take its reader and writer. Leaves the state alone. */
	private async openPort(): Promise<void> {
		const port = this.port;
		if (!port) throw new MonitorError("There is no board to connect to. Click Connect.");

		try {
			await port.open({ baudRate: this.baudRate, bufferSize: 4096 });
		} catch (cause) {
			throw new MonitorError(describeOpenFailure(cause, "monitor"));
		}

		if (!port.readable || !port.writable) {
			try {
				await port.close();
			} catch {
				// Nothing to do; it never carried data anyway.
			}
			throw new MonitorError(
				"The port opened but will not carry data. Unplug the board, plug it back in, then click Connect.",
			);
		}

		// One decoder per connection: `stream: true` keeps the tail of a
		// multi-byte character across chunk boundaries, which is the whole
		// reason this is not `String.fromCharCode`.
		this.decoder = new TextDecoder();
		this.stopping = false;
		this.reader = port.readable.getReader();
		this.writer = port.writable.getWriter();
		this.loop = this.readLoop(this.reader);
	}

	private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value && value.length > 0) this.receive(value);
			}
		} catch {
			// The board was unplugged mid-read. Same ending as a closed stream.
		}
		// If nobody asked for this loop to end, the board is gone: Chrome errors
		// or closes the stream when the device leaves. Not awaited — this is the
		// loop's own frame, and the teardown is what waits for it.
		if (!this.stopping) void this.handleLoss();
	}

	/** The board left on its own. Let go of everything and say so. */
	private async handleLoss(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		this.releaseLocks();
		this.loop = null;
		this.flushStream();

		const port = this.port;
		this.port = null;
		if (port) {
			try {
				await port.close();
			} catch {
				// The device is already gone; the port is closed either way.
			}
		}

		this.notice(BOARD_DISCONNECTED_MESSAGE);
		this.setState("disconnected");
	}

	/**
	 * Give the port back: cancel the reader, wait for the loop to finish with
	 * it, drop both locks, then close. Every step is attempted even if the one
	 * before it failed — an upload cannot open a port we still half-hold.
	 */
	private async stop(): Promise<void> {
		this.stopping = true;
		const reader = this.reader;
		const loop = this.loop;

		try {
			await reader?.cancel();
		} catch {
			// Already gone.
		}
		try {
			await loop;
		} catch {
			// readLoop swallows its own errors, but never let one escape here.
		}
		this.loop = null;
		this.releaseLocks();
		this.flushStream();

		if (this.port) {
			try {
				await this.port.close();
			} catch {
				// Unplugged. Closed either way.
			}
		}
	}

	private releaseLocks(): void {
		try {
			this.reader?.releaseLock();
		} catch {
			// Already released.
		}
		try {
			this.writer?.releaseLock();
		} catch {
			// Already released.
		}
		this.reader = null;
		this.writer = null;
	}

	/** End the decoder and turn any half-finished line into a real one. */
	private flushStream(): void {
		if (this.decoder) {
			try {
				const tail = this.decoder.decode();
				if (tail.length > 0) this.absorb(tail);
			} catch {
				// Nothing was pending.
			}
			this.decoder = null;
		}
		if (this.partial.length > 0) {
			this.pushLine("in", this.partial, this.partialAt);
			this.partial = "";
		}
	}

	private receive(chunk: Uint8Array): void {
		if (!this.decoder) return;
		const text = this.decoder.decode(chunk, { stream: true });
		// An empty string here is normal: the chunk ended mid-character and the
		// decoder is holding the first bytes of it until the next chunk.
		if (text.length > 0) this.absorb(text);
	}

	private absorb(text: string): void {
		if (this.partial.length === 0) this.partialAt = this.now();
		let rest = this.partial + text;

		for (;;) {
			const newline = rest.indexOf("\n");
			if (newline < 0) break;
			// A board sending CR+LF should not leave a stray CR at the end of
			// every line. A lone CR is left alone; it is not a line ending here.
			this.pushLine("in", stripTrailingCr(rest.slice(0, newline)), this.partialAt);
			rest = rest.slice(newline + 1);
			this.partialAt = this.now();
		}

		if (rest.length > MAX_LINE_CHARS) {
			this.pushLine("in", rest, this.partialAt);
			rest = "";
			this.partialAt = this.now();
		}

		this.partial = rest;
		this.bump();
	}
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function formatLine(line: MonitorLine, timestamps: boolean): string {
	const body =
		line.kind === "out" ? `> ${line.text}` : line.kind === "notice" ? `-- ${line.text}` : line.text;
	return timestamps ? `${formatTime(line.at)} ${body}` : body;
}

/** `[14:32:07.418]` in the student's own timezone. */
export function formatTime(at: number): string {
	const when = new Date(at);
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	return `[${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(when.getMilliseconds(), 3)}]`;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

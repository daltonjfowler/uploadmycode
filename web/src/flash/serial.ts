/**
 * The only file that touches `navigator.serial`.
 *
 * Everything above it (stk500v1.ts) is plain bytes and can be tested without a
 * browser or a board; everything Chrome-specific — the port chooser, opening
 * and closing, the DTR/RTS lines, the read loop — is here.
 *
 * TypeScript's DOM library still does not ship Web Serial types and this
 * project takes no new dependencies, so the handful of members we use are
 * declared below. They are deliberately narrower than the real API.
 */

import { FlashError, type Transport } from "./stk500v1.ts";

/** Genuine Arduino boards. */
const VENDOR_ARDUINO = 0x2341;
/** CH340/CH341, the USB-serial chip on most clone Unos. */
const VENDOR_CH340 = 0x1a86;

/** Optiboot's baud rate on an Uno. Not configurable; the bootloader is fixed. */
const BOOTLOADER_BAUD = 115200;

/** How often the read loop is checked while waiting for bytes. */
const READ_POLL_MS = 4;

// ------------------------------------------------------- minimal Web Serial types

interface SerialPortInfo {
	usbVendorId?: number;
	usbProductId?: number;
}

export interface SerialPortLike {
	open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
	close(): Promise<void>;
	setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
	getInfo(): SerialPortInfo;
	readonly readable: ReadableStream<Uint8Array> | null;
	readonly writable: WritableStream<Uint8Array> | null;
}

interface SerialLike {
	requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPortLike>;
	getPorts(): Promise<SerialPortLike[]>;
}

function serialApi(): SerialLike | undefined {
	return (navigator as Navigator & { serial?: SerialLike }).serial;
}

/** False in Firefox and Safari, and on a Chromebook whose policy blocks serial. */
export function isWebSerialAvailable(): boolean {
	return serialApi() !== undefined;
}

/** Thrown when the browser cannot do this at all. Shown with a link to the test page. */
export const NO_WEB_SERIAL_MESSAGE =
	"This browser cannot talk to USB devices. Use Google Chrome. If you are already in Chrome on a school Chromebook, the district may be blocking serial ports — open the Web Serial test page below and show your teacher what it says.";

// ------------------------------------------------------------------ choosing a port

function looksLikeAnUno(port: SerialPortLike): boolean {
	const vendor = port.getInfo().usbVendorId;
	return vendor === VENDOR_ARDUINO || vendor === VENDOR_CH340;
}

/**
 * A port this origin was already given permission for, if exactly one of them
 * looks like an Uno. Chrome remembers the grant, so after the first upload the
 * student is not asked to pick the board again — which is also what lets T4's
 * monitor and the Upload button share one board.
 */
export async function findGrantedUnoPort(): Promise<SerialPortLike | null> {
	const serial = serialApi();
	if (!serial) return null;
	try {
		const granted = (await serial.getPorts()).filter(looksLikeAnUno);
		return granted.length === 1 ? granted[0]! : null;
	} catch {
		return null;
	}
}

/**
 * Open Chrome's port chooser. With `showAll` false only Arduino and CH340
 * boards are listed, which is what a student wants; the caller falls back to
 * `showAll` true after a first attempt found nothing, because a board with an
 * unusual USB chip is invisible under the filters.
 *
 * `action` only chooses which button the message sends the student back to:
 * both Upload and the serial monitor ask for a port the same way.
 */
export async function requestPort(
	showAll: boolean,
	action: "upload" | "monitor" = "upload",
): Promise<SerialPortLike> {
	const serial = serialApi();
	if (!serial) throw new FlashError("unsupported", NO_WEB_SERIAL_MESSAGE);

	const filters = showAll
		? []
		: [{ usbVendorId: VENDOR_ARDUINO }, { usbVendorId: VENDOR_CH340 }];

	try {
		return await serial.requestPort({ filters });
	} catch {
		// Chrome throws the same NotFoundError whether the student pressed Cancel
		// or the list was empty, so this one message has to cover both.
		const retry = action === "monitor" ? "click Connect again" : "click Upload again";
		throw new FlashError(
			"no-port",
			showAll
				? `No board chosen. Check the USB cable is plugged into the Uno and into the Chromebook, then ${retry}.`
				: `No board chosen. Plug the Uno in and ${retry} — the next list shows every port on the computer, so pick the one the board is on.`,
		);
	}
}

// -------------------------------------------------------------------- the transport

/**
 * A `Transport` over an open Web Serial port.
 *
 * Bytes are pumped out of the port into one buffer by a background loop, and
 * `read` waits for that buffer to fill. Nothing here throws on a timeout: a
 * short read is the timeout, which is the contract stk500v1.ts expects.
 */
class PortTransport implements Transport {
	private readonly port: SerialPortLike;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private pump: Promise<void> | null = null;
	private buffer = new Uint8Array(0);
	private stopped = false;

	constructor(port: SerialPortLike) {
		this.port = port;
	}

	async start(): Promise<void> {
		try {
			await this.port.open({ baudRate: BOOTLOADER_BAUD, bufferSize: 4096 });
		} catch (cause) {
			throw new FlashError("busy", describeOpenFailure(cause));
		}

		if (!this.port.readable || !this.port.writable) {
			await this.close();
			throw new FlashError("port", "The port opened but will not carry data. Unplug the board and try again.");
		}

		this.reader = this.port.readable.getReader();
		this.writer = this.port.writable.getWriter();
		this.pump = this.pumpReads();
	}

	private async pumpReads(): Promise<void> {
		const reader = this.reader;
		if (!reader) return;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				if (value && value.length > 0) this.append(value);
			}
		} catch {
			// The board was unplugged mid-upload. Reads will now come up short,
			// and stk500v1.ts turns that into a sentence the student can act on.
		}
	}

	private append(chunk: Uint8Array): void {
		const grown = new Uint8Array(this.buffer.length + chunk.length);
		grown.set(this.buffer);
		grown.set(chunk, this.buffer.length);
		this.buffer = grown;
	}

	async setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void> {
		try {
			await this.port.setSignals(signals);
		} catch (cause) {
			throw new FlashError("port", `Could not reset the board over USB (${errorText(cause)}).`);
		}
	}

	async write(bytes: Uint8Array): Promise<void> {
		if (!this.writer) throw new FlashError("port", "The port is closed.");
		try {
			await this.writer.write(bytes);
		} catch (cause) {
			throw new FlashError(
				"port",
				`Lost the connection to the board while sending (${errorText(cause)}). Unplug it, plug it back in, then try Upload again.`,
			);
		}
	}

	async read(count: number, timeoutMs: number): Promise<Uint8Array> {
		const deadline = Date.now() + timeoutMs;
		while (this.buffer.length < count && !this.stopped && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, READ_POLL_MS));
		}
		const take = Math.min(count, this.buffer.length);
		const out = this.buffer.slice(0, take);
		this.buffer = this.buffer.slice(take);
		return out;
	}

	flushInput(): void {
		this.buffer = new Uint8Array(0);
	}

	/**
	 * Give the port back. Every lock has to be released before `close()` will
	 * resolve, and T4's serial monitor cannot reopen a port we still hold, so
	 * each step is attempted even if the one before it failed.
	 */
	async close(): Promise<void> {
		this.stopped = true;
		try {
			await this.reader?.cancel();
		} catch {
			// Already gone.
		}
		try {
			this.reader?.releaseLock();
		} catch {
			// Already released.
		}
		try {
			await this.pump;
		} catch {
			// pumpReads never rejects, but do not let a surprise escape close().
		}
		try {
			this.writer?.releaseLock();
		} catch {
			// Already released.
		}
		this.reader = null;
		this.writer = null;
		this.pump = null;
		try {
			await this.port.close();
		} catch {
			// The board was unplugged; the port is closed either way.
		}
	}
}

/** A transport that still owns the port, so the caller can hand it back. */
export type OpenPort = Transport & { close(): Promise<void> };

/** Open `port` at the bootloader's baud rate and start reading from it. */
export async function openTransport(port: SerialPortLike): Promise<OpenPort> {
	const transport = new PortTransport(port);
	await transport.start();
	return transport;
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Why `port.open()` failed, as a sentence for a student.
 *
 * The serial monitor opens the same ports the flasher does and fails in the
 * same three ways, so it shares these words; only the button it sends the
 * student back to differs.
 */
export function describeOpenFailure(
	cause: unknown,
	action: "upload" | "monitor" = "upload",
): string {
	const name = cause instanceof Error ? cause.name : "";
	const monitor = action === "monitor";

	if (name === "InvalidStateError") {
		return monitor
			? "That port is already open in this tab. Click Disconnect, wait a moment, then Connect again."
			: "That port is already open in this tab. Close the Serial Monitor and try Upload again.";
	}
	if (name === "NetworkError") {
		// Chrome gives the same NetworkError for "someone else has it" and for
		// "the board is not there any more", so the message has to cover both.
		return monitor
			? "Could not open the board's port. Either something else is using it — close the Arduino IDE and any other tab with this page open — or the board came unplugged. Plug it back in, then click Connect again."
			: "Could not open the board's port. Either something else is using it — close the Arduino IDE and any other tab with this page open — or the board came unplugged. Plug it back in, then try Upload again.";
	}
	return monitor
		? `Could not open the board's port (${errorText(cause)}). Close anything else that might be using it, then click Connect again.`
		: `Could not open the board's port (${errorText(cause)}). Close anything else that might be using it, then try Upload again.`;
}

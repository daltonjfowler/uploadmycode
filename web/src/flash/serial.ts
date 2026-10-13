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
	"This browser cannot talk to USB devices. Use Google Chrome. If you are already in Chrome on a school Chromebook, the district may be blocking serial ports. Open the Web Serial test page below and show your teacher what it says.";

// ------------------------------------------------------------------ choosing a port

/** Which board the student is working with. Decides the port filter and the words. */
export type BoardKind = "uno" | "esp32";

/** USB-serial chips on ESP32 boards: CP210x, CH340/CH9102, FTDI, and Espressif's own USB. */
const ESP32_VENDORS = [0x10c4, VENDOR_CH340, 0x0403, 0x303a];

function boardVendors(board: BoardKind): number[] {
	return board === "esp32" ? ESP32_VENDORS : [VENDOR_ARDUINO, VENDOR_CH340];
}

/** "Uno" or "ESP32", for messages. */
export function boardName(board: BoardKind): string {
	return board === "esp32" ? "ESP32" : "Uno";
}

function looksLikeBoard(port: SerialPortLike, board: BoardKind): boolean {
	const vendor = port.getInfo().usbVendorId;
	return vendor !== undefined && boardVendors(board).includes(vendor);
}

/**
 * A port this origin was already given permission for, if exactly one of them
 * looks like the chosen board. Chrome remembers the grant, so after the first
 * upload the student is not asked to pick the board again — which is also what
 * lets T4's monitor and the Upload button share one board.
 */
export async function findGrantedBoardPort(board: BoardKind = "uno"): Promise<SerialPortLike | null> {
	const serial = serialApi();
	if (!serial) return null;
	try {
		const granted = (await serial.getPorts()).filter((port) => looksLikeBoard(port, board));
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
	board: BoardKind = "uno",
): Promise<SerialPortLike> {
	const serial = serialApi();
	if (!serial) throw new FlashError("unsupported", NO_WEB_SERIAL_MESSAGE);

	const filters = showAll ? [] : boardVendors(board).map((usbVendorId) => ({ usbVendorId }));

	try {
		return await serial.requestPort({ filters });
	} catch {
		// Chrome throws the same NotFoundError whether the student pressed Cancel
		// or the list was empty, so this one message has to cover both.
		const retry = action === "monitor" ? "click Connect again" : "click Upload again";
		const name = boardName(board);
		if (board === "esp32") throw new FlashError("no-port", esp32NoPortMessage(showAll, retry));
		throw new FlashError(
			"no-port",
			showAll
				? `No board chosen. Check the USB cable is plugged into the ${name} and into the computer, then ${retry}.`
				: `No board chosen. Plug the ${name} in and ${retry}. The next list shows every port on the computer, so pick the one the board is on.`,
		);
	}
}

/**
 * Chrome lists a port only once the operating system made one. With an ESP32
 * that fails far more often than with an Uno: many ESP32 cables carry power
 * only, and the CP2102 chip on many boards needs a driver on Windows. Neither
 * can be fixed from a web page, so say exactly what to check.
 */
function esp32NoPortMessage(showAll: boolean, retry: string): string {
	if (!showAll) {
		return `No board chosen. Plug the ESP32 in and ${retry}. The next list shows every port on the computer, so pick the one the board is on.`;
	}
	return [
		"No ESP32 found. If the list was empty, the computer cannot see the board yet:",
		"1. Use a USB data cable. Many cables that come with ESP32 boards only charge. Try another cable, and plug straight into the computer, not a hub.",
		"2. On Windows: right-click Start, open Device Manager, and look under \"Ports (COM & LPT)\". No COM port there, or a yellow warning sign, means the board's USB chip needs a driver.",
		"   Read the small chip next to the USB socket on the board:",
		"   CP2102 or CP2104: install the Silicon Labs \"CP210x VCP\" driver (silabs.com).",
		"   CH340 or CH9102: install the WCH \"CH341SER\" driver (wch-ic.com).",
		"   Installing a driver needs an administrator, so ask whoever looks after the laptop.",
		`3. Then unplug the board, plug it back in, and ${retry}.`,
	].join("\n");
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
			? "Could not open the board's port. Either something else is using it. Close the Arduino IDE and any other tab with this page open. Or the board came unplugged. Plug it back in, then click Connect again."
			: "Could not open the board's port. Either something else is using it. Close the Arduino IDE and any other tab with this page open. Or the board came unplugged. Plug it back in, then try Upload again.";
	}
	return monitor
		? `Could not open the board's port (${errorText(cause)}). Close anything else that might be using it, then click Connect again.`
		: `Could not open the board's port (${errorText(cause)}). Close anything else that might be using it, then try Upload again.`;
}

/**
 * STK500v1, the slice of it that Optiboot on an Uno actually answers.
 *
 * Nothing in this file touches the browser. It talks to a `Transport`, which
 * `serial.ts` implements with a real Web Serial port and the tests implement
 * with a fake Uno — so the whole conversation with the board is testable
 * without a board.
 *
 * The conversation, in order:
 *
 *   1. Toggle DTR/RTS. A capacitor turns that edge into a reset pulse, the
 *      sketch stops, and Optiboot starts listening at 115200 baud.
 *   2. `30 20` get-sync until it answers `14 10`. Optiboot only listens for
 *      about a second after reset, so this is retried, not waited on.
 *   3. `75 20` read signature -> `14 1E 95 0F 10` for an ATmega328P.
 *   4. `50 20` enter programming mode.
 *   5. Per 128-byte page: `55 lo hi 20` load the WORD address, then
 *      `64 00 80 46 <128 bytes> 20` program the page.
 *   6. `51 20` leave programming mode. Optiboot then runs the new sketch.
 *
 * Every reply is framed `14 <data...> 10` — STK_INSYNC ... STK_OK.
 *
 * Addresses in the load-address command are WORD addresses (one word = two
 * bytes), which is the single easiest thing to get wrong here: a byte address
 * would write the sketch to twice its proper offset.
 */

const STK_INSYNC = 0x14;
const STK_OK = 0x10;
const CRC_EOP = 0x20;

const CMD_GET_SYNC = 0x30;
const CMD_ENTER_PROGMODE = 0x50;
const CMD_LEAVE_PROGMODE = 0x51;
const CMD_LOAD_ADDRESS = 0x55;
const CMD_PROG_PAGE = 0x64;
const CMD_READ_SIGN = 0x75;

/** 'F' — program the flash, not the EEPROM. */
const MEMTYPE_FLASH = 0x46;

/** Optiboot on an ATmega328P writes flash one 128-byte page at a time. */
export const PAGE_SIZE = 128;

/** ATmega328P. An Uno that answers anything else is not an Uno. */
export const ATMEGA328P_SIGNATURE = [0x1e, 0x95, 0x0f] as const;

/** Which failure happened, so the page can say something useful about it. */
export type FlashErrorKind =
	| "unsupported" // no Web Serial in this browser
	| "no-port" // the student closed the port chooser
	| "busy" // something else already has the port
	| "sync" // the board never answered
	| "signature" // it answered, but it is not an Uno
	| "protocol" // it answered nonsense or stopped answering mid-flash
	| "port"; // open/close/read/write blew up

/** An upload failure whose `message` is already written for a student to read. */
export class FlashError extends Error {
	readonly kind: FlashErrorKind;

	constructor(kind: FlashErrorKind, message: string) {
		super(message);
		this.name = "FlashError";
		this.kind = kind;
	}
}

/** The sentence the sync failure has to produce. Asserted by the tests. */
export const SYNC_FAILED_MESSAGE =
	"The board did not answer. Unplug the board, plug it back in, then try Upload again.";

/**
 * The bit of a serial port this file needs. `read` resolves with FEWER than
 * `count` bytes when it runs out of time — a short read IS the timeout, so
 * there is no error type to agree on between the two implementations.
 */
export interface Transport {
	setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>;
	write(bytes: Uint8Array): Promise<void>;
	read(count: number, timeoutMs: number): Promise<Uint8Array>;
	/** Throw away anything that arrived before now. */
	flushInput(): void;
}

/** Every wait and deadline, in one place so tests can shrink them. */
export interface Timing {
	/** How long each half of the DTR/RTS toggle is held. */
	resetPulseMs: number;
	/** How long to let Optiboot start up before talking to it. */
	resetSettleMs: number;
	/** Deadline for one get-sync attempt. */
	syncTimeoutMs: number;
	/** How many get-sync attempts before giving up. */
	syncAttempts: number;
	/** Deadline for every other reply. A page write takes a few milliseconds. */
	commandTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = {
	resetPulseMs: 50,
	resetSettleMs: 250,
	syncTimeoutMs: 500,
	syncAttempts: 5,
	commandTimeoutMs: 2000,
};

export interface UploadOptions {
	/** Called after each page lands, so the page can move a progress bar. */
	onProgress?: (pagesDone: number, pagesTotal: number) => void;
	timing?: Partial<Timing>;
}

export interface UploadResult {
	/** Program bytes, not counting the 0xFF padding on the last page. */
	bytesWritten: number;
	pagesWritten: number;
	elapsedMs: number;
}

/**
 * Reset the board and write `image` to flash from address 0.
 *
 * `image` is what `parseIntelHex` returns. Throws `FlashError` on any failure;
 * the caller shows `error.message` as-is.
 */
export async function uploadImage(
	transport: Transport,
	image: Uint8Array,
	options: UploadOptions = {},
): Promise<UploadResult> {
	const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
	const startedAt = Date.now();

	await resetIntoBootloader(transport, timing);
	await getSync(transport, timing);
	await checkSignature(transport, timing);

	await command(transport, new Uint8Array([CMD_ENTER_PROGMODE, CRC_EOP]), 0, timing.commandTimeoutMs);

	// The last page is padded to a full page with 0xFF, which is what erased
	// flash already holds, so the padding writes nothing the chip did not have.
	const pagesTotal = Math.ceil(image.length / PAGE_SIZE);
	const padded = new Uint8Array(pagesTotal * PAGE_SIZE).fill(0xff);
	padded.set(image);

	for (let page = 0; page < pagesTotal; page += 1) {
		const offset = page * PAGE_SIZE;
		await loadAddress(transport, offset / 2, timing);
		await programPage(transport, padded.subarray(offset, offset + PAGE_SIZE), timing);
		options.onProgress?.(page + 1, pagesTotal);
	}

	await command(transport, new Uint8Array([CMD_LEAVE_PROGMODE, CRC_EOP]), 0, timing.commandTimeoutMs);

	return {
		bytesWritten: image.length,
		pagesWritten: pagesTotal,
		elapsedMs: Date.now() - startedAt,
	};
}

/**
 * Pulse DTR and RTS. The board resets on the edge, so we deliberately produce
 * both edges — assert, hold, release — and only then wait for Optiboot. Which
 * edge does the work depends on the USB-serial chip; making both costs 50 ms
 * and works on genuine Unos and on CH340 clones alike.
 */
async function resetIntoBootloader(transport: Transport, timing: Timing): Promise<void> {
	await transport.setSignals({ dataTerminalReady: false, requestToSend: false });
	await sleep(timing.resetPulseMs);
	await transport.setSignals({ dataTerminalReady: true, requestToSend: true });
	await sleep(timing.resetPulseMs);
	await transport.setSignals({ dataTerminalReady: false, requestToSend: false });
	await sleep(timing.resetSettleMs);
}

/**
 * `30 20` until the board says `14 10`. The first attempt often lands while
 * Optiboot is still waking up, which is normal and not worth reporting.
 */
async function getSync(transport: Transport, timing: Timing): Promise<void> {
	for (let attempt = 0; attempt < timing.syncAttempts; attempt += 1) {
		// Drop the boot noise, and any half-answer left by the previous attempt.
		transport.flushInput();
		await transport.write(new Uint8Array([CMD_GET_SYNC, CRC_EOP]));

		const reply = await transport.read(2, timing.syncTimeoutMs);
		if (reply.length === 2 && reply[0] === STK_INSYNC && reply[1] === STK_OK) return;
	}
	throw new FlashError("sync", SYNC_FAILED_MESSAGE);
}

async function checkSignature(transport: Transport, timing: Timing): Promise<void> {
	const signature = await command(
		transport,
		new Uint8Array([CMD_READ_SIGN, CRC_EOP]),
		ATMEGA328P_SIGNATURE.length,
		timing.commandTimeoutMs,
	);

	const matches = ATMEGA328P_SIGNATURE.every((byte, i) => signature[i] === byte);
	if (!matches) {
		throw new FlashError(
			"signature",
			`That board is not an Uno. It reported chip ${formatBytes(signature)}, and this page only knows how to program an Uno (${formatBytes(ATMEGA328P_SIGNATURE)}).`,
		);
	}
}

/** `55 lo hi 20`. The address is in WORDS, not bytes. */
async function loadAddress(transport: Transport, wordAddress: number, timing: Timing): Promise<void> {
	const request = new Uint8Array([
		CMD_LOAD_ADDRESS,
		wordAddress & 0xff,
		(wordAddress >> 8) & 0xff,
		CRC_EOP,
	]);
	await command(transport, request, 0, timing.commandTimeoutMs);
}

/** `64 00 80 46 <128 bytes> 20`. 0x0080 is the page size, big endian. */
async function programPage(transport: Transport, page: Uint8Array, timing: Timing): Promise<void> {
	const request = new Uint8Array(5 + PAGE_SIZE);
	request[0] = CMD_PROG_PAGE;
	request[1] = (PAGE_SIZE >> 8) & 0xff;
	request[2] = PAGE_SIZE & 0xff;
	request[3] = MEMTYPE_FLASH;
	request.set(page, 4);
	request[4 + PAGE_SIZE] = CRC_EOP;
	await command(transport, request, 0, timing.commandTimeoutMs);
}

/**
 * Send one command and unwrap its `14 <data> 10` reply, returning just the data.
 * A short read means the board stopped talking; a wrong frame means we and it
 * disagree about where we are in the conversation. Both are fatal — carrying on
 * would write pages to an address nobody agreed on.
 */
async function command(
	transport: Transport,
	request: Uint8Array,
	replyDataLength: number,
	timeoutMs: number,
): Promise<Uint8Array> {
	await transport.write(request);

	const framed = await transport.read(replyDataLength + 2, timeoutMs);
	if (framed.length < replyDataLength + 2) {
		throw new FlashError(
			"protocol",
			"The board stopped answering part-way through the upload. Unplug it, plug it back in, then try Upload again.",
		);
	}
	if (framed[0] !== STK_INSYNC || framed[framed.length - 1] !== STK_OK) {
		throw new FlashError(
			"protocol",
			"The board sent something unexpected. Unplug it, plug it back in, then try Upload again.",
		);
	}
	return framed.subarray(1, 1 + replyDataLength);
}

function formatBytes(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

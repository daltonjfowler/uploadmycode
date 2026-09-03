/**
 * The STK500v1 programmer, against a fake Uno.
 *
 * `FakeUno` implements the same `Transport` interface `serial.ts` implements
 * over a real port, and answers the same frames Optiboot answers, so the whole
 * upload conversation is checked here with no board and no browser. It records
 * every byte sent to it, which is how the page-0 test can be exact.
 *
 * The Blink image comes from `fixtures/blink.hex` — see intel-hex.test.mjs for
 * where that file came from and how to regenerate it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { parseIntelHex } from "../src/flash/intel-hex.ts";
import {
	ATMEGA328P_SIGNATURE,
	FlashError,
	PAGE_SIZE,
	SYNC_FAILED_MESSAGE,
	uploadImage,
} from "../src/flash/stk500v1.ts";

const BLINK_IMAGE = parseIntelHex(
	readFileSync(join(import.meta.dirname, "fixtures", "blink.hex"), "utf8"),
);

/** Real timings are 50/250/500 ms. The tests do not need to live through them. */
const FAST = { resetPulseMs: 0, resetSettleMs: 0, syncTimeoutMs: 1, syncAttempts: 3 };

const STK_INSYNC = 0x14;
const STK_OK = 0x10;

/**
 * A board that speaks Optiboot's half of the protocol.
 *
 * `read` hands back whatever has already been queued and never waits, so a
 * dropped answer shows up as a short read — exactly the timeout the real
 * transport produces, minus the waiting.
 */
class FakeUno {
	constructor(options = {}) {
		this.signature = options.signature ?? Array.from(ATMEGA328P_SIGNATURE);
		/** How many get-sync commands to leave unanswered before waking up. */
		this.syncsToIgnore = options.syncsToIgnore ?? 0;

		this.writes = [];
		this.signals = [];
		this.flushes = 0;
		this.addresses = [];
		this.pages = [];
		this.pending = [];
	}

	async setSignals(signals) {
		this.signals.push({ ...signals });
	}

	flushInput() {
		this.flushes += 1;
		this.pending.length = 0;
	}

	async write(bytes) {
		this.writes.push(Uint8Array.from(bytes));
		this.answer(bytes);
	}

	async read(count) {
		return Uint8Array.from(this.pending.splice(0, Math.min(count, this.pending.length)));
	}

	answer(bytes) {
		switch (bytes[0]) {
			case 0x30: // get sync
				if (this.syncsToIgnore > 0) {
					this.syncsToIgnore -= 1;
					return;
				}
				this.pending.push(STK_INSYNC, STK_OK);
				return;
			case 0x75: // read signature
				this.pending.push(STK_INSYNC, ...this.signature, STK_OK);
				return;
			case 0x55: // load address
				this.addresses.push(bytes[1] | (bytes[2] << 8));
				this.pending.push(STK_INSYNC, STK_OK);
				return;
			case 0x64: // program page
				this.pages.push(Uint8Array.from(bytes.subarray(4, bytes.length - 1)));
				this.pending.push(STK_INSYNC, STK_OK);
				return;
			case 0x50: // enter programming mode
			case 0x51: // leave programming mode
				this.pending.push(STK_INSYNC, STK_OK);
				return;
			default:
				throw new Error(`fake Uno got command 0x${bytes[0].toString(16)}`);
		}
	}

	/** Every write whose first byte is `command`. */
	commandsSent(command) {
		return this.writes.filter((write) => write[0] === command);
	}
}

function bytes(write) {
	return Array.from(write);
}

test("toggles DTR and RTS to reset the board before saying anything", async () => {
	const board = new FakeUno();
	await uploadImage(board, BLINK_IMAGE, { timing: FAST });

	assert.deepEqual(board.signals, [
		{ dataTerminalReady: false, requestToSend: false },
		{ dataTerminalReady: true, requestToSend: true },
		{ dataTerminalReady: false, requestToSend: false },
	]);
});

test("retries get-sync and carries on once the bootloader wakes up", async () => {
	const board = new FakeUno({ syncsToIgnore: 2 });
	const result = await uploadImage(board, BLINK_IMAGE, { timing: FAST });

	const syncs = board.commandsSent(0x30);
	assert.equal(syncs.length, 3, "two ignored, the third answered");
	for (const sync of syncs) assert.deepEqual(bytes(sync), [0x30, 0x20]);
	// Stale bytes are dropped before every attempt.
	assert.equal(board.flushes, 3);
	assert.equal(result.bytesWritten, 924);
});

test("gives up with the unplug-and-replug sentence when the board never answers", async () => {
	const board = new FakeUno({ syncsToIgnore: Number.POSITIVE_INFINITY });

	await assert.rejects(
		() => uploadImage(board, BLINK_IMAGE, { timing: FAST }),
		(error) => {
			assert.ok(error instanceof FlashError);
			assert.equal(error.kind, "sync");
			assert.equal(error.message, SYNC_FAILED_MESSAGE);
			assert.match(error.message, /Unplug the board, plug it back in, then try Upload again/);
			return true;
		},
	);

	assert.equal(board.commandsSent(0x30).length, FAST.syncAttempts);
	// It never got as far as programming anything.
	assert.equal(board.pages.length, 0);
});

test("reads the signature and refuses a chip that is not an ATmega328P", async () => {
	const good = new FakeUno();
	await uploadImage(good, BLINK_IMAGE, { timing: FAST });
	assert.deepEqual(bytes(good.commandsSent(0x75)[0]), [0x75, 0x20]);

	const wrong = new FakeUno({ signature: [0x1e, 0x95, 0x87] }); // ATmega32U4
	await assert.rejects(
		() => uploadImage(wrong, BLINK_IMAGE, { timing: FAST }),
		(error) => {
			assert.ok(error instanceof FlashError);
			assert.equal(error.kind, "signature");
			assert.match(error.message, /not an Uno/);
			assert.match(error.message, /1E 95 87/);
			return true;
		},
	);
	assert.equal(wrong.pages.length, 0, "nothing is written to the wrong chip");
});

test("sends page 0 of Blink byte for byte", async () => {
	const board = new FakeUno();
	await uploadImage(board, BLINK_IMAGE, { timing: FAST });

	// The address is in WORDS, so page 0 is word 0 and page 1 is word 64.
	assert.deepEqual(bytes(board.commandsSent(0x55)[0]), [0x55, 0x00, 0x00, 0x20]);
	assert.deepEqual(bytes(board.commandsSent(0x55)[1]), [0x55, 0x40, 0x00, 0x20]);

	const expected = [
		0x64, // STK_PROG_PAGE
		0x00, // page size, high byte
		0x80, // page size, low byte (128)
		0x46, // 'F', flash
		...BLINK_IMAGE.slice(0, PAGE_SIZE),
		0x20, // CRC_EOP
	];
	assert.equal(expected.length, 133);
	assert.deepEqual(bytes(board.commandsSent(0x64)[0]), expected);
	// The very first bytes of the sketch, as a sanity check on the slice above.
	assert.deepEqual(expected.slice(4, 8), [0x0c, 0x94, 0x5c, 0x00]);
});

test("writes every page, pads the last one with 0xFF, and reports progress", async () => {
	const board = new FakeUno();
	const progress = [];
	const result = await uploadImage(board, BLINK_IMAGE, {
		timing: FAST,
		onProgress: (done, total) => progress.push([done, total]),
	});

	// 924 bytes is 7 full pages plus 28 bytes.
	assert.equal(result.pagesWritten, 8);
	assert.equal(board.pages.length, 8);
	assert.deepEqual(board.addresses, [0, 64, 128, 192, 256, 320, 384, 448]);
	assert.deepEqual(progress, [
		[1, 8],
		[2, 8],
		[3, 8],
		[4, 8],
		[5, 8],
		[6, 8],
		[7, 8],
		[8, 8],
	]);

	// Every page is a full 128 bytes and together they rebuild the image.
	const flashed = new Uint8Array(8 * PAGE_SIZE);
	board.pages.forEach((page, index) => {
		assert.equal(page.length, PAGE_SIZE, `page ${index}`);
		flashed.set(page, index * PAGE_SIZE);
	});
	assert.deepEqual(Array.from(flashed.slice(0, 924)), Array.from(BLINK_IMAGE));
	// The tail of the last page is erased-flash padding, so it writes nothing.
	assert.deepEqual(Array.from(flashed.slice(924)), new Array(1024 - 924).fill(0xff));

	assert.equal(result.bytesWritten, 924);
	assert.ok(result.elapsedMs >= 0);
});

test("leaves programming mode as the last thing it says", async () => {
	const board = new FakeUno();
	await uploadImage(board, BLINK_IMAGE, { timing: FAST });

	assert.deepEqual(bytes(board.writes.at(-1)), [0x51, 0x20]);
	// And entered it before the first page went out.
	const order = board.writes.map((write) => write[0]);
	assert.ok(order.indexOf(0x50) < order.indexOf(0x64), "enter progmode comes first");
	assert.equal(board.commandsSent(0x51).length, 1);
});

test("stops with a readable message if the board goes quiet mid-flash", async () => {
	const board = new FakeUno();
	// Answer everything up to the third page, then play dead.
	const realAnswer = board.answer.bind(board);
	let answered = 0;
	board.answer = (request) => {
		answered += 1;
		if (answered > 8) return;
		realAnswer(request);
	};

	await assert.rejects(
		() => uploadImage(board, BLINK_IMAGE, { timing: FAST }),
		(error) => {
			assert.ok(error instanceof FlashError);
			assert.equal(error.kind, "protocol");
			assert.match(error.message, /stopped answering part-way through the upload/);
			return true;
		},
	);
});

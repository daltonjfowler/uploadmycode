/**
 * Intel HEX -> a flat flash image.
 *
 * The compile server hands back Intel HEX text. Before we can push it at the
 * bootloader it has to become plain bytes laid out the way flash is laid out:
 * one contiguous block starting at address 0. Anything the hex file does not
 * mention stays 0xFF, which is what erased flash reads as, so writing it back
 * changes nothing.
 *
 * A record looks like this:
 *
 *     :10 0000 00 0C945C000C946E000C946E000C946E00 CA
 *      |  |    |  |                                └ checksum
 *      |  |    |  └ data (LL bytes)
 *      |  |    └ record type
 *      |  └ address (big endian)
 *      └ LL, the data length in bytes
 *
 * Every byte from LL to the last data byte is summed; the checksum is the two's
 * complement of that sum, so summing the WHOLE record must give 0 mod 256.
 *
 * Record types we handle:
 *   00 data, 01 end of file, 02 extended segment address, 04 extended linear
 *   address. 03 and 05 (start addresses) are skipped — an AVR always starts at
 *   0. Anything else is an error, because guessing at a hex file we do not
 *   understand is how you brick a board.
 *
 * An avr-gcc sketch for the Uno only ever uses 00 and 01, but the extended
 * records cost ten lines and mean a hex file from anywhere else either works or
 * says plainly that it does not.
 *
 * Written from Intel's Hexadecimal Object File Format Specification — no code
 * from any existing parser. See CREDITS.md.
 */

/** Flash on an ATmega328P minus the Optiboot bootloader, which we must not overwrite. */
export const UNO_MAX_PROGRAM_BYTES = 32256;

/** A hex file we refuse to flash. `message` is safe to show a student. */
export class HexParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HexParseError";
	}
}

interface Chunk {
	address: number;
	data: Uint8Array;
}

/**
 * Turn Intel HEX text into the bytes to write to flash, starting at address 0
 * and padded with 0xFF wherever the file is silent.
 *
 * Throws `HexParseError` with a readable sentence if the text is not a hex file
 * we can flash safely.
 */
export function parseIntelHex(text: string): Uint8Array {
	const chunks: Chunk[] = [];
	let baseAddress = 0;
	let endOfImage = 0;
	let sawEndRecord = false;
	let lineNumber = 0;

	for (const rawLine of text.split(/\r?\n/)) {
		lineNumber += 1;
		const line = rawLine.trim();
		if (line === "") continue;
		if (sawEndRecord) {
			// Anything after the end record is padding from a text editor, not data.
			continue;
		}

		const record = decodeRecord(line, lineNumber);
		const address = (record[1]! << 8) | record[2]!;
		const type = record[3]!;
		const length = record[0]!;
		const data = record.subarray(4, 4 + length);

		switch (type) {
			case 0x00: {
				const start = baseAddress + address;
				chunks.push({ address: start, data });
				endOfImage = Math.max(endOfImage, start + length);
				break;
			}
			case 0x01:
				sawEndRecord = true;
				break;
			case 0x02:
				// Extended segment address: the next records sit at value * 16.
				baseAddress = readWord(data, length, lineNumber) * 16;
				break;
			case 0x04:
				// Extended linear address: the next records sit at value * 65536.
				baseAddress = readWord(data, length, lineNumber) * 65536;
				break;
			case 0x03:
			case 0x05:
				// Start address. An AVR always begins at 0; nothing to do.
				break;
			default:
				throw new HexParseError(
					`Line ${lineNumber}: hex record type ${hex2(type)} is not one this page knows how to flash.`,
				);
		}
	}

	if (!sawEndRecord) {
		throw new HexParseError(
			"The hex file has no end-of-file record. It was probably cut short. Compile again.",
		);
	}
	if (endOfImage === 0) {
		throw new HexParseError("The hex file has no program in it. Compile again.");
	}
	if (endOfImage > UNO_MAX_PROGRAM_BYTES) {
		throw new HexParseError(
			`This sketch needs ${endOfImage} bytes of flash and an Uno only has ${UNO_MAX_PROGRAM_BYTES}. Make the sketch smaller.`,
		);
	}

	const image = new Uint8Array(endOfImage).fill(0xff);
	for (const chunk of chunks) image.set(chunk.data, chunk.address);
	return image;
}

/**
 * One record's bytes, checksum already verified: `[length, addrHi, addrLo,
 * type, ...data, checksum]`.
 */
function decodeRecord(line: string, lineNumber: number): Uint8Array {
	if (line[0] !== ":") {
		throw new HexParseError(`Line ${lineNumber}: a hex record must start with ":".`);
	}
	const body = line.slice(1);
	if (body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
		throw new HexParseError(`Line ${lineNumber}: this is not a whole hex record.`);
	}

	const bytes = new Uint8Array(body.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
	}

	// length + address + type + checksum is 5 bytes of overhead.
	if (bytes.length < 5) {
		throw new HexParseError(`Line ${lineNumber}: the record is too short to be a hex record.`);
	}
	if (bytes.length !== bytes[0]! + 5) {
		throw new HexParseError(
			`Line ${lineNumber}: the record claims ${bytes[0]} data bytes but carries ${bytes.length - 5}.`,
		);
	}

	let sum = 0;
	for (const byte of bytes) sum = (sum + byte) & 0xff;
	if (sum !== 0) {
		throw new HexParseError(
			`Line ${lineNumber}: the checksum does not match. The hex file is damaged. Compile again.`,
		);
	}

	return bytes;
}

/** The two-byte payload of an extended address record. */
function readWord(data: Uint8Array, length: number, lineNumber: number): number {
	if (length !== 2) {
		throw new HexParseError(
			`Line ${lineNumber}: an extended address record must carry exactly 2 bytes.`,
		);
	}
	return (data[0]! << 8) | data[1]!;
}

function hex2(value: number): string {
	return value.toString(16).padStart(2, "0").toUpperCase();
}

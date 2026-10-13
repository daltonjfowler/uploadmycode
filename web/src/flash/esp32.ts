/**
 * Upload to an ESP32 with Espressif's own esptool-js (Apache-2.0).
 *
 * The UNO has a tiny hand-written flasher (stk500v1.ts). The ESP32's ROM
 * bootloader protocol is much bigger (sync, a RAM stub, compressed writes, MD5
 * checks), so here the vendor's library does it. It is loaded with import() only
 * when an ESP32 upload starts, so the UNO page never downloads it.
 *
 * The compile server sends one image for flash address 0 (bootloader,
 * partition table, boot_app0 and the sketch, merged). It is built for the
 * classic ESP32 only, so any other chip (S2, S3, C3...) is refused before a
 * byte is written.
 */

import { FlashError } from "./stk500v1.ts";
import { describeOpenFailure, type SerialPortLike } from "./serial.ts";

/** The DOMException names SerialPort.open() throws. esptool-js's own errors are ESPError. */
function isPortOpenFailure(cause: unknown): boolean {
	const name = cause instanceof Error ? cause.name : "";
	return name === "NetworkError" || name === "InvalidStateError" || name === "SecurityError";
}

/** Fast and reliable on CP2102 and CH340 boards. The ROM itself starts at 115200. */
const FLASH_BAUD = 460800;

export interface Esp32Result {
	bytesWritten: number;
	elapsedMs: number;
	chip: string;
}

/** base64 from the compile server -> bytes. */
export function decodeImage(base64: string): Uint8Array {
	const text = atob(base64);
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
	return bytes;
}

/**
 * Flash `image` at `address`, then reset the board so it runs. The port must be
 * closed: esptool-js opens it itself, and closes it again before this returns.
 */
export async function uploadEsp32(
	port: SerialPortLike,
	image: Uint8Array,
	address: number,
	onProgress: (written: number, total: number) => void,
): Promise<Esp32Result> {
	const { ESPLoader, Transport } = await import("esptool-js");
	const started = performance.now();
	// esptool-js wants the real SerialPort; ours is the same object behind a narrower type.
	const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0], false);
	try {
		const loader = new ESPLoader({ transport, baudrate: FLASH_BAUD, romBaudrate: 115200 });
		let chip: string;
		try {
			chip = await loader.main();
		} catch (cause) {
			// esptool-js opens the port inside main(), so a port that would not
			// open lands here too. That is "busy or unplugged", not "hold BOOT".
			if (isPortOpenFailure(cause)) throw new FlashError("busy", describeOpenFailure(cause));
			throw new FlashError(
				"sync",
				"The ESP32 did not answer. Hold the BOOT button on the board, click Upload, and let go when the bar starts moving. " +
					`Still stuck: unplug the board, plug it back in, and try again. (${cause instanceof Error ? cause.message : String(cause)})`,
			);
		}
		if (loader.chip.CHIP_NAME !== "ESP32") {
			throw new FlashError(
				"signature",
				`This board is an ${loader.chip.CHIP_NAME}. This site makes programs for the classic ESP32 (ESP32 DevKit / ESP32-WROOM) only, so nothing was written.`,
			);
		}
		await loader.writeFlash({
			fileArray: [{ data: image, address }],
			flashMode: "keep",
			flashFreq: "keep",
			flashSize: "keep",
			eraseAll: false,
			compress: true,
			reportProgress: (_file, written, total) => onProgress(written, total),
		});
		await loader.after("hard_reset");
		return { bytesWritten: image.length, elapsedMs: Math.round(performance.now() - started), chip };
	} finally {
		try {
			await transport.disconnect();
		} catch {
			// Already closed, or the board was unplugged.
		}
	}
}

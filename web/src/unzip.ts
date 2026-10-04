/**
 * Just enough of a .zip reader for library downloads, with the browser's own
 * DecompressionStream, so no dependency. Stored and deflated files only (that is
 * every library zip GitHub and the Arduino site hand out); ZIP64 and encrypted
 * files are refused with a sentence.
 *
 * `want` picks the files worth unpacking, so a library's pictures and examples
 * are never inflated, and `maxBytes` caps what is unpacked in total: a small zip
 * can claim to hold gigabytes.
 */

export interface ZipFile {
	path: string;
	bytes: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {}

export async function unzip(data: ArrayBuffer, want: (path: string) => boolean, maxBytes: number): Promise<ZipFile[]> {
	const view = new DataView(data);
	const bytes = new Uint8Array(data);
	// The end record is in the last 22 bytes plus up to 64 KB of comment.
	let end = -1;
	for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 22 - 65535); i--) {
		if (view.getUint32(i, true) === EOCD) { end = i; break; }
	}
	if (end < 0) throw new ZipError("This file is not a .zip, or it is damaged.");
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	if (count === 0xffff || at === 0xffffffff) throw new ZipError("This .zip is too big to open here.");

	const names = new TextDecoder();
	const out: ZipFile[] = [];
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (at + 46 > data.byteLength || view.getUint32(at, true) !== CENTRAL) throw new ZipError("This .zip is damaged.");
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const size = view.getUint32(at + 20, true);
		const fullSize = view.getUint32(at + 24, true);
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const path = names.decode(bytes.subarray(at + 46, at + 46 + nameLen));
		at += 46 + nameLen + extraLen + commentLen;

		if (path.endsWith("/") || !want(path)) continue;
		if (flags & 1) throw new ZipError("This .zip has a password, so it cannot be opened here.");
		if (method !== 0 && method !== 8) throw new ZipError("This .zip uses a kind of packing that cannot be opened here.");
		total += fullSize;
		if (total > maxBytes) throw new ZipError(`This library is bigger than ${Math.round(maxBytes / 1024)} KB, so it cannot be used here.`);

		if (local + 30 > data.byteLength || view.getUint32(local, true) !== LOCAL) throw new ZipError("This .zip is damaged.");
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const packed = bytes.subarray(start, start + size);
		const file = method === 0 ? packed.slice() : await inflate(packed, fullSize);
		if (file.length !== fullSize) throw new ZipError("This .zip is damaged.");
		out.push({ path, bytes: file });
	}
	return out;
}

/** Inflate raw deflate data, stopping if it grows past what the zip said it holds. */
async function inflate(packed: Uint8Array, expected: number): Promise<Uint8Array> {
	const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	const reader = stream.getReader();
	const out = new Uint8Array(expected);
	let got = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (got + value.length > expected) {
			await reader.cancel();
			throw new ZipError("This .zip is damaged.");
		}
		out.set(value, got);
		got += value.length;
	}
	return got === expected ? out : out.subarray(0, got);
}

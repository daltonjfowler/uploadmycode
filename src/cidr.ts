/**
 * The optional in-person lock: is this client inside one of the school's IP
 * ranges?
 *
 * `ALLOWED_CIDRS` in wrangler.jsonc is a comma-separated list of IPv4 and IPv6
 * ranges, empty by default. When it is empty the lock is off and this file is
 * never consulted. When it is set, the Worker compares Cloudflare's
 * `cf-connecting-ip` against every range and refuses anything outside them.
 *
 * Everything here is pure: no bindings, no clock, no network. `test/cidr.test.mjs`
 * runs it directly under `node --test`.
 */

/** One parsed range. `bytes` is 4 long for IPv4 and 16 for IPv6. */
export interface Cidr {
	readonly bytes: Uint8Array;
	/** Number of leading bits that must match. 0..32 for IPv4, 0..128 for IPv6. */
	readonly prefix: number;
	readonly family: 4 | 6;
}

/** Bits in an address of each family. */
const BITS = { 4: 32, 6: 128 } as const;

/**
 * One IPv4 octet. Rejects "01" and "+1" so that no two spellings of the same
 * range can ever be written into the allowlist.
 */
function parseOctet(part: string): number | null {
	if (!/^\d{1,3}$/.test(part)) return null;
	const value = Number(part);
	if (value > 255) return null;
	// "01" parses to 1 but is not how anyone should write a range.
	if (String(value) !== part) return null;
	return value;
}

function parseIpv4(text: string): Uint8Array | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;

	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const octet = parseOctet(parts[i]!);
		if (octet === null) return null;
		bytes[i] = octet;
	}
	return bytes;
}

/** One IPv6 group: one to four hex digits. */
function parseGroup(part: string): number | null {
	if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
	return Number.parseInt(part, 16);
}

function parseIpv6(text: string): Uint8Array | null {
	// "::ffff:10.0.0.1" and "1:2:3:4:5:6:10.0.0.1": rewrite the trailing dotted
	// quad as two hex groups and parse the result as an ordinary address.
	if (text.includes(".")) {
		const cut = text.lastIndexOf(":");
		if (cut < 0) return null;
		const quad = parseIpv4(text.slice(cut + 1));
		if (quad === null) return null;
		const asGroups =
			((quad[0]! << 8) | quad[1]!).toString(16) + ":" + ((quad[2]! << 8) | quad[3]!).toString(16);
		// slice keeps the ':' before the quad, so the two halves join cleanly.
		return parseIpv6(text.slice(0, cut + 1) + asGroups);
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;

	const head = halves[0] === "" ? [] : halves[0]!.split(":");
	const tail = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
	// Without "::" every group must be written out; with it, the gap is zeroes.
	if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 8) return null;

	const bytes = new Uint8Array(16);
	for (let i = 0; i < head.length; i++) {
		const group = parseGroup(head[i]!);
		if (group === null) return null;
		bytes[i * 2] = group >> 8;
		bytes[i * 2 + 1] = group & 0xff;
	}
	// The tail is right-aligned; the untouched middle stays zero.
	const tailStart = 16 - tail.length * 2;
	for (let i = 0; i < tail.length; i++) {
		const group = parseGroup(tail[i]!);
		if (group === null) return null;
		bytes[tailStart + i * 2] = group >> 8;
		bytes[tailStart + i * 2 + 1] = group & 0xff;
	}
	return bytes;
}

/** True for ::ffff:a.b.c.d, the IPv6 spelling of an IPv4 address. */
function isIpv4Mapped(bytes: Uint8Array): boolean {
	if (bytes.length !== 16) return false;
	for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
	return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Parse one entry: a bare address, or an address with a "/prefix".
 *
 * An IPv4-mapped IPv6 address is folded down to plain IPv4 so that a client
 * that arrives as `::ffff:10.1.2.3` still matches a `10.1.0.0/16` in the
 * allowlist. Folding only happens when the prefix covers the whole ::ffff:
 * header, so a range whose prefix cuts through it is left alone.
 *
 * Returns null for anything it does not fully understand. A range nobody can
 * parse must never quietly become "match everything".
 */
export function parseCidr(text: string): Cidr | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;

	const slash = trimmed.indexOf("/");
	const address = slash < 0 ? trimmed : trimmed.slice(0, slash);
	const suffix = slash < 0 ? null : trimmed.slice(slash + 1);

	let family: 4 | 6;
	let bytes: Uint8Array | null;
	if (address.includes(":")) {
		family = 6;
		bytes = parseIpv6(address);
	} else {
		family = 4;
		bytes = parseIpv4(address);
	}
	if (bytes === null) return null;

	let prefix: number = BITS[family];
	if (suffix !== null) {
		if (!/^\d{1,3}$/.test(suffix)) return null;
		prefix = Number(suffix);
		if (prefix > BITS[family]) return null;
	}

	if (family === 6 && isIpv4Mapped(bytes) && prefix >= 96) {
		return { bytes: bytes.slice(12), prefix: prefix - 96, family: 4 };
	}
	return { bytes, prefix, family };
}

/**
 * Parse the whole `ALLOWED_CIDRS` value.
 *
 * Bad entries are reported rather than thrown, so one typo cannot take the site
 * down mid-class; the Worker logs them and enforces the ranges it did
 * understand.
 */
export function parseCidrList(raw: string): { cidrs: Cidr[]; invalid: string[] } {
	const cidrs: Cidr[] = [];
	const invalid: string[] = [];

	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		const parsed = parseCidr(trimmed);
		if (parsed === null) invalid.push(trimmed);
		else cidrs.push(parsed);
	}
	return { cidrs, invalid };
}

/** Do the first `prefix` bits of two same-family addresses agree? */
function inRange(address: Cidr, range: Cidr): boolean {
	if (address.family !== range.family) return false;

	const wholeBytes = range.prefix >> 3;
	for (let i = 0; i < wholeBytes; i++) {
		if (address.bytes[i] !== range.bytes[i]) return false;
	}

	const leftoverBits = range.prefix & 7;
	if (leftoverBits === 0) return true;
	// Top `leftoverBits` bits of the next byte, e.g. /28 -> 0b11110000.
	const mask = (0xff << (8 - leftoverBits)) & 0xff;
	return (address.bytes[wholeBytes]! & mask) === (range.bytes[wholeBytes]! & mask);
}

/**
 * Is `ip` inside any of `cidrs`?
 *
 * An address the parser cannot read is not in any range. Callers must skip this
 * entirely when the allowlist is empty: an empty list matches nothing, which is
 * the right answer for "is it in the list" and the wrong one for "is the lock
 * even on".
 */
export function ipAllowed(ip: string, cidrs: readonly Cidr[]): boolean {
	if (cidrs.length === 0) return false;
	const address = parseCidr(ip);
	if (address === null) return false;
	// A bare address parses with a full-length prefix; anything shorter came
	// with a "/n" and is a range, not a client, so it cannot be let in.
	if (address.prefix !== BITS[address.family]) return false;

	return cidrs.some((range) => inRange(address, range));
}

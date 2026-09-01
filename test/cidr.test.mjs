/**
 * The optional school-IP lock.
 *
 * Run with `npm test`. Node runs src/cidr.ts directly (it strips the types).
 *
 * The rule this file is really protecting: a range nobody can parse must never
 * turn into "match everything". Every malformed input below has to come back
 * false or null, not true.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ipAllowed, parseCidr, parseCidrList } from "../src/cidr.ts";

/** Shorthand: is this address inside this one range? */
function inside(ip, range) {
	const parsed = parseCidr(range);
	assert.notEqual(parsed, null, `range ${range} should parse`);
	return ipAllowed(ip, [parsed]);
}

// ------------------------------------------------------------------- parsing

test("a bare address parses with a full-length prefix", () => {
	assert.deepEqual(parseCidr("203.0.113.5"), {
		bytes: new Uint8Array([203, 0, 113, 5]),
		prefix: 32,
		family: 4,
	});
	assert.equal(parseCidr("::1").prefix, 128);
	assert.equal(parseCidr("::1").family, 6);
});

test("malformed entries are refused, not guessed at", () => {
	for (const bad of [
		"",
		"   ",
		"not-an-ip",
		"203.0.113",
		"203.0.113.5.6",
		"203.0.113.256",
		"203.0.113.05", // leading zero: two spellings of one range
		"203.0.113.+5",
		"203.0.113.5/33",
		"203.0.113.5/",
		"203.0.113.5/x",
		"2001:db8::/129",
		"2001:db8::1::2", // two "::" runs
		"2001:db8:g::1",
		"1:2:3:4:5:6:7", // too few groups, no "::"
		"1:2:3:4:5:6:7:8:9",
	]) {
		assert.equal(parseCidr(bad), null, `${JSON.stringify(bad)} must not parse`);
	}
});

test("the list splits on commas, skips blanks and reports what it could not read", () => {
	const { cidrs, invalid } = parseCidrList(" 203.0.113.0/24 , , 2001:db8::/32 ,nonsense/8 ");
	assert.equal(cidrs.length, 2);
	assert.deepEqual(invalid, ["nonsense/8"]);
});

test("an empty list parses to nothing, which is how the lock stays off", () => {
	assert.deepEqual(parseCidrList(""), { cidrs: [], invalid: [] });
	assert.deepEqual(parseCidrList("   "), { cidrs: [], invalid: [] });
	// ipAllowed against an empty list is false; the Worker checks length first.
	assert.equal(ipAllowed("203.0.113.5", []), false);
});

// --------------------------------------------------------------- IPv4 masks

test("IPv4 /24", () => {
	assert.equal(inside("203.0.113.0", "203.0.113.0/24"), true);
	assert.equal(inside("203.0.113.255", "203.0.113.0/24"), true);
	assert.equal(inside("203.0.114.0", "203.0.113.0/24"), false);
	assert.equal(inside("203.0.112.255", "203.0.113.0/24"), false);
});

test("IPv4 edge masks: /32, /31, /0", () => {
	assert.equal(inside("203.0.113.5", "203.0.113.5/32"), true);
	assert.equal(inside("203.0.113.6", "203.0.113.5/32"), false);
	assert.equal(inside("203.0.113.5", "203.0.113.5"), true, "no slash means /32");

	assert.equal(inside("203.0.113.4", "203.0.113.4/31"), true);
	assert.equal(inside("203.0.113.5", "203.0.113.4/31"), true);
	assert.equal(inside("203.0.113.6", "203.0.113.4/31"), false);

	assert.equal(inside("8.8.8.8", "0.0.0.0/0"), true, "/0 lets everyone in");
	assert.equal(inside("203.0.113.5", "0.0.0.0/0"), true);
});

test("IPv4 masks that cut through a byte", () => {
	// /20 = 255.255.240.0
	assert.equal(inside("10.1.0.1", "10.1.0.0/20"), true);
	assert.equal(inside("10.1.15.255", "10.1.0.0/20"), true);
	assert.equal(inside("10.1.16.0", "10.1.0.0/20"), false);

	// /28 = the top four bits of the last byte.
	assert.equal(inside("192.168.1.15", "192.168.1.0/28"), true);
	assert.equal(inside("192.168.1.16", "192.168.1.0/28"), false);

	// /1 splits the address space in half.
	assert.equal(inside("127.255.255.255", "0.0.0.0/1"), true);
	assert.equal(inside("128.0.0.0", "0.0.0.0/1"), false);
});

test("a range written with host bits set still covers its block", () => {
	// 203.0.113.7/24 is sloppy but unambiguous, and IT hands out worse.
	assert.equal(inside("203.0.113.200", "203.0.113.7/24"), true);
});

// --------------------------------------------------------------- IPv6 masks

test("IPv6 /32 and /64", () => {
	assert.equal(inside("2001:db8::1", "2001:db8::/32"), true);
	assert.equal(inside("2001:db8:ffff:ffff::1", "2001:db8::/32"), true);
	assert.equal(inside("2001:db9::1", "2001:db8::/32"), false);

	assert.equal(inside("2001:db8:1:2::abcd", "2001:db8:1:2::/64"), true);
	assert.equal(inside("2001:db8:1:3::abcd", "2001:db8:1:2::/64"), false);
});

test("IPv6 edge masks: /128, /0, /33, /127", () => {
	assert.equal(inside("2001:db8::1", "2001:db8::1/128"), true);
	assert.equal(inside("2001:db8::2", "2001:db8::1/128"), false);

	assert.equal(inside("2001:db8::1", "::/0"), true, "/0 lets everyone in");
	assert.equal(inside("::", "::/0"), true);

	// /33 cuts through the fifth byte: 2001:db8:0000 vs 2001:db8:8000.
	assert.equal(inside("2001:db8:7fff::1", "2001:db8::/33"), true);
	assert.equal(inside("2001:db8:8000::1", "2001:db8::/33"), false);

	assert.equal(inside("2001:db8::0", "2001:db8::/127"), true);
	assert.equal(inside("2001:db8::1", "2001:db8::/127"), true);
	assert.equal(inside("2001:db8::2", "2001:db8::/127"), false);
});

test("IPv6 written out in full matches the same range as the compressed form", () => {
	assert.equal(inside("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::/32"), true);
	assert.equal(inside("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0000/32"), true);
});

test("an IPv4-mapped IPv6 client still matches the IPv4 range it belongs to", () => {
	assert.equal(inside("::ffff:10.1.2.3", "10.1.0.0/16"), true);
	assert.equal(inside("::ffff:10.2.2.3", "10.1.0.0/16"), false);
	// And written as hex groups rather than a dotted quad.
	assert.equal(inside("::ffff:0a01:0203", "10.1.0.0/16"), true);
});

test("the two families never match each other", () => {
	assert.equal(inside("2001:db8::1", "0.0.0.0/0"), false);
	assert.equal(inside("203.0.113.5", "::/0"), false);
});

// ------------------------------------------------------------- what ipAllowed
// is actually asked at request time

test("any one range in the list is enough", () => {
	const { cidrs } = parseCidrList("198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32");
	assert.equal(ipAllowed("203.0.113.9", cidrs), true);
	assert.equal(ipAllowed("198.51.100.1", cidrs), true);
	assert.equal(ipAllowed("2001:db8::99", cidrs), true);
	assert.equal(ipAllowed("192.0.2.1", cidrs), false);
});

test("a missing or unreadable client IP is never allowed in", () => {
	const { cidrs } = parseCidrList("0.0.0.0/0, ::/0");
	// cf-connecting-ip absent: the Worker passes "".
	assert.equal(ipAllowed("", cidrs), false);
	assert.equal(ipAllowed("unknown", cidrs), false);
	// A range is not a client. Somebody sending "10.0.0.0/8" as their address
	// must not be treated as being inside 10.0.0.0/8.
	assert.equal(ipAllowed("0.0.0.0/0", cidrs), false);
});

/**
 * Talking to POST /api/compile.
 *
 * The Worker passes the compile container's JSON straight through, so there are
 * exactly three shapes to expect and we branch on which key is present:
 *
 *   { ok: true,  hex }     compiled
 *   { ok: false, stderr }  the sketch is wrong (still HTTP 200)
 *   { ok: false, error }   the compiler never ran, and `error` says why
 *
 * Everything else — a dropped connection, an HTML error page, a shape we do not
 * recognise — becomes one "service" outcome with a sentence a student can read.
 *
 * Every compile carries two headers:
 *
 *   x-class-phrase  today's class phrase. A 403 means it is missing, wrong or
 *                   expired, and the Worker's sentence is shown word for word
 *                   because it is what tells a student to ask the teacher. A
 *                   wrong phrase is only ever a 403 — never a lockout, never a
 *                   delay — because the whole school shares one public address
 *                   and one student must not be able to shut the room down.
 *   x-client-id     this browser's id from storage.ts, which is how the Worker
 *                   gives every Chromebook its own six compiles a minute
 *                   instead of six for the school.
 *
 * An HTTP 429 is therefore always about pace, never about the phrase: either
 * this browser has compiled six times in a minute or the whole site is at its
 * ceiling. Both say so in a sentence and both mean "wait, then click Compile".
 */

import { loadClientId } from "./storage.ts";

export type CompileOutcome =
	| { kind: "success"; hex: string }
	| { kind: "compile-error"; stderr: string }
	| { kind: "busy"; message: string }
	/** HTTP 403. The page must ask for the phrase again. */
	| { kind: "phrase-required"; message: string }
	| { kind: "service-error"; message: string };

/** Same path in dev (Vite proxies it to the local server) and in production. */
const COMPILE_URL = "/api/compile";

export async function requestCompile(code: string, phrase: string): Promise<CompileOutcome> {
	let response: Response;
	try {
		response = await fetch(COMPILE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-class-phrase": phrase,
				"x-client-id": loadClientId(),
			},
			body: JSON.stringify({ code }),
		});
	} catch {
		return {
			kind: "service-error",
			message: "Could not reach the compiler. Check the Wi-Fi and try again.",
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			kind: "service-error",
			message: `The compiler sent a reply the page could not read (HTTP ${response.status}).`,
		};
	}

	const reply = body as { ok?: unknown; hex?: unknown; stderr?: unknown; error?: unknown };

	if (reply.ok === true && typeof reply.hex === "string") {
		return { kind: "success", hex: reply.hex };
	}
	// stderr means the compiler ran and had something to say about the sketch.
	if (typeof reply.stderr === "string") {
		return { kind: "compile-error", stderr: reply.stderr };
	}
	// error means the compiler never ran. The Worker's sentence is always shown
	// as it was written: 403 phrase, 413 too big, 429 too fast, 503 over capacity.
	if (typeof reply.error === "string") {
		if (response.status === 403) return { kind: "phrase-required", message: reply.error };
		return response.status === 503
			? { kind: "busy", message: reply.error }
			: { kind: "service-error", message: reply.error };
	}

	return {
		kind: "service-error",
		message: `Unexpected reply from the compiler (HTTP ${response.status}).`,
	};
}

/**
 * How many bytes of program the Intel HEX actually contains, so the page can
 * say "1050 bytes of 32256" the way the Arduino IDE does.
 *
 * An Intel HEX record is ":LLAAAATT<data><checksum>". LL is the data length in
 * bytes, TT is the record type, and only type 00 records hold program data.
 * Anything malformed is skipped rather than thrown: this is a status line, not
 * the flasher. T3 does the real parsing.
 */
export function hexProgramBytes(hex: string): number {
	let total = 0;
	for (const line of hex.split(/\r?\n/)) {
		const record = line.trim();
		if (record.length < 11 || record[0] !== ":") continue;
		if (record.slice(7, 9) !== "00") continue;
		const length = Number.parseInt(record.slice(1, 3), 16);
		if (Number.isFinite(length)) total += length;
	}
	return total;
}

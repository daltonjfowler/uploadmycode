/**
 * Talking to POST /api/compile.
 *
 * The Worker passes the compile container's JSON straight through, so there are
 * exactly three shapes to expect and we branch on which key is present:
 *
 *   { ok: true,  hex }     compiled
 *   { ok: false, stderr }  the sketch is wrong (still HTTP 200)
 *   { ok: false, error }   the service is wrong: busy, cold, or down (HTTP 503)
 *
 * Everything else — a dropped connection, an HTML error page, a shape we do not
 * recognise — becomes one "service" outcome with a sentence a student can read.
 */

export type CompileOutcome =
	| { kind: "success"; hex: string }
	| { kind: "compile-error"; stderr: string }
	| { kind: "busy"; message: string }
	| { kind: "service-error"; message: string };

/** Same path in dev (Vite proxies it to the local server) and in production. */
const COMPILE_URL = "/api/compile";

export async function requestCompile(code: string): Promise<CompileOutcome> {
	let response: Response;
	try {
		response = await fetch(COMPILE_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
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
	// error means the compiler never ran. 503 is the "over capacity" case.
	if (typeof reply.error === "string") {
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

/**
 * Talking to POST /api/format — the Auto indent button.
 *
 * The same shape as compile.ts, because it is the same Worker, the same gate
 * and the same container; only the job at the far end differs. Two replies to
 * expect:
 *
 *   { ok: true,  code }   the sketch, tidied
 *   { ok: false, error }  nothing was tidied, and `error` says why
 *
 * There is no equivalent of a compile error here. clang-format will indent code
 * that does not compile — that is rather the point, since badly indented code is
 * exactly where a missing brace hides — so a sketch full of mistakes still comes
 * back tidied. `error` means the tool did not run or could not finish, and in
 * that case the page leaves the student's text alone.
 *
 * The two headers are the ones compile.ts sends and mean the same things: the
 * class phrase, shown back word for word on a 403, and this browser's client id,
 * which is how the Worker gives every Chromebook its own twelve tidies a minute
 * out of a budget separate from its compiles.
 */

import { loadClientId } from "./storage.ts";

export type FormatOutcome =
	| { kind: "formatted"; code: string }
	/** HTTP 403. The page must ask for the phrase again. */
	| { kind: "phrase-required"; message: string }
	/** HTTP 503: the container is asleep or over capacity. */
	| { kind: "busy"; message: string }
	/** Everything else, including 413 and 429. `message` is the server's own. */
	| { kind: "service-error"; message: string };

/** Same path in dev (Vite proxies it to the local server) and in production. */
const FORMAT_URL = "/api/format";

export async function requestFormat(code: string, phrase: string): Promise<FormatOutcome> {
	let response: Response;
	try {
		response = await fetch(FORMAT_URL, {
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
			message: "Could not reach the server. Check the Wi-Fi and try again.",
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			kind: "service-error",
			message: `The server sent a reply the page could not read (HTTP ${response.status}).`,
		};
	}

	const reply = body as { ok?: unknown; code?: unknown; error?: unknown };

	if (reply.ok === true && typeof reply.code === "string") {
		return { kind: "formatted", code: reply.code };
	}
	// The server's sentence is always shown as it was written: 403 phrase,
	// 413 too big, 429 too much tidying, 503 over capacity.
	if (typeof reply.error === "string") {
		if (response.status === 403) return { kind: "phrase-required", message: reply.error };
		return response.status === 503
			? { kind: "busy", message: reply.error }
			: { kind: "service-error", message: reply.error };
	}

	return {
		kind: "service-error",
		message: `Unexpected reply from the server (HTTP ${response.status}).`,
	};
}

export interface FormatEdit {
	/** What to put in the editor, or null when the tidy changed nothing. */
	code: string | null;
	/** The 1-based line to leave the caret on. Always a line that exists. */
	caretLine: number;
}

/**
 * Decide what the page should do with a formatted sketch: whether it is worth
 * applying at all, and where the caret should end up.
 *
 * Keeping the caret on the same **line number** is the promise, not the same
 * character: indenting moves every column on the line, so a column is not a
 * thing that survives the edit, while "the line I was reading" is exactly what
 * a student is holding in their head when they press the button. That line can
 * disappear, though — a tidy that collapses four blank lines into one leaves
 * fewer lines than it started with — so the number is clamped to the text that
 * actually came back.
 *
 * Pure, and separate from the fetch above, so `web/test/format.test.mjs` can
 * walk the awkward cases without a server or a DOM.
 */
export function formatEdit(before: string, after: string, caretLine: number): FormatEdit {
	const text = after === before ? before : after;
	const wanted = Number.isFinite(caretLine) ? Math.trunc(caretLine) : 1;
	return {
		code: after === before ? null : after,
		caretLine: Math.min(Math.max(wanted, 1), countLines(text)),
	};
}

/**
 * Lines in a string, counted the way CodeMirror counts them: a trailing
 * newline makes an empty last line, and the empty string is one line.
 */
function countLines(text: string): number {
	let lines = 1;
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
	return lines;
}

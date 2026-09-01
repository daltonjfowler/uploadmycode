/**
 * Turn arduino-cli's stderr into something a student can act on.
 *
 * The compile server strips its temp directory out of the output, so a failed
 * compile comes back looking like real compiler output about one file:
 *
 *   sketch.ino: In function 'void loop()':
 *   sketch.ino:10:3: error: expected ';' before 'delay'
 *      10 |   digitalWrite(LED_BUILTIN, HIGH)
 *         |   ^
 *
 * We pull out every line that names a line number and hand those back. Anything
 * else stays in the raw text, which the error panel prints underneath.
 */

/** One diagnostic, already converted to what the editor and panel need. */
export interface CompileError {
	/** 1-based line in the sketch, exactly as the compiler counts. */
	line: number;
	/** 1-based column, or 0 when the compiler did not give one. */
	column: number;
	/** "error", "warning", "note", or "fatal error". */
	severity: string;
	/** The message after the severity, with no file or position in front. */
	message: string;
}

/**
 * Matches a gcc-style position line for our one sketch file.
 *
 * - An optional directory in front, in case a path survives stripping.
 * - The column is optional: gcc omits it for some diagnostics.
 * - Severity is captured so the panel can grey out warnings and notes.
 */
const POSITION_LINE =
	/^\s*(?:[^\s:]*[/\\])?sketch\.ino:(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*)$/;

/**
 * Parse compiler output into diagnostics, in the order they were reported.
 *
 * Split on \r?\n: the container emits \n and the Windows dev server emits \r\n.
 */
export function parseCompileErrors(stderr: string): CompileError[] {
	const found: CompileError[] = [];

	for (const raw of stderr.split(/\r?\n/)) {
		const match = POSITION_LINE.exec(raw);
		if (!match) continue;

		const line = Number(match[1]);
		// Line 0 means the compiler is talking about the file as a whole; there is
		// nothing in the editor to point at, so leave it to the raw text.
		if (!Number.isFinite(line) || line < 1) continue;

		found.push({
			line,
			column: match[2] ? Number(match[2]) : 0,
			severity: match[3],
			message: match[4].trim(),
		});
	}

	return found;
}

/**
 * The lines the editor should highlight: every real error, or — if the compiler
 * only reported warnings and notes — those, so the marker is never empty when
 * something was said about a line.
 */
export function errorLines(errors: CompileError[]): number[] {
	const hard = errors.filter((e) => e.severity !== "note" && e.severity !== "warning");
	const chosen = hard.length > 0 ? hard : errors;
	return [...new Set(chosen.map((e) => e.line))];
}

/**
 * One-line summary for the status bar: the first real error, or a fallback.
 */
export function firstErrorSummary(errors: CompileError[]): string | null {
	const first = errors.find((e) => e.severity !== "note" && e.severity !== "warning") ?? errors[0];
	if (!first) return null;
	return `Line ${first.line}: ${first.message}`;
}

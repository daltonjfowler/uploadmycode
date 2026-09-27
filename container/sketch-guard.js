/**
 * What a sketch may not ask the compiler to read.
 *
 * Each container keeps its build directories between compiles (see BUILD_ROOT
 * in server.js), and until this existed the last student's sketch sat in them
 * after their compile had finished. A sketch that said
 * `#include "/opt/arduino/build/general/sketch/sketch.ino"`, or used the
 * assembler's `.incbin`, could pull that file into its own compile and read it
 * back out of the error messages or the hex. server.js now deletes every sketch
 * file the moment each compile finishes, and that is the real fix: there is
 * nothing of anybody else's left to read. This file is the second layer. It
 * refuses, with a sentence a student can act on, the ways of naming a file
 * outside the sketch that no classroom sketch ever needs:
 *
 *   #include "/an/absolute/path"   also <...>, and a Windows C:\ path
 *   #include "../anything"          any ".." at all
 *   #include SOME_MACRO             a computed include, whose file cannot be
 *                                   known without running the preprocessor
 *   .incbin / .include             assembler directives that read a file
 *
 * It reads the sketch the way the preprocessor does where that matters:
 * backslash-newlines joined, comments removed (and only comments: strings and
 * raw strings are skipped over whole, so a "/*" inside one hides nothing), and
 * "%:" accepted as "#". It is not a C++ parser and does not try to be; anything
 * it misses still finds the build directory empty.
 *
 * Its own module, with no imports, so test/sketch-guard.test.mjs can load it
 * without starting the server.
 */

/** A preprocessor directive that pulls in a file, and whatever follows it. */
const INCLUDE_DIRECTIVE = /^[ \t\f\v]*(?:#|%:)[ \t\f\v]*(?:include_next|include|import)\b(.*)$/;
/** gas directives that read a file into the output. */
const FILE_READING_ASM = /\.(?:incbin|include)\b/i;
/** Absolute on Linux or Windows: "/x", "\x", "C:x". */
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:)/;

const PATH_MESSAGE =
	"#include can only name a library, like <Servo.h>, or a file next to your sketch. " +
	"A path that starts with / or uses .. is not allowed.";
const COMPUTED_MESSAGE =
	"#include has to name its file in quotes or <angle brackets>, like #include <Servo.h>.";
const ASM_MESSAGE = ".incbin and .include are not allowed: they read files from the compile server.";

/**
 * The first thing in `code` this refuses, as a compiler-style error line the
 * editor already knows how to point at, or null when there is nothing.
 * @param {string} code
 * @returns {string | null}
 */
export function sketchProblem(code) {
	// Any line ending, as the compiler accepts: a Windows "\r" left on the end of
	// a line would otherwise stop the directive pattern from matching it.
	const lines = stripComments(spliceLines(code)).split(/\r\n|\r|\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const directive = INCLUDE_DIRECTIVE.exec(line);
		if (directive !== null) {
			const target = directive[1].trim();
			const quoted = /^(?:"([^"]*)"|<([^>]*)>)/.exec(target);
			if (quoted === null) return problemAt(index, COMPUTED_MESSAGE);
			const name = (quoted[1] ?? quoted[2]).trim();
			if (ABSOLUTE_PATH.test(name) || name.includes("..")) return problemAt(index, PATH_MESSAGE);
		}
		if (FILE_READING_ASM.test(line)) return problemAt(index, ASM_MESSAGE);
	}
	return null;
}

/**
 * gcc's own shape, "sketch.ino:<line>:<col>: error: <message>", so the editor
 * marks the line exactly as it would for a real compile error.
 * @param {number} index 0-based line
 * @param {string} message
 */
function problemAt(index, message) {
	return `sketch.ino:${index + 1}:1: error: ${message}`;
}

/**
 * Join every backslash-newline, the way the compiler does before it looks for
 * anything else, so `#inc\` + newline + `lude` is seen as `#include`.
 *
 * The removed newlines are put back after the joined line ends, so every line
 * after it keeps its real number and the joined one reports where it started.
 * @param {string} code
 */
function spliceLines(code) {
	let out = "";
	let owed = 0;
	for (let i = 0; i < code.length; i += 1) {
		const ch = code[i];
		if (ch === "\\" && (code[i + 1] === "\n" || (code[i + 1] === "\r" && code[i + 2] === "\n"))) {
			i += code[i + 1] === "\r" ? 2 : 1;
			owed += 1;
			continue;
		}
		out += ch;
		if (ch === "\n" && owed > 0) {
			out += "\n".repeat(owed);
			owed = 0;
		}
	}
	return out;
}

/**
 * Replace every comment with a space (keeping its newlines, so line numbers
 * hold), stepping over string, character and raw-string literals whole.
 *
 * Comments are removed because the compiler removes them before it reads a
 * directive: a "#", then an empty comment, then `include "/x"` is a real
 * include. Literals are stepped
 * over because a "/*" inside one does not start a comment, and treating it as
 * one would hide the lines after it from the check.
 * @param {string} text
 */
function stripComments(text) {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];

		if (ch === "/" && next === "/") {
			const end = text.indexOf("\n", i);
			out += " ";
			if (end === -1) break;
			i = end;
			continue;
		}
		if (ch === "/" && next === "*") {
			const close = text.indexOf("*/", i + 2);
			const end = close === -1 ? text.length : close + 2;
			out += " " + "\n".repeat(countNewlines(text.slice(i, end)));
			i = end;
			continue;
		}

		const raw = rawStringLength(text, i);
		if (raw > 0) {
			out += text.slice(i, i + raw);
			i += raw;
			continue;
		}

		if (ch === '"' || ch === "'") {
			// An ordinary literal ends at its closing quote or, unclosed, at the end
			// of the line, which is where the compiler gives up on it too.
			let j = i + 1;
			while (j < text.length && text[j] !== ch && text[j] !== "\n") {
				j += text[j] === "\\" ? 2 : 1;
			}
			const end = j < text.length && text[j] === ch ? j + 1 : j;
			out += text.slice(i, end);
			i = end;
			continue;
		}

		out += ch;
		i += 1;
	}
	return out;
}

/**
 * How long the raw string literal starting at `i` is, or 0 if none starts
 * there. `R"delim( ... )delim"`, with an optional u8, u, U or L in front.
 *
 * Only an R that begins a token counts. `fooR"x"` is the name fooR followed by
 * an ordinary string, and reading it as a raw string would skip lines the
 * compiler actually sees.
 * @param {string} text
 * @param {number} i
 */
function rawStringLength(text, i) {
	if (text[i] !== "R" || text[i + 1] !== '"') return 0;

	let start = i;
	while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start -= 1;
	const prefix = text.slice(start, i);
	if (prefix !== "" && prefix !== "u8" && prefix !== "u" && prefix !== "U" && prefix !== "L") return 0;

	const opening = /^R"([^\s()\\]{0,16})\(/.exec(text.slice(i, i + 20));
	if (opening === null) return 0;

	const closer = ")" + opening[1] + '"';
	const close = text.indexOf(closer, i + opening[0].length);
	return close === -1 ? text.length - i : close + closer.length - i;
}

/** @param {string} text */
function countNewlines(text) {
	let count = 0;
	for (const ch of text) if (ch === "\n") count += 1;
	return count;
}

/**
 * The libraries the Library dropdown offers, and the one function that puts an
 * `#include` into a sketch.
 *
 * THIS LIST MUST STAY IN SYNC WITH `container/Dockerfile`. The first four are
 * its `arduino-cli lib install` lines, one entry each; the last four ship inside
 * the AVR core (`arduino:avr`) itself and so have no install line. Adding a
 * library is two edits and nothing else: an install line in the Dockerfile with
 * an exact version, and an entry here.
 *
 * Nothing here checks anything. A header the image does not have still fails,
 * on the server, with avr-gcc's own "No such file or directory" — this list is a
 * shortcut for the eight that are known to work, not a permission check.
 */

export interface Library {
	/** What the dropdown calls it, and what the Arduino docs call it. */
	label: string;
	/** The header file, exactly as it is written between the angle brackets. */
	header: string;
	/** Half a line saying what it is for, shown after the label. */
	note: string;
}

export const LIBRARIES: readonly Library[] = [
	// Installed by container/Dockerfile, in the order its install lines run.
	{ label: "Servo", header: "Servo.h", note: "hobby servos" },
	{ label: "LiquidCrystal", header: "LiquidCrystal.h", note: "pin-wired character LCDs" },
	{ label: "LiquidCrystal I2C", header: "LiquidCrystal_I2C.h", note: "I2C backpack LCDs" },
	{ label: "Stepper", header: "Stepper.h", note: "stepper motors" },
	// Bundled with the AVR core — installed by `core install`, not by a lib line.
	{ label: "Wire", header: "Wire.h", note: "I2C bus" },
	{ label: "SPI", header: "SPI.h", note: "SPI bus" },
	{ label: "SoftwareSerial", header: "SoftwareSerial.h", note: "extra serial port on any pins" },
	{ label: "EEPROM", header: "EEPROM.h", note: "save small values across resets" },
];

/** Where a new include goes: after the last line that is already one. */
const ANY_INCLUDE = /^\s*#\s*include\s*[<"]/;

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The 1-based line an `#include` of this header is already on, or 0 for none.
 *
 * The matcher is line-anchored and deliberately dumb: the line has to *start*
 * with the directive, leading whitespace aside. So `#include <Servo.h>`,
 * `#include<Servo.h>` and `#include "Servo.h"` all count as present, while
 * `// #include <Servo.h>` and `Serial.println("#include <Servo.h>")` count as
 * absent — which is right, because neither of those includes anything. Text
 * after the closing bracket is ignored, so a trailing comment on the directive
 * still counts as present.
 *
 * The one case it reads wrongly is an include sitting inside a block comment: it
 * does start its own line, so this calls it present. Telling that apart means
 * parsing C, and the cost of being wrong is one dropdown pick that does nothing.
 */
export function findIncludeLine(code: string, header: string): number {
	const wanted = new RegExp(`^\\s*#\\s*include\\s*[<"]${escapeForRegExp(header)}[>"]`);
	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (wanted.test(lines[i])) return i + 1;
	}
	return 0;
}

export interface InsertedInclude {
	/** The whole sketch again, with the include in it. */
	code: string;
	/** 1-based line the include was put on. */
	line: number;
}

/**
 * Add `#include <header>` to a sketch, or say it is already there.
 *
 * Returns null when the header is included already — the caller shows a message
 * rather than adding a second copy. Otherwise the include lands after the last
 * existing include, which keeps the block at the top together, or at the very
 * top when the sketch has none.
 */
export function insertInclude(code: string, header: string): InsertedInclude | null {
	if (findIncludeLine(code, header) > 0) return null;

	const directive = `#include <${header}>`;
	const lines = code.split("\n");

	let lastInclude = -1;
	for (let i = 0; i < lines.length; i++) {
		if (ANY_INCLUDE.test(lines[i])) lastInclude = i;
	}

	if (lastInclude >= 0) {
		lines.splice(lastInclude + 1, 0, directive);
		return { code: lines.join("\n"), line: lastInclude + 2 };
	}

	// Nothing to follow, so it goes first, with a blank line to keep it off the
	// front of `void setup()`. An empty sketch has nothing to be kept off.
	if (code === "") return { code: directive, line: 1 };
	return { code: `${directive}\n\n${code}`, line: 1 };
}

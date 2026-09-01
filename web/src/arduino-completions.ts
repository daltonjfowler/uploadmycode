/**
 * The autocomplete list.
 *
 * Deliberately a short, curated set: the calls, constants and types a first-year
 * class actually uses, plus a few block snippets. It is NOT a dump of the
 * Arduino API — a beginner scrolling past forty unknown names learns nothing.
 * Add to it when a class needs something, and keep the detail text short.
 *
 * Functions that take arguments are snippets, so accepting one drops the
 * parentheses in and puts the cursor on the first argument (Tab moves on).
 */

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";

/** A call with arguments: snippet template plus the signature shown beside it. */
function call(label: string, template: string, detail: string, info: string): Completion {
	return snippetCompletion(template, { label, detail, info, type: "function" });
}

/** A name with nothing to fill in. */
function name(label: string, type: string, detail: string, info?: string): Completion {
	return { label, type, detail, info };
}

const FUNCTIONS: Completion[] = [
	call(
		"pinMode",
		"pinMode(${pin}, ${OUTPUT})",
		"(pin, mode)",
		"Set a pin to INPUT, OUTPUT or INPUT_PULLUP. Usually called in setup().",
	),
	call(
		"digitalWrite",
		"digitalWrite(${pin}, ${HIGH})",
		"(pin, value)",
		"Turn a digital pin on (HIGH) or off (LOW).",
	),
	call("digitalRead", "digitalRead(${pin})", "(pin)", "Read a digital pin. Gives HIGH or LOW."),
	call("analogRead", "analogRead(${A0})", "(pin)", "Read an analog pin A0-A5. Gives 0 to 1023."),
	call(
		"analogWrite",
		"analogWrite(${pin}, ${value})",
		"(pin, value)",
		"PWM output on pins 3, 5, 6, 9, 10, 11. Value is 0 to 255.",
	),
	call("delay", "delay(${1000})", "(milliseconds)", "Wait. 1000 milliseconds is one second."),
	call(
		"delayMicroseconds",
		"delayMicroseconds(${100})",
		"(microseconds)",
		"Wait a very short time. 1000 microseconds is one millisecond.",
	),
	name("millis", "function", "()", "Milliseconds since the board started running."),
	name("micros", "function", "()", "Microseconds since the board started running."),
	call(
		"map",
		"map(${value}, ${fromLow}, ${fromHigh}, ${toLow}, ${toHigh})",
		"(value, fromLow, fromHigh, toLow, toHigh)",
		"Rescale a number from one range to another.",
	),
	call(
		"constrain",
		"constrain(${value}, ${low}, ${high})",
		"(value, low, high)",
		"Clamp a number so it stays between low and high.",
	),
	call("random", "random(${min}, ${max})", "(min, max)", "A random number from min up to max - 1."),
	call(
		"randomSeed",
		"randomSeed(${analogRead(A0)})",
		"(seed)",
		"Start random() somewhere different each run.",
	),
	call(
		"tone",
		"tone(${pin}, ${frequency})",
		"(pin, frequency)",
		"Play a square wave on a pin, for a buzzer or speaker.",
	),
	call("noTone", "noTone(${pin})", "(pin)", "Stop the tone on a pin."),
	call(
		"Serial.begin",
		"Serial.begin(${9600})",
		"(speed)",
		"Start the Serial Monitor. Put this in setup(). Match the speed in the monitor.",
	),
	call("Serial.print", "Serial.print(${value})", "(value)", "Send text with no line break."),
	call(
		"Serial.println",
		"Serial.println(${value})",
		"(value)",
		"Send text and start a new line.",
	),
	name("Serial.available", "function", "()", "How many bytes have arrived and not been read."),
	name("Serial.read", "function", "()", "Read one byte that arrived, or -1 if there is none."),
];

const CONSTANTS: Completion[] = [
	name("HIGH", "constant", "5V / on"),
	name("LOW", "constant", "0V / off"),
	name("INPUT", "constant", "pinMode: read the pin"),
	name("OUTPUT", "constant", "pinMode: drive the pin"),
	name("INPUT_PULLUP", "constant", "pinMode: read, with the internal pull-up resistor"),
	name("LED_BUILTIN", "constant", "the LED on the board (pin 13 on an Uno)"),
	name("A0", "constant", "analog pin 0"),
	name("A1", "constant", "analog pin 1"),
	name("A2", "constant", "analog pin 2"),
	name("A3", "constant", "analog pin 3"),
	name("A4", "constant", "analog pin 4"),
	name("A5", "constant", "analog pin 5"),
	name("true", "constant", "1"),
	name("false", "constant", "0"),
];

const TYPES: Completion[] = [
	name("int", "type", "whole number, -32768 to 32767"),
	name("long", "type", "big whole number"),
	name("float", "type", "number with a decimal point"),
	name("bool", "type", "true or false"),
	name("char", "type", "one character"),
	name("byte", "type", "0 to 255"),
	name("unsigned", "type", "no negative values"),
	name("void", "type", "returns nothing"),
	name("const", "keyword", "never changes"),
	name("String", "type", "text"),
];

const SNIPPETS: Completion[] = [
	snippetCompletion("void setup() {\n\t${}\n}", {
		label: "setup",
		detail: "runs once",
		type: "keyword",
	}),
	snippetCompletion("void loop() {\n\t${}\n}", {
		label: "loop",
		detail: "runs forever",
		type: "keyword",
	}),
	snippetCompletion("for (int i = 0; i < ${count}; i++) {\n\t${}\n}", {
		label: "for",
		detail: "repeat a set number of times",
		type: "keyword",
	}),
	snippetCompletion("if (${condition}) {\n\t${}\n}", {
		label: "if",
		detail: "do it only when true",
		type: "keyword",
	}),
	snippetCompletion("if (${condition}) {\n\t${}\n} else {\n\t\n}", {
		label: "ifelse",
		detail: "if / else",
		type: "keyword",
	}),
	snippetCompletion("while (${condition}) {\n\t${}\n}", {
		label: "while",
		detail: "repeat while true",
		type: "keyword",
	}),
];

const ALL: Completion[] = [...SNIPPETS, ...FUNCTIONS, ...CONSTANTS, ...TYPES];

/**
 * The one completion source the editor uses. It replaces CodeMirror's default
 * sources rather than adding to them, so the list is exactly what is above.
 *
 * The dot is part of a word here so that typing "Serial.pr" can offer
 * "Serial.println" and replace the whole thing.
 */
export function arduinoCompletions(context: CompletionContext): CompletionResult | null {
	const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/);
	if (!word) return null;
	// Nothing typed yet: only offer the list if the student asked (Ctrl-Space).
	if (word.from === word.to && !context.explicit) return null;

	return {
		from: word.from,
		options: ALL,
		validFor: /^[A-Za-z0-9_.]*$/,
	};
}

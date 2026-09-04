/**
 * One friendly line under a compiler error, so a missing semicolon does not
 * cost a raised hand.
 *
 * This is a lookup table and nothing else: no AI, no network, no guessing. A
 * message either matches one of the shapes below — all of them seen coming out
 * of the real avr-gcc during earlier gates — or it gets no hint at all. Silence
 * is the safe answer; a confident wrong hint sends a student down a hole.
 *
 * The input is the `message` field of a parsed diagnostic (see errors.ts), so
 * the file, line, column and severity are already stripped off:
 *
 *   sketch.ino:34:3: error: expected ';' before 'delay'
 *                           ^--------------------------- what arrives here
 *
 * Rules are tried in order and the first one that answers wins, so the narrow
 * ones (a wrong-case `serial`, a stray '#') sit above the wide ones (any
 * unknown name, any stray character). Keep every hint one sentence, under about
 * 90 characters, in words a beginner already owns.
 */

/** One entry in the table: a name for it, and what it says about a message. */
export interface HintRule {
	/** Stable id. The tests pin the order down by these, so do not rename lightly. */
	id: string;
	/** The hint for this message, or null when this rule has nothing to say. */
	match(message: string): string | null;
}

/**
 * Names from the first few lessons, spelled the way the compiler insists on.
 * Only used to answer "you wrote it in the wrong case" — a name that is merely
 * misspelled falls through to the general hint.
 */
const KNOWN_NAMES = [
	"Serial",
	"HIGH",
	"LOW",
	"INPUT",
	"OUTPUT",
	"LED_BUILTIN",
	"pinMode",
	"digitalWrite",
	"digitalRead",
	"analogRead",
	"analogWrite",
	"delay",
] as const;

/**
 * gcc quotes the name it could not find. It sometimes adds "; did you mean
 * 'Serial'?" after this, which is why the pattern is not anchored at the end.
 */
const NOT_DECLARED = /^'([A-Za-z_]\w*)' was not declared in this scope/;

/** Which closing bracket gcc wanted, when it wanted one. */
const EXPECTED_CLOSER = /^expected '([)\]}])'/;

/** The three matching-pair hints, one per closing bracket. */
const PAIR_HINTS: Record<string, string> = {
	")": "Every ( needs a matching ). Count the brackets on this line.",
	"}": "Every { needs a matching }. One of your blocks is never closed.",
	"]": "Every [ needs a matching ]. Check the square brackets here.",
};

/** Said by two different diagnostics, so it is written once. */
const EQUALS_HINT = "= sets a value; == compares. You may want ==.";

/** The same name in a different case, or null when there is no such name. */
function properSpelling(name: string): string | null {
	const lower = name.toLowerCase();
	const known = KNOWN_NAMES.find((candidate) => candidate.toLowerCase() === lower);
	return known !== undefined && known !== name ? known : null;
}

/** The common shape: if the pattern matches, always this one hint. */
function rule(id: string, pattern: RegExp, hint: string): HintRule {
	return { id, match: (message) => (pattern.test(message) ? hint : null) };
}

/**
 * The table, in the order it is tried. First match wins.
 */
export const HINT_RULES: readonly HintRule[] = [
	// Narrower than the next rule and must stay above it: when the unknown name
	// is a known one in the wrong case, say the right spelling outright.
	{
		id: "wrong-case-name",
		match(message) {
			const found = NOT_DECLARED.exec(message);
			if (!found) return null;
			const typed = found[1]!;
			const proper = properSpelling(typed);
			return proper === null ? null : `Capital letters matter: write ${proper}, not ${typed}.`;
		},
	},
	rule(
		"not-declared",
		NOT_DECLARED,
		"The name is unknown here. Check spelling and capital letters (code cares about case).",
	),

	rule("missing-semicolon", /^expected ';'/, "Every statement ends with a semicolon. Check the line above."),
	rule("extra-closing-brace", /^expected declaration before '\}'/, "There is one closing brace too many."),
	{
		id: "unclosed-pair",
		match(message) {
			const found = EXPECTED_CLOSER.exec(message);
			return found ? (PAIR_HINTS[found[1]!] ?? null) : null;
		},
	},
	rule(
		"expected-unqualified-id",
		/^expected unqualified-id/,
		"Something extra is here. Look for a spare brace, semicolon or keyword.",
	),

	rule(
		"unknown-type",
		/does not name a type/,
		"This type is unknown. Check the spelling, or add its library from the Library menu.",
	),
	// The header name is quoted in the message; the hint does not repeat it,
	// because the message is right above the hint on screen.
	rule(
		"missing-library",
		/[\w.+-]+\.h: No such file or directory/,
		"That library is not installed here. Pick it from the Library menu, or check the spelling.",
	),

	rule(
		"redefinition",
		/^redefinition of /,
		"This name is made twice in the sketch. Delete one of the two copies.",
	),
	rule(
		"no-matching-function",
		/^no matching function for call to/,
		"Check inside the parentheses. The number or kind of things does not fit.",
	),
	rule(
		"too-many-arguments",
		/^too many arguments to function/,
		"There are too many things inside the parentheses. Take one out.",
	),
	rule(
		"too-few-arguments",
		/^too few arguments to function/,
		"Something is missing inside the parentheses. Add what it needs.",
	),
	// The linker quotes with a backtick and closes with an apostrophe. This one
	// is reported against main.cpp rather than sketch.ino, so it rarely reaches
	// the panel, but the sentence is the right one whenever it does.
	rule(
		"missing-setup-or-loop",
		/undefined reference to ['`](setup|loop)'/,
		"Your sketch needs both void setup() { } and void loop() { }.",
	),

	rule("assignment-not-comparison", /^lvalue required as left operand of assignment/, EQUALS_HINT),
	rule("assignment-in-condition", /suggest parentheses around assignment used as truth value/, EQUALS_HINT),

	rule("unterminated-comment", /^unterminated comment/, "A comment opened with /* needs a */ to close it."),

	// Must stay above the general stray rule below.
	rule("stray-hash", /^stray '#' in program/, "A # belongs only on an #include line at the top."),
	rule(
		"stray-character",
		/^stray '.+' in program/,
		"There is a character here the compiler cannot read. Delete it and retype.",
	),
];

/** The rule that answers for this message, and what it said. */
export function matchHint(message: string): { id: string; hint: string } | null {
	const text = message.trim();
	if (text === "") return null;

	for (const entry of HINT_RULES) {
		const hint = entry.match(text);
		if (hint !== null) return { id: entry.id, hint };
	}
	return null;
}

/** The friendly line for a compiler message, or null when nothing fits. */
export function hintFor(message: string): string | null {
	return matchHint(message)?.hint ?? null;
}

/**
 * The CodeMirror 6 editor.
 *
 * The extension list below is the `codemirror` package's `basicSetup`, written
 * out by hand as that package's own docs suggest, with two changes:
 *
 *   - autocompletion lives in a Compartment so the Autocomplete toggle can add
 *     and remove it outright. There is no popup at all when it is off.
 *   - linting is left out. Compiler errors arrive from the server and are shown
 *     as a line highlight plus the output panel, so nothing lints in the page.
 *
 * All colours are CSS custom properties defined in style.css, which is where
 * light and dark are chosen from prefers-color-scheme. Nothing here reads the
 * colour scheme, and nothing has to be re-created when the system theme flips.
 */

import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import {
	HighlightStyle,
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	crosshairCursor,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import { arduinoCompletions } from "./arduino-completions.ts";

// ------------------------------------------------------------------ appearance

const syntaxColors = HighlightStyle.define([
	{ tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--tok-comment)" },
	{
		tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.modifier, tags.operatorKeyword, tags.self],
		color: "var(--tok-keyword)",
	},
	{ tag: [tags.typeName, tags.standard(tags.typeName), tags.className], color: "var(--tok-type)" },
	{ tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom], color: "var(--tok-number)" },
	{
		tag: [tags.string, tags.character, tags.special(tags.string), tags.escape],
		color: "var(--tok-string)",
	},
	{
		tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
		color: "var(--tok-function)",
	},
	{ tag: [tags.meta, tags.processingInstruction], color: "var(--tok-preproc)" },
	{
		tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)],
		color: "var(--tok-constant)",
	},
	{ tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: "var(--tok-punct)" },
	{ tag: tags.invalid, color: "var(--danger)" },
]);

const editorTheme = EditorView.theme({
	"&": {
		height: "100%",
		color: "var(--fg)",
		backgroundColor: "var(--editor-bg)",
	},
	".cm-scroller": {
		fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, "Roboto Mono", monospace',
		fontSize: "14px",
		lineHeight: "1.55",
	},
	".cm-content": { caretColor: "var(--fg)", paddingBottom: "40vh" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "var(--selection)",
	},
	".cm-gutters": {
		backgroundColor: "var(--gutter-bg)",
		color: "var(--muted)",
		border: "none",
		borderRight: "1px solid var(--border)",
	},
	".cm-activeLine": { backgroundColor: "var(--active-line)" },
	".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--fg)" },
	// Both this and .cm-activeLine are line decorations; the extra class keeps
	// the error highlight winning on the line the caret happens to be on.
	".cm-line.cm-errorLine": {
		backgroundColor: "var(--error-line)",
		boxShadow: "inset 3px 0 0 var(--danger)",
	},
	".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
		backgroundColor: "var(--bracket)",
		outline: "1px solid var(--border)",
	},
	".cm-selectionMatch": { backgroundColor: "var(--bracket)" },
	".cm-tooltip": {
		backgroundColor: "var(--panel)",
		color: "var(--fg)",
		border: "1px solid var(--border)",
		borderRadius: "4px",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul": {
		fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
		maxHeight: "14rem",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
		backgroundColor: "var(--accent)",
		color: "var(--accent-fg)",
	},
	".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal" },
	".cm-completionInfo": {
		backgroundColor: "var(--panel)",
		border: "1px solid var(--border)",
		maxWidth: "22rem",
	},
	".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
	".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
	".cm-searchMatch": { backgroundColor: "var(--bracket)" },
	".cm-searchMatch.cm-searchMatch-selected": {
		backgroundColor: "var(--accent)",
		color: "var(--accent-fg)",
	},
	".cm-foldPlaceholder": {
		backgroundColor: "var(--panel)",
		border: "1px solid var(--border)",
		color: "var(--muted)",
	},
});

// -------------------------------------------------------------- error markers

/** Replace the highlighted lines. An empty array clears them. */
const setErrorLines = StateEffect.define<readonly number[]>();

const errorLineMark = Decoration.line({ class: "cm-errorLine" });

function buildErrorDecorations(state: EditorState, lines: readonly number[]): DecorationSet {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	const marks = [];
	for (const line of sorted) {
		// The compiler can name a line past the end of the document if the sketch
		// was edited between compiling and reading the answer. Skip those.
		if (line < 1 || line > state.doc.lines) continue;
		marks.push(errorLineMark.range(state.doc.line(line).from));
	}
	return Decoration.set(marks);
}

const errorLineField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, tr) {
		// Follow edits, so fixing line 20 does not move the marker off line 10.
		let next = decorations.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setErrorLines)) next = buildErrorDecorations(tr.state, effect.value);
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

// ------------------------------------------------------------------- the editor

/** Swapped when the Autocomplete toggle changes. */
const autocompleteConf = new Compartment();
/** Reconfigured when a different sketch is loaded, which throws away its undo history. */
const historyConf = new Compartment();

function autocompleteExtension(enabled: boolean) {
	if (!enabled) return [];
	return [
		autocompletion({
			// Only our curated list; no keyword dump from the C++ grammar.
			override: [arduinoCompletions],
			activateOnTyping: true,
			closeOnBlur: true,
		}),
		keymap.of(completionKeymap),
	];
}

export interface Editor {
	/** The current sketch source. */
	getCode(): string;
	/** Replace the whole document, clear markers, and forget the undo history. */
	setCode(code: string): void;
	/** Highlight these 1-based lines and scroll the first one into view. */
	showErrorLines(lines: readonly number[]): void;
	clearErrorLines(): void;
	/** Put the caret on a line and scroll to it. */
	goToLine(line: number, column: number): void;
	setAutocomplete(enabled: boolean): void;
	focus(): void;
}

export interface EditorOptions {
	parent: HTMLElement;
	doc: string;
	autocomplete: boolean;
	/** Called after every change to the document, including programmatic ones. */
	onChange: (code: string) => void;
}

export function createEditor(options: EditorOptions): Editor {
	const view = new EditorView({
		parent: options.parent,
		state: EditorState.create({
			doc: options.doc,
			extensions: [
				// --- basicSetup, minus autocompletion and lint ---
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				historyConf.of(history()),
				foldGutter(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...historyKeymap,
					...foldKeymap,
					// Tab indents. Press Escape first if you need to tab out of the
					// editor to the toolbar.
					indentWithTab,
				]),
				// --- ours ---
				cpp(),
				syntaxHighlighting(syntaxColors),
				editorTheme,
				EditorView.lineWrapping,
				errorLineField,
				autocompleteConf.of(autocompleteExtension(options.autocomplete)),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) options.onChange(update.state.doc.toString());
				}),
			],
		}),
	});

	function goToLine(line: number, column: number): void {
		const clamped = Math.min(Math.max(line, 1), view.state.doc.lines);
		const info = view.state.doc.line(clamped);
		const pos = column > 0 ? Math.min(info.from + column - 1, info.to) : info.from;
		view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
	}

	return {
		getCode: () => view.state.doc.toString(),

		goToLine,

		setCode(code) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: code },
				selection: { anchor: 0 },
				// A fresh history() replaces the old field, so a student cannot undo
				// their way from a new sketch back into the previous one.
				effects: [historyConf.reconfigure(history()), setErrorLines.of([])],
				scrollIntoView: true,
			});
		},

		showErrorLines(lines) {
			view.dispatch({ effects: setErrorLines.of([...lines]) });
			const first = [...lines].sort((a, b) => a - b)[0];
			if (first !== undefined) goToLine(first, 0);
		},

		clearErrorLines() {
			view.dispatch({ effects: setErrorLines.of([]) });
		},

		setAutocomplete(enabled) {
			view.dispatch({ effects: autocompleteConf.reconfigure(autocompleteExtension(enabled)) });
		},

		focus: () => view.focus(),
	};
}

/**
 * Find and replace: the panel the toolbar's Find & replace button opens, drawn
 * along the top of the editor.
 *
 * CodeMirror ships a search panel of its own, but it is written for
 * programmers: "regexp", "by word", and an "all" button that turns every match
 * into a cursor. This one keeps what a student renaming a variable needs (find,
 * previous and next, a count, replace, replace all) and drives it with
 * CodeMirror's own commands and query, so the searching is still the library's,
 * and so are Ctrl+F, F3 and Escape from its search keymap.
 *
 * Whole word and Match case both start ticked. With either off, renaming `i`
 * to `count` would also rewrite the i in `int` and `println`, and C++ treats
 * `led` and `LED` as two different names. A search that finds nothing says
 * "Not found", which is a far smaller problem than a quietly mangled sketch.
 *
 * Every query is literal: what the student types is what is searched for. The
 * library's default reads `\t` and `\n` as escapes, which would make
 * `Serial.print("\t")` unfindable in exactly the sketches that print it.
 */

import {
	SearchQuery,
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	search,
	setSearchQuery,
} from "@codemirror/search";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { Panel, ViewUpdate } from "@codemirror/view";

/** Counting stops here. A search with more matches than this reads "999+ matches". */
export const COUNT_LIMIT = 999;

export interface FindOptions {
	search: string;
	replace: string;
	wholeWord: boolean;
	caseSensitive: boolean;
}

/** The one place a query is built, so the panel and the tests agree on literal. */
export function makeQuery(options: FindOptions): SearchQuery {
	return new SearchQuery({ ...options, literal: true });
}

export interface MatchCount {
	/** Matches found, stopping at the limit. */
	total: number;
	/** 1-based place of the selected match among them, or 0 when none is selected. */
	current: number;
	/** True when there were more matches than the limit let us count. */
	capped: boolean;
}

/** Count the query's matches in the sketch. Null when there is nothing to search for. */
export function countMatches(
	state: EditorState,
	query: SearchQuery,
	limit: number = COUNT_LIMIT,
): MatchCount | null {
	if (!query.valid) return null;
	const { from, to } = state.selection.main;
	const cursor = query.getCursor(state);
	let total = 0;
	let current = 0;
	for (let next = cursor.next(); !next.done; next = cursor.next()) {
		if (total === limit) return { total, current, capped: true };
		total++;
		if (next.value.from === from && next.value.to === to) current = total;
	}
	return { total, current, capped: false };
}

/** What the panel says next to the Find box. */
export function matchLabel(count: MatchCount | null): string {
	if (!count) return "";
	if (count.total === 0) return "Not found";
	const total = count.capped ? `${count.total}+` : String(count.total);
	if (count.current > 0) return `${count.current} of ${total}`;
	return count.total === 1 ? "1 match" : `${total} matches`;
}

// ---------------------------------------------------------------------- panel

function make<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]>,
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

function checkbox(label: string, checked: boolean, onChange: () => void) {
	const input = make("input", { type: "checkbox", checked, onchange: onChange });
	return { input, label: make("label", { className: "check" }, input, label) };
}

class FindPanel implements Panel {
	readonly dom: HTMLElement;
	readonly top = true;

	private readonly view: EditorView;
	private query: SearchQuery;
	/** "Replaced 4." after Replace all, until the next edit or search. */
	private note = "";

	private readonly findField: HTMLInputElement;
	private readonly replaceField: HTMLInputElement;
	private readonly wholeWord: HTMLInputElement;
	private readonly matchCase: HTMLInputElement;
	private readonly count: HTMLSpanElement;

	// A plain field, not a `private readonly view` parameter: Node's type
	// stripping (which runs web/test/find.test.mjs) cannot rewrite those.
	constructor(view: EditorView) {
		this.view = view;
		this.query = getSearchQuery(view.state);
		const commit = () => this.commit();

		this.findField = make("input", {
			className: "cm-textfield",
			type: "text",
			value: this.query.search,
			placeholder: "Find",
			ariaLabel: "Find",
			autocomplete: "off",
			spellcheck: false,
			oninput: commit,
		});
		// openSearchPanel (Ctrl+F while the panel is already up) looks for this.
		this.findField.setAttribute("main-field", "true");

		this.replaceField = make("input", {
			className: "cm-textfield",
			type: "text",
			value: this.query.replace,
			placeholder: "Replace with",
			ariaLabel: "Replace with",
			autocomplete: "off",
			spellcheck: false,
			oninput: commit,
		});

		const whole = checkbox("Whole word", this.query.wholeWord, commit);
		const cased = checkbox("Match case", this.query.caseSensitive, commit);
		this.wholeWord = whole.input;
		this.matchCase = cased.input;

		this.count = make("span", { className: "cm-find-count" });

		const button = (text: string, title: string, run: () => void) =>
			make("button", { type: "button", title, onclick: run }, text);

		// The groups wrap inside the body; the close button stays outside it, so on
		// a narrow window it keeps its corner instead of wrapping onto a row alone.
		this.dom = make(
			"div",
			{ className: "cm-find", onkeydown: (event: KeyboardEvent) => this.keydown(event) },
			make(
				"div",
				{ className: "cm-find-body" },
				make(
					"div",
					{ className: "cm-find-group" },
					this.findField,
					button("Previous", "Previous match (Shift+Enter)", () => findPrevious(view)),
					button("Next", "Next match (Enter)", () => findNext(view)),
					this.count,
				),
				make(
					"div",
					{ className: "cm-find-group" },
					this.replaceField,
					button("Replace", "Replace the selected match, then go to the next one", () =>
						replaceNext(view),
					),
					button("Replace all", "Replace every match. Ctrl+Z undoes it.", () => this.replaceAll()),
				),
				make("div", { className: "cm-find-group" }, whole.label, cased.label),
			),
			make(
				"button",
				{
					type: "button",
					className: "cm-find-close",
					title: "Close (Esc)",
					ariaLabel: "Close find and replace",
					onclick: () => {
						closeSearchPanel(view);
						view.focus();
					},
				},
				"×",
			),
		);
		this.render();
	}

	mount(): void {
		this.findField.focus();
		this.findField.select();
	}

	update(update: ViewUpdate): void {
		let queryChanged = false;
		for (const tr of update.transactions) {
			for (const effect of tr.effects) {
				if (!effect.is(setSearchQuery)) continue;
				queryChanged = true;
				// Someone else set it: Ctrl+F with a word selected, most likely.
				if (!effect.value.eq(this.query)) this.show(effect.value);
			}
		}
		if (update.docChanged || queryChanged) this.note = "";
		if (update.docChanged || update.selectionSet || queryChanged) this.render();
	}

	private commit(): void {
		const query = makeQuery({
			search: this.findField.value,
			replace: this.replaceField.value,
			wholeWord: this.wholeWord.checked,
			caseSensitive: this.matchCase.checked,
		});
		if (query.eq(this.query)) return;
		this.query = query;
		this.view.dispatch({ effects: setSearchQuery.of(query) });
	}

	private show(query: SearchQuery): void {
		this.query = query;
		this.findField.value = query.search;
		this.replaceField.value = query.replace;
		this.wholeWord.checked = query.wholeWord;
		this.matchCase.checked = query.caseSensitive;
	}

	private replaceAll(): void {
		// Counted first: afterwards the matches are gone, and "Not found" would
		// read like the button failed.
		const found = countMatches(this.view.state, this.query, Number.POSITIVE_INFINITY);
		if (!found || found.total === 0) return;
		if (!replaceAll(this.view)) return;
		this.note = `Replaced ${found.total}.`;
		this.render();
	}

	private keydown(event: KeyboardEvent): void {
		// Escape, F3 and Ctrl+F, from @codemirror/search's own keymap.
		if (runScopeHandlers(this.view, event, "search-panel")) {
			event.preventDefault();
		} else if (event.key === "Enter" && event.target === this.findField) {
			event.preventDefault();
			(event.shiftKey ? findPrevious : findNext)(this.view);
		} else if (event.key === "Enter" && event.target === this.replaceField) {
			event.preventDefault();
			replaceNext(this.view);
		}
	}

	private render(): void {
		const count = countMatches(this.view.state, this.query);
		this.count.textContent = this.note || matchLabel(count);
		this.count.dataset.state = !this.note && count?.total === 0 ? "none" : "";
	}
}

/** The search state, the keymap's panel, and where a match scrolls to. */
export function findReplace(): Extension {
	return search({
		caseSensitive: true,
		wholeWord: true,
		literal: true,
		createPanel: (view) => new FindPanel(view),
		// Land a jumped-to match mid-screen, not on the very edge of the editor.
		scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
	});
}

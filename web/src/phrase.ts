/**
 * The class phrase, on the student's side.
 *
 * `sessionStorage`, never `localStorage`: the phrase dies when the tab closes,
 * so a Chromebook that goes back in the cart does not carry today's phrase into
 * tomorrow, or into the next student's session. It is typed once per tab.
 *
 * Nothing is validated here. The Worker normalizes and compares; the page just
 * carries what the student typed and forgets it when told to.
 */

/** Same "uno-ide.v1." family as the localStorage keys in storage.ts. */
const PHRASE_KEY = "uno-ide.v1.phrase";

/** The phrase this tab has, or "" if it has none. */
export function loadPhrase(): string {
	try {
		return window.sessionStorage.getItem(PHRASE_KEY) ?? "";
	} catch {
		// Site data blocked. The student retypes it per compile; still usable.
		return "";
	}
}

export function savePhrase(phrase: string): void {
	try {
		window.sessionStorage.setItem(PHRASE_KEY, phrase);
	} catch {
		// Ignored on purpose: see loadPhrase.
	}
}

/** Called whenever the server rejects it, so the next compile asks again. */
export function clearPhrase(): void {
	try {
		window.sessionStorage.removeItem(PHRASE_KEY);
	} catch {
		// Ignored on purpose: see loadPhrase.
	}
}

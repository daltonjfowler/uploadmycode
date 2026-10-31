/**
 * The teacher's page (web/teacher.html): sign in, set the class phrase, switch
 * ESP32 and its Wi-Fi safety failsafe.
 *
 * Signing in is web/src/teacher-account.ts (the same file on all four uploadmy
 * sites). It keeps the session in localStorage under KEY_STORAGE, and every
 * call here sends it as x-teacher-key. The projector window (web/public/
 * display.js) reads the same entry, so it works once a teacher has signed in
 * on this computer.
 */

import { loadDeviceId } from "./device.ts";
import { mountAccount } from "./teacher-account.ts";

declare global {
	interface Window {
		/** web/public/phrase-words.js, loaded by teacher.html before this module. */
		uploadmycodePhrase: { generatePhrase(): string };
	}
}

const API = "/api/teacher/phrase";
const BOARDS_API = "/api/teacher/boards";
/** The sign-in. web/public/display.js reads the same entry. */
const KEY_STORAGE = "uploadmycode.teacherKey";

/** Every field any teacher route answers with; each caller reads its own. */
interface ReplyBody {
	error?: string;
	message?: string;
	phrase?: string | null;
	expiresAt?: number;
	esp32?: boolean;
	allowWifiTools?: boolean;
	wifiToolsUntil?: number;
}
interface Reply {
	status: number;
	body: ReplyBody;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const panel = $("panel");
const phraseInput = $<HTMLInputElement>("phrase");
const durationSelect = $<HTMLSelectElement>("duration");
const display = $("display");
const phraseNow = $("phrase-now");
const countdown = $("countdown");
const message = $("message");
const boardsNow = $("boards-now");

/** Unix ms the current phrase dies, or 0 when there is none. */
let expiresAt = 0;
/** The board settings the server last sent, or null before the first answer. */
let boards: ReplyBody | null = null;

/**
 * Three different words and a two-digit number, "otter-maple-rocket-47".
 * The list and the reasons for it live in web/public/phrase-words.js.
 */
function generatePhrase(): string {
	return window.uploadmycodePhrase.generatePhrase();
}

/**
 * The Worker's own 429 sentence, verbatim, minutes and all: the short
 * per-device lockout after five wrong tries in a row (which refuses even the
 * right key until the wait is over), or the site-wide guard that arms after a
 * hundred WRONG keys from anywhere (which a correct sign-in never meets).
 */
function busyText(body: ReplyBody): string {
	if (body.error === "locked" && typeof body.message === "string") return body.message;
	return body.error ?? "Too many wrong keys from everywhere right now. Try again in 15 minutes. The right key still works.";
}

function say(text: string, tone: "plain" | "ok" | "error" = "plain"): void {
	message.textContent = text;
	message.dataset.tone = tone;
}

/** The saved sign-in, as the pop-out window will read it. */
function savedSignIn(): string {
	try {
		return window.localStorage.getItem(KEY_STORAGE) ?? "";
	} catch {
		return "";
	}
}

/**
 * One call to the teacher API. Resolves to { status, body } and never
 * rejects, so every caller has one shape to read.
 */
async function call(method: string, payload: unknown, url = API): Promise<Reply> {
	const key = account.credential();
	if (key === "") return { status: 0, body: { error: "Sign in first (top of this page)." } };

	const headers: Record<string, string> = { "x-teacher-key": key, "x-device-id": loadDeviceId() };
	if (payload !== null) headers["content-type"] = "application/json";
	let response: Response;
	try {
		response = await fetch(url, { method, headers, body: payload === null ? undefined : JSON.stringify(payload) });
	} catch {
		return { status: 0, body: { error: "Could not reach the server. Check the network." } };
	}
	let body: ReplyBody;
	try {
		body = (await response.json()) as ReplyBody;
	} catch {
		body = { error: "The server sent a reply this page could not read." };
	}
	// The sign-in ended (a new password, a start code, or 30 days): back to the sign-in form.
	if (response.status === 401) account.refused();
	if (response.ok && method !== "GET") account.refreshChanges();
	return { status: response.status, body };
}

/** Draw whatever the server last told us. */
function show(body: ReplyBody): void {
	if (body.phrase) {
		expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : 0;
		phraseNow.textContent = body.phrase;
		display.dataset.live = "yes";
	} else {
		expiresAt = 0;
		phraseNow.textContent = "no phrase set";
		display.dataset.live = "no";
	}
	tick();
}

function tick(): void {
	if (expiresAt === 0) {
		countdown.textContent = "Students cannot compile right now.";
		return;
	}

	const left = Math.floor((expiresAt - Date.now()) / 1000);
	if (left <= 0) {
		// The Worker stops accepting it at exactly this moment too.
		expiresAt = 0;
		phraseNow.textContent = "no phrase set";
		display.dataset.live = "no";
		countdown.textContent = "That phrase has expired. Students cannot compile.";
		return;
	}

	const hours = Math.floor(left / 3600);
	const minutes = Math.floor((left % 3600) / 60);
	const seconds = left % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(hours + " h");
	if (hours > 0 || minutes > 0) parts.push(minutes + " min");
	parts.push(seconds + " s");
	countdown.textContent = "Ends in " + parts.join(" ") + ".";
}

function handle(result: Reply, okText: string): void {
	if (result.status === 200) {
		show(result.body);
		say(okText, "ok");
		return;
	}
	if (result.status === 401) {
		say("Your sign-in ended. Sign in again at the top of this page.", "error");
		return;
	}
	if (result.status === 429) {
		// The Worker's sentence carries the wait, so show it word for word.
		say(busyText(result.body), "error");
		return;
	}
	say(result.body.error ?? "Something went wrong.", "error");
}

/**
 * The same tidy-up the Worker does before it compares two phrases, so
 * "Blue Robot Pancake" and "blue robot pancake" count as the same one.
 */
function normalize(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "2:35 PM", or "" if the clock value makes no sense. */
function clockTime(unixMs: unknown): string {
	if (typeof unixMs !== "number" || !Number.isFinite(unixMs)) return "";
	try {
		return new Date(unixMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	} catch {
		return "";
	}
}

/**
 * Ask before taking a live phrase away from whoever is using it.
 *
 * There is ONE phrase for the whole site, so a second teacher pressing Set
 * replaces the first teacher's phrase instantly and their students are
 * refused mid-lesson with "Wrong class phrase". So the page says so, with the
 * phrase and the time it was going to end, because those are what tell you
 * whose class it is.
 */
function confirmReplace(live: { phrase: string; expiresAt?: number }): boolean {
	const ends = clockTime(live.expiresAt);
	return window.confirm(
		"A class phrase is already live: " +
			live.phrase +
			(ends === "" ? "" : "\nIt was set to end at " + ends + ".") +
			"\n\nAnother class may be using it right now. Replacing it stops their compiles " +
			"until they are told the new phrase.\n\nReplace it?",
	);
}

$("generate").addEventListener("click", () => {
	phraseInput.value = generatePhrase();
	phraseInput.focus();
});

$("set").addEventListener("click", async () => {
	const phrase = phraseInput.value.trim();
	if (phrase === "") {
		say("Type a phrase, or press Generate.", "error");
		return;
	}
	const ttl = Number(durationSelect.value);
	const put = async () => handle(await call("POST", { phrase, ttlSeconds: ttl }), "Phrase is live. Write it on the board.");

	// Ask the server rather than trusting what this page last drew: the other
	// teacher may have set theirs twenty minutes ago, in another room.
	say("Checking whether a phrase is already live...");
	const current = await call("GET", null);
	if (current.status === 401 || current.status === 403 || current.status === 429) {
		// The sign-in is the problem. Say so, and do not send a POST that would
		// only be refused for the same reason.
		handle(current, "Up to date.");
		return;
	}
	if (current.status !== 200) {
		// Could not check. The teacher decides, rather than this page either
		// blocking them or quietly stomping somebody.
		if (window.confirm("Could not check whether a phrase is already live.\n\nSet this one anyway?")) await put();
		else say("Nothing changed.");
		return;
	}

	show(current.body);
	const live = current.body.phrase ? { phrase: current.body.phrase, expiresAt: current.body.expiresAt } : null;
	// Setting the phrase that is already live is a renewal, not a takeover:
	// nobody loses access, so there is nothing to warn about.
	if (live && normalize(live.phrase) !== normalize(phrase) && !confirmReplace(live)) {
		say("Left the phrase that was already live. Nothing changed.");
		return;
	}
	await put();
});

async function refresh(): Promise<void> {
	handle(await call("GET", null), "Up to date.");
}

$("refresh").addEventListener("click", () => {
	void refresh();
	void loadBoards();
});

$("end").addEventListener("click", async () => {
	handle(await call("DELETE", null), "Phrase ended. Nobody can compile now.");
});

/**
 * The projector window: /display, which shows the phrase and nothing else.
 *
 * Opened from a click, so no pop-up blocker should mind; if one does,
 * window.open hands back null and the teacher gets told which setting to
 * change. The window reads the sign-in out of localStorage itself.
 */
$("popout").addEventListener("click", () => {
	if (savedSignIn() === "") {
		say("This browser does not keep the sign-in, so the pop-out window cannot read the phrase.", "error");
		return;
	}
	const opened = window.open("/display", "umc-phrase-display", "width=1000,height=420");
	if (!opened) {
		say("Your browser blocked the pop-out. Allow pop-ups for this site and try again.", "error");
		return;
	}
	say("Phrase window opened. Drag it onto the projector screen.", "ok");
});

// Enter in the phrase field is the obvious action for that field.
phraseInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") $("set").click();
});

// ---------------------------------------------------------------- boards
// ESP32 on/off and the ESP32 Wi-Fi safety failsafe (src/boards.ts).

function showBoards(body: ReplyBody): void {
	boards = body;
	if (typeof body.esp32 !== "boolean") {
		boardsNow.textContent = "Could not read the board settings. Press Refresh to try again.";
		return;
	}
	let text = body.esp32 ? "ESP32 is ON: students see the board picker." : "ESP32 is off: students use Arduino UNO only.";
	if (body.esp32) {
		text += body.allowWifiTools
			? " Wi-Fi safety failsafe is OFF until " + clockTime(body.wifiToolsUntil) + "."
			: " Wi-Fi safety failsafe is on.";
	}
	boardsNow.textContent = text;
}

async function setBoards(payload: { esp32: boolean; wifiToolsSeconds?: number }, okText: string): Promise<void> {
	const result = await call("POST", payload, BOARDS_API);
	if (result.status === 200) {
		showBoards(result.body);
		say(okText, "ok");
	} else if (result.status === 429) say(busyText(result.body), "error");
	else say(result.body.error ?? "Could not change the board settings.", "error");
}

async function loadBoards(): Promise<void> {
	const result = await call("GET", null, BOARDS_API);
	if (result.status === 200) showBoards(result.body);
}

$("esp32-on").addEventListener("click", () => {
	void setBoards({ esp32: true, wifiToolsSeconds: 0 }, "ESP32 is on. Students may need to reload the page to see the board picker.");
});
$("esp32-off").addEventListener("click", () => {
	void setBoards({ esp32: false }, "ESP32 is off. The failsafe is back on.");
});
$("failsafe-off").addEventListener("click", () => {
	if (!boards || !boards.esp32) {
		say("Switch ESP32 on first.", "error");
		return;
	}
	const seconds = Number($<HTMLSelectElement>("override-duration").value);
	const ok = window.confirm(
		"Switch the Wi-Fi safety failsafe OFF?\n\nWhile it is off, students can compile and upload ESP32 sketches that can knock people off Wi-Fi networks, flood fake networks or sniff traffic. Use it only for a supervised lesson on your own test network. It turns itself back on when the time runs out.",
	);
	if (!ok) return;
	void setBoards({ esp32: true, wifiToolsSeconds: seconds }, "Failsafe is off for now. It turns itself back on at the time shown.");
});
$("failsafe-on").addEventListener("click", () => {
	void setBoards({ esp32: !!boards?.esp32, wifiToolsSeconds: 0 }, "Failsafe is on.");
});

// ---------------------------------------------------------------- start

phraseInput.value = generatePhrase();
window.setInterval(tick, 1000);
tick();

// Last, because it can call onSignedOut straight away. A saved sign-in shows
// what is live without a click (mountAccount checks it, then onSignedIn).
const account = mountAccount({
	root: $("account"),
	storageKey: KEY_STORAGE,
	headers: () => ({ "x-device-id": loadDeviceId() }),
	onSignedIn: () => {
		panel.hidden = false;
		void refresh();
		void loadBoards();
	},
	onSignedOut: () => {
		panel.hidden = true;
		boards = null;
		say("");
	},
});

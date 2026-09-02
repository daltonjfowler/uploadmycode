/**
 * Wiring for the editor page: toolbar, sketch library, compile, output panel.
 *
 * Everything that has real logic in it lives in a neighbouring module; this
 * file is the boring part that connects them to the buttons in index.html.
 */

import "./style.css";

import { hexProgramBytes, requestCompile } from "./compile.ts";
import { createEditor, type Editor } from "./editor.ts";
import { errorLines, firstErrorSummary, parseCompileErrors, type CompileError } from "./errors.ts";
import { HexParseError, parseIntelHex } from "./flash/intel-hex.ts";
import { findIncludeLine, insertInclude, LIBRARIES } from "./libraries.ts";
import {
	findGrantedUnoPort,
	isWebSerialAvailable,
	NO_WEB_SERIAL_MESSAGE,
	openTransport,
	requestPort,
	type OpenPort,
	type SerialPortLike,
} from "./flash/serial.ts";
import { FlashError, PAGE_SIZE, uploadImage } from "./flash/stk500v1.ts";
import { clearPhrase, loadPhrase, savePhrase } from "./phrase.ts";
import {
	BAUD_RATES,
	DEFAULT_BAUD_RATE,
	LINE_ENDING_LABELS,
	SerialMonitor,
	type LineEnding,
} from "./monitor.ts";
import { appState, clearCompiledHex, hasFreshHex, setCompiledHex, type Status } from "./state.ts";
import {
	BLANK_SKETCH,
	cleanName,
	DEFAULT_SKETCH_NAME,
	isStorageBroken,
	loadAutocompleteEnabled,
	loadCurrentName,
	loadMonitorBaud,
	loadMonitorOpen,
	loadSketches,
	saveAutocompleteEnabled,
	saveCurrentName,
	saveMonitorBaud,
	saveMonitorOpen,
	saveSketches,
	starterLibrary,
	uniqueName,
	type Sketch,
} from "./storage.ts";

/** Usable flash on an Uno: 32 KB minus the bootloader. */
const UNO_FLASH_BYTES = 32256;
/** Autosave delay. Long enough not to write on every keystroke. */
const SAVE_DELAY_MS = 400;
/** How long a passing remark stays up before the panel goes back to idle. */
const NOTICE_MS = 2500;
/** The Library dropdown's own first entry: a label, never a choice. */
const LIBRARY_PLACEHOLDER = "Library…";
/** What the output panel says when it has nothing to report. */
const IDLE_OUTPUT = "Click Compile to check your sketch.";

function el<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`Missing element #${id}`);
	return found as T;
}

const sketchSelect = el<HTMLSelectElement>("sketch-select");
const importInput = el<HTMLInputElement>("import-input");
const librarySelect = el<HTMLSelectElement>("library-select");
const autocompleteToggle = el<HTMLInputElement>("autocomplete-toggle");
const compileButton = el<HTMLButtonElement>("compile");
const uploadButton = el<HTMLButtonElement>("upload");
const statusPill = el<HTMLSpanElement>("status");
const errorList = el<HTMLDivElement>("error-list");
const outputText = el<HTMLPreElement>("output-text");
const uploadProgress = el<HTMLDivElement>("upload-progress");
const uploadBar = el<HTMLProgressElement>("upload-bar");
const uploadCount = el<HTMLSpanElement>("upload-count");
const serialHelp = el<HTMLAnchorElement>("serial-help");
const phraseForm = el<HTMLFormElement>("phrase-form");
const phraseInput = el<HTMLInputElement>("phrase-input");
const phraseSet = el<HTMLDivElement>("phrase-set");
const phraseChange = el<HTMLButtonElement>("phrase-change");

// ------------------------------------------------------------- sketch library

let sketches: Sketch[] = loadSketches();
if (sketches.length === 0) sketches = starterLibrary();

let currentName = pickCurrentName();
let saveTimer: number | undefined;
let compiling = false;

function pickCurrentName(): string {
	const remembered = loadCurrentName();
	if (remembered && sketches.some((s) => s.name === remembered)) return remembered;
	return sketches[0]?.name ?? DEFAULT_SKETCH_NAME;
}

function currentSketch(): Sketch {
	const found = sketches.find((s) => s.name === currentName);
	if (found) return found;
	// Should not happen, but never leave the editor without a sketch to write to.
	const replacement: Sketch = { name: currentName, code: BLANK_SKETCH };
	sketches.push(replacement);
	return replacement;
}

function persist(): void {
	saveSketches(sketches);
	saveCurrentName(currentName);
	appState.sketchName = currentName;
}

/** Autosave, coalesced so a fast typist does not write localStorage per key. */
function persistSoon(): void {
	window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(persist, SAVE_DELAY_MS);
}

function renderSketchList(): void {
	sketchSelect.replaceChildren(
		...sketches.map((s) => new Option(s.name, s.name, false, s.name === currentName)),
	);
}

/** Open a sketch in the editor. The caller has already put it in `sketches`. */
function openSketch(nameToOpen: string): void {
	currentName = nameToOpen;
	renderSketchList();
	persist();
	clearCompiledHex();
	editor.setCode(currentSketch().code);
	refreshUploadButton();
	setStatus("idle", "Ready");
	showOutput(IDLE_OUTPUT, "plain");
	editor.focus();
}

/** Add a sketch under a name nobody is using yet, and open it. */
function addSketch(baseName: string, code: string): void {
	const created: Sketch = { name: uniqueName(baseName, sketches), code };
	sketches.push(created);
	openSketch(created.name);
}

// -------------------------------------------------------------------- status

function setStatus(state: Status, text: string): void {
	appState.status = state;
	statusPill.dataset.state = state;
	statusPill.textContent = text;
}

function showOutput(text: string, tone: "plain" | "success" | "error"): void {
	outputText.textContent = text;
	outputText.dataset.tone = tone;
}

let noticeTimer: number | undefined;

/**
 * Say something small that takes itself back down again — nothing has gone
 * wrong and nothing is running, so neither the red pill nor a permanent line in
 * the output panel would be honest. The guard is what keeps a compile started
 * in the meantime from being wiped: the panel is only reset if the notice is
 * still the last thing that wrote to it.
 */
function showNotice(pillText: string, detail: string): void {
	window.clearTimeout(noticeTimer);
	setStatus("idle", pillText);
	showOutput(detail, "plain");
	noticeTimer = window.setTimeout(() => {
		if (statusPill.textContent !== pillText) return;
		setStatus("idle", "Ready");
		showOutput(IDLE_OUTPUT, "plain");
	}, NOTICE_MS);
}

function showErrorRows(errors: CompileError[]): void {
	errorList.replaceChildren(
		...errors.map((error) => {
			const row = document.createElement("button");
			row.type = "button";
			row.className = "error-row";
			row.dataset.severity = error.severity;

			const where = document.createElement("span");
			where.className = "where";
			where.textContent =
				error.column > 0 ? `Line ${error.line}:${error.column}` : `Line ${error.line}`;

			row.append(where, document.createTextNode(`${error.severity}: ${error.message}`));
			row.addEventListener("click", () => {
				editor.goToLine(error.line, error.column);
				editor.focus();
			});
			return row;
		}),
	);
}

function clearErrorRows(): void {
	errorList.replaceChildren();
}

// --------------------------------------------------------------- class phrase

/**
 * The phrase row has three looks: nothing at all until a phrase is first asked
 * for, the field while one is wanted, and one small line once this tab has one.
 * Only the middle look is tall, and it is only up while a student is typing.
 */
function renderPhraseRow(asking: boolean): void {
	phraseForm.hidden = !asking;
	phraseSet.hidden = asking || loadPhrase() === "";
	// Never leave a turned-down phrase sitting in the box, opening or closing.
	phraseInput.value = "";
}

/**
 * Ask for today's phrase, in the page rather than in a browser dialog.
 *
 * The message is whatever the Worker said, word for word: "No class phrase is
 * active" and "Wrong class phrase" send a student to two different places, and
 * paraphrasing them here would lose that.
 */
function askForPhrase(message: string): void {
	renderPhraseRow(true);
	setStatus("error", "Phrase needed");
	showOutput(message, "error");
	phraseInput.focus();
}

function hidePhraseForm(): void {
	renderPhraseRow(false);
}

phraseForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const typed = phraseInput.value.trim();
	if (typed === "") return;
	// The Worker does the real normalizing; this only has to carry the text.
	savePhrase(typed);
	hidePhraseForm();
	void compileSketch();
});

// Nothing is wrong when this one is clicked — the student simply wants to type
// a different phrase — so it opens the field without the error status.
phraseChange.addEventListener("click", () => {
	renderPhraseRow(true);
	phraseInput.focus();
});

// ------------------------------------------------------------------- compiling

async function compileSketch(): Promise<void> {
	if (compiling) return;

	// First compile of the tab: the phrase is asked for before anything is sent,
	// so a class with no phrase set never wakes the container at all.
	let phrase = loadPhrase();
	// Clicking Compile with the field open and filled in means the same thing as
	// pressing Start, and must not throw away what was typed.
	if (phrase === "" && !phraseForm.hidden && phraseInput.value.trim() !== "") {
		phrase = phraseInput.value.trim();
		savePhrase(phrase);
		hidePhraseForm();
	}
	if (phrase === "") {
		askForPhrase("Type today's class phrase to compile. Your teacher has it on the board.");
		return;
	}

	compiling = true;
	compileButton.disabled = true;

	const code = editor.getCode();
	clearCompiledHex();
	refreshUploadButton();
	clearErrorRows();
	editor.clearErrorLines();
	statusPill.title = "";
	setStatus("compiling", "Compiling…");
	showOutput("Compiling on the server. The first compile after a quiet spell can take 15 seconds.", "plain");

	try {
		const outcome = await requestCompile(code, phrase);

		if (outcome.kind === "success") {
			setCompiledHex(outcome.hex, code);
			const bytes = hexProgramBytes(outcome.hex);
			const percent = Math.round((bytes / UNO_FLASH_BYTES) * 100);
			setStatus("success", "Compiled");
			showOutput(
				`Compiled with no errors.\nProgram size: ${bytes} bytes of ${UNO_FLASH_BYTES} (${percent}%).`,
				"success",
			);
			return;
		}

		if (outcome.kind === "phrase-required") {
			// Missing, wrong, or expired. Whichever it was, this tab's copy is no
			// good, so drop it and ask again with the Worker's own sentence.
			clearPhrase();
			askForPhrase(outcome.message);
			return;
		}

		if (outcome.kind === "busy") {
			setStatus("compiler-busy", "Compiler busy");
			showOutput(outcome.message, "error");
			return;
		}

		if (outcome.kind === "service-error") {
			setStatus("error", "Failed");
			showOutput(outcome.message, "error");
			return;
		}

		// A real compile that the sketch failed.
		const errors = parseCompileErrors(outcome.stderr);
		setStatus("error", "Errors");
		showErrorRows(errors);
		showOutput(outcome.stderr.trim() || "Compile failed.", "error");
		if (errors.length > 0) {
			editor.showErrorLines(errorLines(errors));
			const summary = firstErrorSummary(errors);
			if (summary) statusPill.title = summary;
		}
	} finally {
		compiling = false;
		compileButton.disabled = false;
		refreshUploadButton();
	}
}

// ------------------------------------------------------------------ uploading

/**
 * The board the student picked, shared by Upload and by the serial monitor.
 * Chrome remembers the permission per device, so after the first Upload the
 * chooser never appears again — which is what makes "upload a second sketch
 * without replugging" a single click, and what lets the monitor hand the same
 * board to the flasher and take it back afterwards.
 */
let sharedPort: SerialPortLike | null = null;
/**
 * Set after a filtered chooser came back with nothing. The next click lists
 * every serial port, so a board with an unusual USB chip is still reachable.
 * Each request happens inside its own click, so Chrome still sees a gesture.
 */
let showAllPorts = false;
let uploading = false;

/** Upload is only legal when the hex on hand was built from the text on screen. */
function refreshUploadButton(): void {
	const ready = !uploading && !compiling && hasFreshHex(editor.getCode());
	uploadButton.disabled = !ready;
	uploadButton.title = ready
		? "Send this sketch to the Uno over USB."
		: "Compile first — the board can only be sent a sketch that has just compiled.";
}

function showUploadProgress(pagesDone: number, pagesTotal: number): void {
	uploadProgress.hidden = false;
	uploadBar.max = pagesTotal;
	uploadBar.value = pagesDone;
	uploadCount.textContent =
		pagesDone === 0 ? `${pagesTotal} pages to write` : `page ${pagesDone} of ${pagesTotal}`;
}

function hideUploadProgress(): void {
	uploadProgress.hidden = true;
	uploadBar.value = 0;
	uploadCount.textContent = "";
}

async function uploadSketch(): Promise<void> {
	if (uploading || compiling) return;

	const code = editor.getCode();
	if (!hasFreshHex(code) || appState.hex === null) {
		setStatus("error", "Compile first");
		showOutput(
			"This sketch has changed since it was last compiled. Click Compile, then Upload.",
			"error",
		);
		return;
	}

	if (!isWebSerialAvailable()) {
		serialHelp.hidden = false;
		setStatus("error", "No Web Serial");
		showOutput(NO_WEB_SERIAL_MESSAGE, "error");
		return;
	}

	// Do the parsing before touching the port: a bad hex should never leave a
	// board sitting in the bootloader.
	let image: Uint8Array;
	try {
		image = parseIntelHex(appState.hex);
	} catch (cause) {
		setStatus("error", "Bad hex");
		showOutput(
			cause instanceof HexParseError
				? cause.message
				: "The compiled sketch could not be read. Compile again.",
			"error",
		);
		return;
	}

	uploading = true;
	uploadButton.disabled = true;
	compileButton.disabled = true;
	clearErrorRows();
	statusPill.title = "";
	setStatus("uploading", "Uploading…");
	showOutput("Resetting the board and starting the upload…", "plain");
	showUploadProgress(0, Math.ceil(image.length / PAGE_SIZE));

	let transport: OpenPort | null = null;
	let usedPort: SerialPortLike | null = null;
	let resumeMonitor = false;
	try {
		// The monitor and the flasher cannot both hold the port. Pausing gives
		// it back and keeps the same SerialPort object, so nobody is asked to
		// pick the board again and the monitor can carry on afterwards.
		resumeMonitor = await monitor.pauseForUpload();
		refreshMonitorControls();

		const port = sharedPort ?? (await findGrantedUnoPort()) ?? (await requestPort(showAllPorts));
		sharedPort = port;
		usedPort = port;
		showAllPorts = false;

		transport = await openTransport(port);
		const result = await uploadImage(transport, image, { onProgress: showUploadProgress });

		setStatus("success", "Uploaded");
		showOutput(
			`Uploaded ${result.bytesWritten} bytes in ${result.elapsedMs} ms (${result.pagesWritten} pages).\nThe board is running your sketch now.`,
			"success",
		);
	} catch (cause) {
		// Whatever went wrong, do not keep holding the old port: after an unplug
		// Chrome hands out a new one, and the next click should find it.
		sharedPort = null;

		const kind = cause instanceof FlashError ? cause.kind : "port";
		if (kind === "no-port" && !showAllPorts) showAllPorts = true;
		if (kind === "unsupported") serialHelp.hidden = false;

		setStatus("error", kind === "no-port" ? "No board" : "Upload failed");
		showOutput(
			cause instanceof FlashError
				? cause.message
				: `The upload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			"error",
		);
	} finally {
		// Always hand the port back, so the serial monitor can open it and so a
		// second Upload is not blocked by the first one's lock.
		if (transport) await transport.close();

		if (resumeMonitor) {
			await monitor.resumeAfterUpload();
			// The monitor has the same port open again, so Upload may reuse it.
			if (monitor.getState() === "connected") sharedPort = usedPort;
		}

		uploading = false;
		compileButton.disabled = false;
		hideUploadProgress();
		refreshUploadButton();
		refreshMonitorControls();
	}
}

// ------------------------------------------------------------ serial monitor

const monitorStatePill = el<HTMLSpanElement>("monitor-state");
const monitorShowButton = el<HTMLButtonElement>("monitor-show");
const monitorBody = el<HTMLDivElement>("monitor-body");
const monitorConnectButton = el<HTMLButtonElement>("monitor-connect");
const monitorBaudSelect = el<HTMLSelectElement>("monitor-baud");
const monitorAutoscroll = el<HTMLInputElement>("monitor-autoscroll");
const monitorTimestamps = el<HTMLInputElement>("monitor-timestamps");
const monitorOutput = el<HTMLPreElement>("monitor-output");
const monitorSendForm = el<HTMLFormElement>("monitor-send");
const monitorInput = el<HTMLInputElement>("monitor-input");
const monitorSendButton = el<HTMLButtonElement>("monitor-send-button");
const monitorEndingSelect = el<HTMLSelectElement>("monitor-ending");

let monitorRenderQueued = false;
/** Set while the code moves the scrollbar, so that move is not read as the student scrolling. */
let monitorScrollingItself = false;
let monitorConnecting = false;

const monitor = new SerialMonitor({
	onChange: scheduleMonitorRender,
	onState(state) {
		// A monitor that lost the board is holding a dead SerialPort; the next
		// Upload should look the board up again instead of reusing it. A pause
		// for an upload is not a disconnect, so the port survives that.
		if (state === "disconnected") sharedPort = null;
		refreshMonitorControls();
		scheduleMonitorRender();
	},
});

/**
 * A sketch printing flat out changes the buffer far more often than a screen
 * can show it, so redraws are coalesced to one a frame.
 */
function scheduleMonitorRender(): void {
	if (monitorRenderQueued) return;
	monitorRenderQueued = true;
	window.requestAnimationFrame(() => {
		monitorRenderQueued = false;
		renderMonitor();
	});
}

function renderMonitor(): void {
	if (monitorBody.hidden) return;
	monitorOutput.textContent = monitor.text({ timestamps: monitorTimestamps.checked });
	if (monitorAutoscroll.checked) {
		monitorScrollingItself = true;
		monitorOutput.scrollTop = monitorOutput.scrollHeight;
	}
}

function refreshMonitorControls(): void {
	const state = monitor.getState();
	const connected = state === "connected";
	const busy = monitorConnecting || state === "connecting" || uploading;

	monitorStatePill.dataset.state = state;
	monitorStatePill.textContent =
		state === "connected"
			? `Connected at ${monitor.getBaudRate()} baud`
			: state === "connecting"
				? "Connecting…"
				: state === "paused"
					? "Paused for upload"
					: "Not connected";

	monitorConnectButton.textContent = state === "disconnected" ? "Connect" : "Disconnect";
	monitorConnectButton.disabled = busy || !isWebSerialAvailable();
	monitorBaudSelect.disabled = busy;
	monitorInput.disabled = !connected;
	monitorSendButton.disabled = !connected;
}

function setMonitorOpen(open: boolean, remember: boolean): void {
	monitorBody.hidden = !open;
	monitorShowButton.textContent = open ? "🔍 Hide" : "🔍 Show";
	monitorShowButton.setAttribute("aria-expanded", open ? "true" : "false");
	if (remember) saveMonitorOpen(open);
	if (open) renderMonitor();
}

function selectedBaud(): number {
	const parsed = Number.parseInt(monitorBaudSelect.value, 10);
	return Number.isFinite(parsed) ? parsed : DEFAULT_BAUD_RATE;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Take the port — the one Upload already has, if there is one — and listen. */
async function connectMonitor(): Promise<void> {
	if (monitorConnecting || uploading) return;

	if (!isWebSerialAvailable()) {
		serialHelp.hidden = false;
		monitor.notice(NO_WEB_SERIAL_MESSAGE);
		return;
	}

	monitorConnecting = true;
	refreshMonitorControls();
	try {
		const port =
			sharedPort ?? (await findGrantedUnoPort()) ?? (await requestPort(showAllPorts, "monitor"));
		sharedPort = port;
		showAllPorts = false;
		await monitor.connect(port, selectedBaud());
	} catch (cause) {
		sharedPort = null;
		// Same fallback the Upload button uses: a board with an unusual USB chip
		// is invisible under the filters, so the next click lists every port.
		if (cause instanceof FlashError && cause.kind === "no-port" && !showAllPorts) {
			showAllPorts = true;
		}
		if (cause instanceof FlashError && cause.kind === "unsupported") serialHelp.hidden = false;
		monitor.notice(errorMessage(cause));
	} finally {
		monitorConnecting = false;
		refreshMonitorControls();
	}
}

monitorShowButton.addEventListener("click", () => {
	setMonitorOpen(monitorBody.hidden, true);
});

monitorConnectButton.addEventListener("click", () => {
	if (monitor.getState() === "disconnected") {
		// Connecting from a collapsed panel would hide the very output it opens.
		if (monitorBody.hidden) setMonitorOpen(true, true);
		void connectMonitor();
	} else {
		void monitor.disconnect();
	}
});

monitorBaudSelect.addEventListener("change", () => {
	const rate = selectedBaud();
	saveMonitorBaud(rate);
	void monitor.setBaudRate(rate);
});

monitorEndingSelect.addEventListener("change", () => {
	monitor.setLineEnding(monitorEndingSelect.value as LineEnding);
});

monitorTimestamps.addEventListener("change", renderMonitor);

monitorAutoscroll.addEventListener("change", () => {
	if (monitorAutoscroll.checked) renderMonitor();
});

// Scrolling up IS the scroll lock: the view stops chasing the bottom until the
// student scrolls back down, or ticks Autoscroll again.
monitorOutput.addEventListener("scroll", () => {
	if (monitorScrollingItself) {
		monitorScrollingItself = false;
		return;
	}
	const fromBottom =
		monitorOutput.scrollHeight - monitorOutput.scrollTop - monitorOutput.clientHeight;
	monitorAutoscroll.checked = fromBottom < 8;
});

el<HTMLButtonElement>("monitor-clear").addEventListener("click", () => {
	monitor.clear();
	renderMonitor();
});

// The input is inside a form, so Enter submits and this is the send key.
monitorSendForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (monitor.getState() !== "connected") return;
	const text = monitorInput.value;
	monitorInput.value = "";
	void monitor.send(text).catch((cause: unknown) => monitor.notice(errorMessage(cause)));
});

// ---------------------------------------------------------------- the editor

const editor: Editor = createEditor({
	parent: el<HTMLElement>("editor"),
	doc: currentSketch().code,
	autocomplete: loadAutocompleteEnabled(),
	onChange(code) {
		currentSketch().code = code;
		persistSoon();
		// The hex describes the old text now.
		clearCompiledHex();
		refreshUploadButton();
		if (appState.status === "success") setStatus("idle", "Ready");
	},
});

// ------------------------------------------------------------------- toolbar

sketchSelect.addEventListener("change", () => {
	openSketch(sketchSelect.value);
});

el<HTMLButtonElement>("new-sketch").addEventListener("click", () => {
	const asked = cleanName(window.prompt("Name for the new sketch:", uniqueName("sketch", sketches)));
	if (asked === null) return;
	addSketch(asked, BLANK_SKETCH);
});

el<HTMLButtonElement>("rename-sketch").addEventListener("click", () => {
	const asked = cleanName(window.prompt("New name for this sketch:", currentName));
	if (asked === null || asked === currentName) return;

	const clash = sketches.some(
		(s) => s.name !== currentName && s.name.toLowerCase() === asked.toLowerCase(),
	);
	if (clash) {
		window.alert(`There is already a sketch called "${asked}".`);
		return;
	}

	currentSketch().name = asked;
	currentName = asked;
	renderSketchList();
	persist();
});

el<HTMLButtonElement>("delete-sketch").addEventListener("click", () => {
	if (!window.confirm(`Delete "${currentName}"? This cannot be undone.`)) return;

	sketches = sketches.filter((s) => s.name !== currentName);
	if (sketches.length === 0) sketches = starterLibrary();
	openSketch(sketches[0]!.name);
});

el<HTMLButtonElement>("download-sketch").addEventListener("click", () => {
	// Windows and ChromeOS both refuse these characters in a file name.
	const fileName = `${currentName.replace(/[\\/:*?"<>|]+/g, "_")}.ino`;
	const blob = new Blob([editor.getCode()], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.click();
	URL.revokeObjectURL(url);
});

el<HTMLButtonElement>("import-sketch").addEventListener("click", () => {
	importInput.click();
});

importInput.addEventListener("change", async () => {
	const file = importInput.files?.[0];
	// Reset first, so choosing the same file twice fires this again.
	importInput.value = "";
	if (!file) return;

	try {
		const text = await file.text();
		addSketch(file.name.replace(/\.(ino|pde|txt)$/i, "") || "uploaded", text);
	} catch {
		window.alert("Could not read that file.");
	}
});

/**
 * The Library menu. The first entry is the menu's own name rather than a choice,
 * so it is disabled, and every pick puts it back — the dropdown is a button that
 * happens to have eight faces, not a setting that remembers one.
 */
function renderLibraryList(): void {
	const placeholder = new Option(LIBRARY_PLACEHOLDER, "", true, true);
	placeholder.disabled = true;
	librarySelect.replaceChildren(
		placeholder,
		...LIBRARIES.map((library) => new Option(`${library.label} — ${library.note}`, library.header)),
	);
}

librarySelect.addEventListener("change", () => {
	const header = librarySelect.value;
	// Back to the placeholder first, whatever happens next, so picking the same
	// library twice in a row still fires this.
	librarySelect.selectedIndex = 0;
	if (header === "") return;

	const code = editor.getCode();
	const added = insertInclude(code, header);

	if (added === null) {
		// Already there. Put the caret on the line that has it — the active-line
		// highlight is then doing the pointing, with no new machinery for it.
		const existing = findIncludeLine(code, header);
		showNotice(
			"Already included",
			`This sketch already has #include <${header}> on line ${existing}.`,
		);
		editor.goToLine(existing, 0);
		editor.focus();
		return;
	}

	// One transaction, so one Ctrl-Z takes the line back out again.
	editor.replaceCode(added.code, added.line);
	clearErrorRows();
	editor.focus();
});

autocompleteToggle.checked = loadAutocompleteEnabled();
autocompleteToggle.addEventListener("change", () => {
	saveAutocompleteEnabled(autocompleteToggle.checked);
	editor.setAutocomplete(autocompleteToggle.checked);
	editor.focus();
});

compileButton.addEventListener("click", () => {
	void compileSketch();
});

uploadButton.addEventListener("click", () => {
	void uploadSketch();
});

el<HTMLButtonElement>("clear-output").addEventListener("click", () => {
	clearErrorRows();
	editor.clearErrorLines();
	showOutput(IDLE_OUTPUT, "plain");
	setStatus("idle", "Ready");
});

// The autosave is delayed, so flush it when the tab goes away. Closing the lid
// on a Chromebook mid-sentence should not lose the sentence.
window.addEventListener("pagehide", () => persist());
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") persist();
});

// Ctrl-Enter (Cmd-Enter on a Mac) compiles, like the Arduino IDE's verify.
window.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
		event.preventDefault();
		void compileSketch();
	}
});

// ----------------------------------------------------------------------- boot

renderSketchList();
renderLibraryList();
persist();
setStatus("idle", "Ready");
refreshUploadButton();
// A reloaded tab still has its phrase in sessionStorage, so say so in one line
// instead of leaving a student wondering whether it will be asked for again.
renderPhraseRow(false);

// The two monitor pickers are built from the module's own lists, so the page
// and the code can never disagree about what a baud rate or an ending is.
const rememberedBaud = loadMonitorBaud();
const startingBaud =
	rememberedBaud !== null && (BAUD_RATES as readonly number[]).includes(rememberedBaud)
		? rememberedBaud
		: DEFAULT_BAUD_RATE;

monitorBaudSelect.replaceChildren(
	...BAUD_RATES.map((rate) => new Option(String(rate), String(rate), false, rate === startingBaud)),
);
monitorEndingSelect.replaceChildren(
	...(Object.keys(LINE_ENDING_LABELS) as LineEnding[]).map(
		(ending) =>
			new Option(LINE_ENDING_LABELS[ending], ending, false, ending === monitor.getLineEnding()),
	),
);

monitor.notice(
	"Click Connect and pick the board. Whatever the sketch prints with Serial.println shows up here.",
);
setMonitorOpen(loadMonitorOpen(), false);
refreshMonitorControls();

// Two things a student needs to hear before they hit a wall, not after.
const bootWarnings: string[] = [];
if (isStorageBroken()) {
	bootWarnings.push(
		"This browser is not letting the page save sketches. Your work will be lost when you close the tab — download the .ino before you leave.",
	);
}
if (!isWebSerialAvailable()) {
	serialHelp.hidden = false;
	bootWarnings.push(NO_WEB_SERIAL_MESSAGE);
	monitor.notice("The Serial Monitor needs Chrome too. Connect is switched off in this browser.");
}
if (bootWarnings.length > 0) showOutput(bootWarnings.join("\n\n"), "error");

/**
 * A handle for the browser console, and for checking the compile result by hand
 * during testing. T3 imports state.ts directly rather than using this.
 */
declare global {
	interface Window {
		uploadmycode: { state: typeof appState };
	}
}
window.uploadmycode = { state: appState };

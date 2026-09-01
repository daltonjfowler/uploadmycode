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
import { appState, clearCompiledHex, hasFreshHex, setCompiledHex, type Status } from "./state.ts";
import {
	BLANK_SKETCH,
	cleanName,
	DEFAULT_SKETCH_NAME,
	isStorageBroken,
	loadAutocompleteEnabled,
	loadCurrentName,
	loadSketches,
	saveAutocompleteEnabled,
	saveCurrentName,
	saveSketches,
	starterLibrary,
	uniqueName,
	type Sketch,
} from "./storage.ts";

/** Usable flash on an Uno: 32 KB minus the bootloader. */
const UNO_FLASH_BYTES = 32256;
/** Autosave delay. Long enough not to write on every keystroke. */
const SAVE_DELAY_MS = 400;

function el<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`Missing element #${id}`);
	return found as T;
}

const sketchSelect = el<HTMLSelectElement>("sketch-select");
const importInput = el<HTMLInputElement>("import-input");
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
	showOutput("Click Compile to check your sketch.", "plain");
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

// ------------------------------------------------------------------- compiling

async function compileSketch(): Promise<void> {
	if (compiling) return;
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
		const outcome = await requestCompile(code);

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
 * The board the student picked. Chrome remembers the permission per device, so
 * after the first Upload the chooser never appears again — which is what makes
 * "upload a second sketch without replugging" a single click.
 */
let chosenPort: SerialPortLike | null = null;
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
	try {
		const port = chosenPort ?? (await findGrantedUnoPort()) ?? (await requestPort(showAllPorts));
		chosenPort = port;
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
		chosenPort = null;

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
		// Always hand the port back, so T4's serial monitor can open it and so a
		// second Upload is not blocked by the first one's lock.
		if (transport) await transport.close();
		uploading = false;
		compileButton.disabled = false;
		hideUploadProgress();
		refreshUploadButton();
	}
}

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
	showOutput("Click Compile to check your sketch.", "plain");
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
persist();
setStatus("idle", "Ready");
refreshUploadButton();

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

/**
 * The tiny bit of state that outlives a single click.
 *
 * Everything else lives in the DOM or in localStorage. The important field is
 * `hex`: on a successful compile we keep the Intel HEX text here so the Upload
 * button can flash it without compiling again, and `hasFreshHex` is what keeps
 * Upload disabled once the sketch has been edited out from under the hex.
 */

/** What the status pill is showing. */
export type Status =
	| "idle"
	| "compiling"
	| "uploading"
	| "success"
	| "error"
	| "compiler-busy";

export interface AppState {
	/** Intel HEX from the last successful UNO compile, or null. */
	hex: string | null;
	/** ESP32: base64 image from the last successful compile, or null. Never both this and `hex`. */
	bin: string | null;
	/** Flash address for `bin`. */
	binAddress: number;
	/** The sketch source that produced `hex` or `bin`, so we can tell if it went stale. */
	hexSource: string | null;
	/** Name of the sketch currently open in the editor. */
	sketchName: string;
	status: Status;
}

export const appState: AppState = {
	hex: null,
	bin: null,
	binAddress: 0,
	hexSource: null,
	sketchName: "",
	status: "idle",
};

/** Record a successful UNO compile. */
export function setCompiledHex(hex: string, source: string): void {
	appState.hex = hex;
	appState.bin = null;
	appState.hexSource = source;
}

/** Record a successful ESP32 compile. */
export function setCompiledBin(bin: string, address: number, source: string): void {
	appState.hex = null;
	appState.bin = bin;
	appState.binAddress = address;
	appState.hexSource = source;
}

/** Drop the compiled program — the sketch or the board changed, so it no longer describes the code. */
export function clearCompiledHex(): void {
	appState.hex = null;
	appState.bin = null;
	appState.hexSource = null;
}

/**
 * True when there is a compiled program and it was built from exactly this
 * source. The Upload button uses this to decide whether it must compile first.
 */
export function hasFreshHex(currentSource: string): boolean {
	return (appState.hex !== null || appState.bin !== null) && appState.hexSource === currentSource;
}

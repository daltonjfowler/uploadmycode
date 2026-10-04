/**
 * Libraries a student uploads themselves, sent along with every compile.
 *
 * The page unpacks a library .zip into its source files (web/src/user-libraries.ts)
 * and sends them as text next to the sketch:
 *
 *   { "code": "...", "libraries": [ { "name": "MyLib", "files": [ { "path": "MyLib.h", "text": "..." } ] } ] }
 *
 * Nothing is installed: server.js writes them into the bucket's `libraries`
 * folder for one compile (writeLibraries) and deletes them when it ends, exactly
 * like the sketch. They are untrusted the same way the sketch is, so every file
 * goes through the same sketch-guard check, and only C and C++ source and header
 * files are accepted (no assembler, which has its own ways of reading files).
 *
 * Each library is written as `user_<name>`, with a library.properties written
 * here, never taken from the upload. The prefix keeps an uploaded library's
 * compiled objects from ever landing in, or being cleaned out of, the folder of
 * an installed library: cleaning out SensorKit's U8g2 objects would make the next
 * SensorKit compile slow enough to time out.
 *
 * No imports from server.js, so `npm test` loads it without starting a server.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sketchProblem } from "./sketch-guard.js";

/** Mirrored in web/src/user-libraries.ts, which says the same thing sooner. */
export const MAX_LIBRARIES = 8;
export const MAX_LIBRARY_FILES = 300;
export const MAX_LIBRARY_BYTES = 512 * 1024;
const MAX_PATH_DEPTH = 8;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/;
export const SOURCE_EXTENSIONS = [".h", ".hh", ".hpp", ".hxx", ".c", ".cc", ".cpp", ".cxx", ".inl", ".ipp", ".tpp"];
export const FOLDER_PREFIX = "user_";

/**
 * @typedef {{ name: string, files: { path: string, text: string }[] }} UserLibrary
 */

/**
 * Check what the page sent. Returns the libraries, or one plain sentence saying
 * what is wrong (shown in Output like a compile error).
 * @param {unknown} raw  the request's `libraries` field (undefined when absent)
 * @returns {{ libraries: UserLibrary[] } | { problem: string }}
 */
export function checkLibraries(raw) {
	if (raw === undefined || raw === null) return { libraries: [] };
	if (!Array.isArray(raw)) return { problem: "Your libraries did not arrive in one piece. Try again." };
	if (raw.length > MAX_LIBRARIES) return { problem: `You can use up to ${MAX_LIBRARIES} of your own libraries at once. Remove one in Library → Manage your libraries.` };

	/** @type {UserLibrary[]} */
	const libraries = [];
	const names = new Set();
	let files = 0;
	let bytes = 0;
	for (const lib of raw) {
		const name = lib?.name;
		if (typeof name !== "string" || !NAME.test(name) || name.includes("..")) {
			return { problem: "One of your libraries has a name that cannot be used. Remove it and add it again." };
		}
		if (names.has(name.toLowerCase())) return { problem: `Two of your libraries are both called ${name}. Remove one.` };
		names.add(name.toLowerCase());
		if (!Array.isArray(lib.files) || lib.files.length === 0) return { problem: `Library ${name} has no files.` };

		const seen = new Set();
		const out = [];
		for (const file of lib.files) {
			const p = file?.path;
			const text = file?.text;
			if (typeof p !== "string" || typeof text !== "string") return { problem: `Library ${name} did not arrive in one piece. Try again.` };
			const segments = p.split("/");
			const ext = path.posix.extname(p).toLowerCase();
			if (segments.length > MAX_PATH_DEPTH || !segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..") || !SOURCE_EXTENSIONS.includes(ext)) {
				return { problem: `Library ${name}: the file ${p.slice(0, 120)} cannot be used. Only .h, .c and .cpp style files can.` };
			}
			if (seen.has(p.toLowerCase())) return { problem: `Library ${name} has the file ${p} twice.` };
			seen.add(p.toLowerCase());
			files += 1;
			bytes += Buffer.byteLength(text, "utf8");
			if (files > MAX_LIBRARY_FILES) return { problem: `Your libraries have more than ${MAX_LIBRARY_FILES} files together. Remove one.` };
			if (bytes > MAX_LIBRARY_BYTES) return { problem: `Your libraries are bigger than ${MAX_LIBRARY_BYTES / 1024} KB together. Remove one.` };
			// The same check as the sketch, pointed at this file instead of sketch.ino.
			const problem = sketchProblem(text);
			if (problem !== null) return { problem: problem.replace(/^sketch\.ino:/, `${name}/${p}:`) };
			out.push({ path: p, text });
		}
		libraries.push({ name, files: out });
	}
	return { libraries };
}

/**
 * Write the libraries into `librariesDir` (which must already be empty), as
 * arduino-cli libraries: `user_<name>/library.properties` and `user_<name>/src/...`.
 * The src layout compiles every folder inside it, so a library's `utility/` files
 * and its relative includes keep working.
 * @param {string} librariesDir
 * @param {UserLibrary[]} libraries
 */
export async function writeLibraries(librariesDir, libraries) {
	for (const lib of libraries) {
		const root = path.join(librariesDir, FOLDER_PREFIX + lib.name);
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(
			path.join(root, "library.properties"),
			`name=${FOLDER_PREFIX}${lib.name}\nversion=1.0.0\narchitectures=*\nsentence=Uploaded by a student.\n`,
			"utf8",
		);
		for (const file of lib.files) {
			const target = path.join(root, "src", ...file.path.split("/"));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, file.text, "utf8");
		}
	}
}

/**
 * Empty `librariesDir` and remove what arduino-cli built from uploaded libraries
 * under `buildPath/libraries`. Leaves the folder itself, because arduino-cli is
 * always pointed at it (see server.js: adding or dropping `--libraries` makes it
 * rebuild the whole core).
 * @param {string} librariesDir
 * @param {string} buildPath
 */
export async function forgetLibraries(librariesDir, buildPath) {
	await rm(librariesDir, { recursive: true, force: true });
	await mkdir(librariesDir, { recursive: true });
	const built = path.join(buildPath, "libraries");
	for (const name of await readdir(built).catch(() => [])) {
		if (name.startsWith(FOLDER_PREFIX)) await rm(path.join(built, name), { recursive: true, force: true });
	}
}

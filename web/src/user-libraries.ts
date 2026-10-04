/**
 * Libraries a student adds themselves, from a library .zip (as GitHub and the
 * Arduino site hand them out) or from loose .h/.cpp files.
 *
 * They live in this browser only (storage.ts) and are sent as text with every
 * compile; the compile server writes them next to the sketch for that one compile
 * and checks every file the way it checks a sketch (container/user-libraries.js,
 * whose limits these mirror so the student hears about them at once).
 *
 * Only the code the compiler needs is kept: a library's `src` folder when it has
 * one, otherwise its top folder and `utility`. Examples, pictures and docs stay
 * behind. No DOM here, so Node tests can load it.
 */

import { unzip, ZipError } from "./unzip.ts";

export interface UserLibrary {
	/** Plain name, unique in this browser ignoring case. */
	name: string;
	/** The header a sketch includes, e.g. "MyLib.h". */
	header: string;
	files: { path: string; text: string }[];
}

export const MAX_LIBRARIES = 8;
export const MAX_LIBRARY_FILES = 300;
export const MAX_LIBRARY_BYTES = 512 * 1024;

const SOURCE = /\.(h|hh|hpp|hxx|c|cc|cpp|cxx|inl|ipp|tpp)$/i;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/;

/** A sentence for the student when something cannot be used. */
export class LibraryProblem extends Error {}

const bytesOf = (lib: { files: { text: string }[] }) => lib.files.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0);

/** A name the server accepts, from whatever the zip or file was called. */
export function cleanLibraryName(raw: string): string {
	const base = raw
		.replace(/\.zip$/i, "")
		.replace(/[-_ ](master|main)$/i, "")
		.replace(/[-_ ]v?\d+(\.\d+)+$/i, "") // "MyLib-1.2.3"
		.replace(/[^A-Za-z0-9_.-]+/g, "_")
		.replace(/^[^A-Za-z0-9]+/, "")
		.replace(/\.+$/, "")
		.slice(0, 64);
	return base || "MyLibrary";
}

/**
 * Turn the files of a library (paths relative to the zip) into one UserLibrary.
 * Throws LibraryProblem with a sentence when it cannot.
 */
export function libraryFromFiles(fallbackName: string, all: { path: string; text: string }[]): UserLibrary {
	let files = all
		.map((f) => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^(\.\/)+/, "") }))
		.filter((f) => !f.path.startsWith("__MACOSX/") && !f.path.split("/").some((s) => s.startsWith(".")));
	// GitHub zips put everything in one folder, "MyLib-main/".
	const tops = new Set(files.map((f) => f.path.split("/")[0]));
	let folder = "";
	if (tops.size === 1 && files.every((f) => f.path.includes("/"))) {
		folder = [...tops][0];
		files = files.map((f) => ({ ...f, path: f.path.slice(folder.length + 1) }));
	}
	const props = files.find((f) => f.path === "library.properties")?.text ?? "";
	const prop = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(props)?.[1];

	const hasSrc = files.some((f) => f.path.startsWith("src/") && SOURCE.test(f.path));
	const code = hasSrc
		? files.filter((f) => f.path.startsWith("src/")).map((f) => ({ ...f, path: f.path.slice(4) }))
		: files.filter((f) => !f.path.includes("/") || f.path.startsWith("utility/"));
	const kept = code.filter((f) => SOURCE.test(f.path));
	if (!kept.some((f) => /\.(h|hh|hpp|hxx)$/i.test(f.path))) {
		throw new LibraryProblem("This has no .h file, so it is not a library. Pick the library's .zip, or its .h and .cpp files.");
	}
	for (const f of kept) {
		if (!f.path.split("/").every((s) => SEGMENT.test(s))) {
			throw new LibraryProblem(`The file "${f.path}" has a name that cannot be used (spaces or odd letters). Rename it and try again.`);
		}
	}
	if (kept.length > MAX_LIBRARY_FILES) throw new LibraryProblem(`This library has more than ${MAX_LIBRARY_FILES} files, so it cannot be used here.`);

	const name = cleanLibraryName(prop("name") ?? (folder || fallbackName));
	const roots = kept.filter((f) => !f.path.includes("/") && /\.(h|hh|hpp|hxx)$/i.test(f.path)).map((f) => f.path);
	const wanted = prop("includes")?.split(",")[0]?.trim();
	const header =
		(wanted && kept.some((f) => f.path === wanted) ? wanted : undefined) ??
		roots.find((h) => h.toLowerCase() === `${name.toLowerCase()}.h`) ??
		roots.find((h) => cleanLibraryName(h.replace(/\.\w+$/, "")).toLowerCase() === name.toLowerCase()) ??
		roots[0] ??
		kept.find((f) => /\.(h|hh|hpp|hxx)$/i.test(f.path))!.path;
	const lib = { name, header, files: kept.map(({ path, text }) => ({ path, text })) };
	if (bytesOf(lib) > MAX_LIBRARY_BYTES) throw new LibraryProblem(`This library is bigger than ${MAX_LIBRARY_BYTES / 1024} KB, so it cannot be used here.`);
	return lib;
}

const isWanted = (path: string) => SOURCE.test(path) || /(^|\/)library\.properties$/.test(path);

/** What the student picked: one .zip, or some .h/.cpp files. */
export async function readLibrary(picked: { name: string; arrayBuffer(): Promise<ArrayBuffer> }[]): Promise<UserLibrary> {
	const text = new TextDecoder();
	if (picked.length === 1 && /\.zip$/i.test(picked[0].name)) {
		let entries;
		try {
			entries = await unzip(await picked[0].arrayBuffer(), isWanted, MAX_LIBRARY_BYTES * 4);
		} catch (error) {
			throw new LibraryProblem(error instanceof ZipError ? error.message : "This .zip is damaged.");
		}
		return libraryFromFiles(picked[0].name, entries.map((e) => ({ path: e.path, text: text.decode(e.bytes) })));
	}
	if (picked.some((f) => /\.zip$/i.test(f.name))) throw new LibraryProblem("Pick one library .zip at a time.");
	const files = [];
	for (const f of picked) files.push({ path: f.name, text: text.decode(await f.arrayBuffer()) });
	const firstHeader = files.find((f) => /\.(h|hpp)$/i.test(f.path))?.path.replace(/\.\w+$/, "") ?? "MyLibrary";
	return libraryFromFiles(firstHeader, files);
}

/**
 * Add `lib` to the student's list, replacing one with the same name. Throws
 * LibraryProblem when the list would get too big for a compile.
 */
export function addLibrary(list: UserLibrary[], lib: UserLibrary): { list: UserLibrary[]; replaced: boolean } {
	const others = list.filter((l) => l.name.toLowerCase() !== lib.name.toLowerCase());
	const replaced = others.length < list.length;
	if (others.length + 1 > MAX_LIBRARIES) throw new LibraryProblem(`You can have up to ${MAX_LIBRARIES} of your own libraries. Remove one first (Library → Manage your libraries).`);
	const next = [...others, lib];
	if (next.reduce((n, l) => n + l.files.length, 0) > MAX_LIBRARY_FILES || next.reduce((n, l) => n + bytesOf(l), 0) > MAX_LIBRARY_BYTES) {
		throw new LibraryProblem(`Your libraries together would be bigger than ${MAX_LIBRARY_BYTES / 1024} KB. Remove one first (Library → Manage your libraries).`);
	}
	return { list: next, replaced };
}

/** Read back what storage holds, dropping anything that is not the right shape. */
export function parseStoredLibraries(raw: string | null): UserLibrary[] {
	if (!raw) return [];
	try {
		const data: unknown = JSON.parse(raw);
		if (!Array.isArray(data)) return [];
		return data.filter((l): l is UserLibrary =>
			typeof l?.name === "string" && typeof l?.header === "string" && Array.isArray(l?.files) &&
			l.files.every((f: unknown) => typeof (f as { path?: unknown })?.path === "string" && typeof (f as { text?: unknown })?.text === "string"));
	} catch {
		return [];
	}
}

export function libraryBytes(lib: UserLibrary): number {
	return bytesOf(lib);
}

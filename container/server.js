/**
 * uploadmycode compile server.
 *
 * Runs inside the Cloudflare Container (see Dockerfile) and, unchanged, on a
 * Windows dev box with tools/arduino-cli on PATH. Node built-ins only, zero npm
 * dependencies, so there is nothing to install or keep up to date.
 *
 *   GET  /health   -> { ok: true }
 *   POST /compile  -> body { "code": "<sketch source>" }
 *                     200 { ok: true,  hex: "<Intel HEX text>" }
 *                     200 { ok: false, stderr: "<compiler errors>" }
 *
 * A failed compile is a normal outcome, not an HTTP error, so it still returns
 * 200. Only malformed requests get a 4xx.
 *
 * One compile runs at a time. arduino-cli spawns a whole avr-gcc toolchain and
 * the instance has a quarter of a vCPU; running two at once just makes both
 * slow. Requests wait their turn in an in-process queue.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/** Uno boards, forever. See PLAN.md. */
const FQBN = "arduino:avr:uno";
/** The container publishes this port; the Worker's Container class targets it. */
const PORT = Number(process.env.PORT) || 8080;
/** Resolved from PATH by default. ARDUINO_CLI is an escape hatch for local runs. */
const ARDUINO_CLI = process.env.ARDUINO_CLI || "arduino-cli";
const COMPILE_TIMEOUT_MS = 30_000;
/** A sketch that reaches this is not a sketch. The Worker caps request size too. */
const MAX_BODY_BYTES = 256 * 1024;
/** Stop collecting compiler output past this; nobody reads 64 KB of errors. */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * The real temp directory, resolved once.
 *
 * On Windows TEMP is often the 8.3 short form (C:\Users\MOCHAR~1\...) while
 * arduino-cli reports the long form in error messages; on Linux /tmp can be a
 * symlink. Either way the two spellings would not match and stripTempPaths()
 * would leave server paths in front of every student's error. realpath.native
 * is the only variant that expands short names, and it is sync-only.
 */
const TEMP_ROOT = (() => {
	try {
		return realpathSync.native(tmpdir());
	} catch {
		return tmpdir();
	}
})();

// ---------------------------------------------------------------- compile queue

/** Tail of the chain of compiles. Every job waits for the one before it. */
let queue = Promise.resolve();

/**
 * Run `job` after every job queued before it, whether those passed or failed.
 * @template T
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
function enqueue(job) {
	const result = queue.then(job, job);
	// Swallow on the chain only. The caller still sees its own rejection.
	queue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

// -------------------------------------------------------------------- compiling

/**
 * Run arduino-cli once. Never rejects: a missing binary or a timeout comes back
 * as a normal result so the caller has one shape to handle.
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runArduinoCli(args) {
	return new Promise((resolve) => {
		// No shell: args are passed as an array, so sketch text can never become
		// part of a command line. On Windows, spawn walks PATH and PATHEXT, which
		// is how "arduino-cli" finds arduino-cli.exe.
		const child = spawn(ARDUINO_CLI, args, { stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, COMPILE_TIMEOUT_MS);

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
		});

		child.on("error", (error) => {
			finish({
				ok: false,
				stdout,
				stderr: `Could not run ${ARDUINO_CLI}: ${error.message}`,
				timedOut: false,
			});
		});
		child.on("close", (code) => {
			finish({ ok: code === 0, stdout, stderr, timedOut });
		});
	});
}

/**
 * Cut the throwaway temp directory out of compiler output so students see
 * "sketch.ino:5:3: error: ..." and not the server's file system.
 * @param {string} text
 * @param {string} root absolute path of the temp directory for this compile
 * @returns {string}
 */
function stripTempPaths(text, root) {
	const sketchDir = path.join(root, "sketch");
	// Longest first, and both separators: gcc echoes paths in whatever form it
	// was handed, which differs between Windows and Linux.
	const prefixes = [
		sketchDir + path.sep,
		toPosix(sketchDir) + "/",
		root + path.sep,
		toPosix(root) + "/",
	];
	let out = text;
	for (const prefix of prefixes) out = out.split(prefix).join("");
	return out.trim();
}

/** @param {string} p */
function toPosix(p) {
	return p.split(path.sep).join("/");
}

/**
 * Compile one sketch. Never rejects.
 * @param {string} code
 * @returns {Promise<{ ok: true, hex: string } | { ok: false, stderr: string }>}
 */
async function compile(code) {
	// TEMP_ROOT keeps this correct on both platforms; no hardcoded /tmp.
	const root = await mkdtemp(path.join(TEMP_ROOT, "uno-ide-"));
	// arduino-cli requires the sketch folder name to match the .ino file name.
	const sketchDir = path.join(root, "sketch");
	const outDir = path.join(root, "out");

	try {
		await mkdir(sketchDir);
		await writeFile(path.join(sketchDir, "sketch.ino"), code, "utf8");

		const result = await runArduinoCli([
			"compile",
			"--fqbn",
			FQBN,
			"--output-dir",
			outDir,
			sketchDir,
		]);

		if (result.timedOut) {
			return {
				ok: false,
				stderr: `Compile timed out after ${COMPILE_TIMEOUT_MS / 1000} seconds.`,
			};
		}
		if (!result.ok) {
			// arduino-cli puts compiler errors on stderr; fall back to stdout so a
			// surprising failure is never reported as an empty message.
			const message = stripTempPaths(result.stderr || result.stdout, root);
			return { ok: false, stderr: message || "Compile failed." };
		}

		try {
			const hex = await readFile(path.join(outDir, "sketch.ino.hex"), "utf8");
			return { ok: true, hex };
		} catch {
			return { ok: false, stderr: "Compile succeeded but produced no hex file." };
		}
	} catch (error) {
		return { ok: false, stderr: `Compile server error: ${String(error)}` };
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

// ------------------------------------------------------------------------ http

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/**
 * Read the whole request body, refusing anything oversized.
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				// Stop reading but leave the socket alive long enough to answer.
				// Destroying here would reach the browser as a network error
				// instead of the 413, and the student would learn nothing.
				req.pause();
				reject(new Error("too-large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * Answer 413 and close. Used both for an oversized Content-Length and for a
 * body that turns out oversized while streaming.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
function rejectTooLarge(req, res) {
	if (res.headersSent) return;
	// The rest of the upload is never read, so this socket cannot be reused.
	res.setHeader("connection", "close");
	res.on("finish", () => req.destroy());
	send(res, 413, { ok: false, stderr: "Sketch is too large." });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCompile(req, res) {
	// Cheap path first: a declared Content-Length lets us answer before reading
	// a single byte, which is the only way the client reliably sees the 413.
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		rejectTooLarge(req, res);
		return;
	}

	let body;
	try {
		body = await readBody(req);
	} catch {
		// Chunked upload, or a lying Content-Length.
		rejectTooLarge(req, res);
		return;
	}

	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		send(res, 400, { ok: false, stderr: "Request body must be JSON." });
		return;
	}
	if (typeof parsed?.code !== "string") {
		send(res, 400, { ok: false, stderr: 'Request body must be {"code": "..."}.' });
		return;
	}

	const started = Date.now();
	const result = await enqueue(() => compile(parsed.code));
	console.log(
		JSON.stringify({ event: "compile", ok: result.ok, ms: Date.now() - started }),
	);
	send(res, 200, result);
}

const server = createServer((req, res) => {
	const route = (req.url || "/").split("?")[0];

	if (route === "/health") {
		send(res, 200, { ok: true });
		return;
	}
	if (route !== "/compile") {
		send(res, 404, { ok: false, stderr: "Unknown route." });
		return;
	}
	if (req.method !== "POST") {
		res.setHeader("allow", "POST");
		send(res, 405, { ok: false, stderr: "Use POST for /compile." });
		return;
	}

	handleCompile(req, res).catch((error) => {
		console.error(JSON.stringify({ event: "error", error: String(error) }));
		if (!res.headersSent) send(res, 500, { ok: false, stderr: "Compile server error." });
		else res.end();
	});
});

// 0.0.0.0, not localhost: the Cloudflare Container reaches this from outside.
server.listen(PORT, "0.0.0.0", () => {
	console.log(JSON.stringify({ event: "listening", port: PORT, fqbn: FQBN }));
});

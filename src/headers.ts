/**
 * The two things that happen to every request and every response here.
 *
 *   1. Plain http is answered with a 301 to the same address on https, so a
 *      student who types "uploadmycode.com" never sends a class phrase over a
 *      link the school's network can read. The zone's "Always Use HTTPS"
 *      setting does the same job one layer earlier; this is the belt to that
 *      pair of suspenders, and it keeps working if the setting is ever lost.
 *   2. Every response, static file included, is stamped with the security
 *      headers below.
 *
 * Kept apart from worker.ts so `node --test` can run both halves with no
 * container runtime, and so there is one file to read when somebody asks what
 * this site sends.
 */

/**
 * What sort of answer this is, which decides two headers and nothing else:
 *
 *   "html"  — gets the Content-Security-Policy.
 *   "json"  — an /api/* answer: gets `Cache-Control: no-store` and no CSP.
 *             A class phrase and a compiled sketch have no business in a
 *             shared cache or a Chromebook's disk.
 *   "asset" — anything the static asset server returned. Its content-type
 *             decides: an HTML file is treated as "html", a stylesheet, a
 *             script, an icon or a 404 gets the common headers only.
 */
export type ResponseKind = "html" | "json" | "asset";

/** One year, subdomains included. */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

/**
 * `serial=(self)` is load-bearing: Web Serial is how Upload and the serial
 * monitor talk to the Uno, and a Permissions-Policy that omits it turns both
 * into a permission error with no message a student could act on. Everything
 * else this site never asks for is switched off by name.
 */
export const PERMISSIONS_POLICY =
	"serial=(self), usb=(), camera=(), microphone=(), geolocation=(), payment=()";

/**
 * The policy for HTML.
 *
 * `script-src 'self'` is strict on purpose: there is not one inline script left
 * in the site (teacher.js and serial-test.js were pulled out of their pages for
 * exactly this), so nothing needs 'unsafe-inline' and nothing needs a nonce.
 *
 * `style-src` keeps 'unsafe-inline' and that is the one loose thread. CodeMirror
 * styles itself by building a <style> element at runtime (style-mod, reached
 * through EditorView.theme in web/src/editor.ts), and teacher.html and
 * serial-test.html each carry their own <style> block so they keep working with
 * no build step. CodeMirror can take a nonce (the EditorView.cspNonce facet),
 * but a nonce has to be minted per response and written into the HTML, which
 * means rewriting every HTML file on every request and giving up the asset
 * cache. Not worth it for style, which cannot fetch or execute anything. Scripts
 * are where injection would matter, and scripts are strict.
 *
 * `worker-src 'none'`: nothing here starts a Worker, a SharedWorker or a
 * service worker. Checked against web/src and the CodeMirror packages.
 * `connect-src 'self'` covers the only two calls the site makes, /api/compile
 * and /api/teacher/phrase. `img-src` needs `data:` for inline icons; fonts are
 * system fonts, so `font-src 'self'` costs nothing.
 */
export const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"manifest-src 'self'",
	"worker-src 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"upgrade-insecure-requests",
].join("; ");

/** Stamped on every response, whatever it is. */
const COMMON_HEADERS: ReadonlyArray<readonly [string, string]> = [
	["strict-transport-security", STRICT_TRANSPORT_SECURITY],
	["x-content-type-options", "nosniff"],
	["x-frame-options", "DENY"],
	["referrer-policy", "strict-origin-when-cross-origin"],
	["permissions-policy", PERMISSIONS_POLICY],
	["cross-origin-opener-policy", "same-origin"],
	// An internal district tool. web/public/robots.txt says the same thing to
	// crawlers that read it; this says it to the ones that do not.
	["x-robots-tag", "noindex, nofollow"],
];

/** True for `text/html`, with or without a charset. */
function isHtml(response: Response): boolean {
	const type = response.headers.get("content-type") ?? "";
	return type.split(";")[0].trim().toLowerCase() === "text/html";
}

/**
 * Return the same response carrying the security headers.
 *
 * The headers are copied first. A response from the static asset binding has
 * immutable headers, so `response.headers.set(...)` on it throws; building a new
 * Response around the same body is the supported way round that, and it keeps
 * the status, the status text and every header the original had.
 */
export function withSecurityHeaders(response: Response, kind: ResponseKind): Response {
	const copy = new Response(response.body, response);

	for (const [name, value] of COMMON_HEADERS) copy.headers.set(name, value);

	if (kind === "json") copy.headers.set("cache-control", "no-store");
	if (kind === "html" || (kind === "asset" && isHtml(copy))) {
		copy.headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
	}

	return copy;
}

/**
 * The https address to send an http request to, or null when the request is
 * already secure and may be answered normally.
 *
 * Pure, so it can be tested without a Worker.
 *
 * Two details worth the words:
 *
 *   - localhost is left alone. `wrangler dev` serves this Worker over plain
 *     http on 127.0.0.1, and a redirect there would send the one person who
 *     maintains this site to a port that speaks no TLS. Browsers already treat
 *     localhost as a secure context, so nothing is lost.
 *   - the port is dropped. Cloudflare answers plain http on 80 and on a handful
 *     of alternates (8080, 8880, 2052 ...) that do NOT serve https, so keeping
 *     the port would redirect a student to a door that does not open. The site
 *     is only ever served on 443.
 */
export function httpsRedirectTarget(requestUrl: string): string | null {
	const url = new URL(requestUrl);
	if (url.protocol !== "http:") return null;
	if (isLocal(url.hostname)) return null;

	url.protocol = "https:";
	url.port = "";
	return url.toString();
}

function isLocal(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "127.0.0.1" ||
		host === "[::1]" ||
		host === "::1"
	);
}

/**
 * The 301 to send instead of answering an http request, or null to carry on.
 *
 * 301 and not 302: this is permanent, and a permanent redirect is what lets a
 * browser stop asking over plain http at all.
 */
export function httpsRedirect(requestUrl: string): Response | null {
	const target = httpsRedirectTarget(requestUrl);
	if (target === null) return null;

	return withSecurityHeaders(
		new Response(null, { status: 301, headers: { location: target } }),
		"asset",
	);
}

/**
 * The https redirect and the security headers.
 *
 * Run with `npm test`. Node runs src/headers.ts directly (it strips the types),
 * so what is tested here is the exact file the Worker bundles.
 *
 * Two promises are worth naming, because breaking either one breaks the site
 * rather than merely loosening it:
 *
 *   - `serial=(self)` stays in the Permissions-Policy. Without it Upload and the
 *     serial monitor cannot open the Uno.
 *   - `style-src` keeps 'unsafe-inline'. CodeMirror builds a <style> element at
 *     runtime, so a strict style-src leaves the editor unpainted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CONTENT_SECURITY_POLICY,
	httpsRedirect,
	httpsRedirectTarget,
	PERMISSIONS_POLICY,
	STRICT_TRANSPORT_SECURITY,
	withSecurityHeaders,
} from "../src/headers.ts";

// ------------------------------------------------------------ https redirect

test("plain http redirects to the same address on https", () => {
	assert.equal(
		httpsRedirectTarget("http://uploadmycode.com/teacher.html"),
		"https://uploadmycode.com/teacher.html",
	);
});

test("the path and the query survive the redirect", () => {
	assert.equal(
		httpsRedirectTarget("http://uploadmycode.com/a/b?x=1&y=two%20words"),
		"https://uploadmycode.com/a/b?x=1&y=two%20words",
	);
	assert.equal(httpsRedirectTarget("http://uploadmycode.com/"), "https://uploadmycode.com/");
	assert.equal(
		httpsRedirectTarget("http://www.uploadmycode.com/api/compile"),
		"https://www.uploadmycode.com/api/compile",
	);
});

test("an https request is left alone", () => {
	assert.equal(httpsRedirectTarget("https://uploadmycode.com/"), null);
	assert.equal(httpsRedirectTarget("https://uploadmycode.com/api/compile?a=1"), null);
});

test("localhost is left alone so wrangler dev still works", () => {
	assert.equal(httpsRedirectTarget("http://localhost:8787/"), null);
	assert.equal(httpsRedirectTarget("http://127.0.0.1:8787/api/compile"), null);
	assert.equal(httpsRedirectTarget("http://[::1]:8787/"), null);
	assert.equal(httpsRedirectTarget("http://LOCALHOST:8787/"), null);
});

test("an alternate http port is dropped, not carried to https", () => {
	// Cloudflare serves plain http on 8080 and https on 443. Keeping the port
	// would send a student to a door that does not open.
	assert.equal(httpsRedirectTarget("http://uploadmycode.com:8080/"), "https://uploadmycode.com/");
});

test("the redirect response is a 301 with a location and no body", async () => {
	const response = httpsRedirect("http://uploadmycode.com/teacher.html");
	assert.notEqual(response, null);
	assert.equal(response.status, 301);
	assert.equal(response.headers.get("location"), "https://uploadmycode.com/teacher.html");
	assert.equal(await response.text(), "");
	// Even the refusal carries the common headers.
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("no redirect response at all for an https request", () => {
	assert.equal(httpsRedirect("https://uploadmycode.com/"), null);
});

// ---------------------------------------------------------- security headers

/** Every response gets these, whatever kind it is. */
function assertCommonHeaders(response) {
	assert.equal(response.headers.get("strict-transport-security"), STRICT_TRANSPORT_SECURITY);
	assert.equal(
		response.headers.get("strict-transport-security"),
		"max-age=31536000; includeSubDomains",
	);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("x-frame-options"), "DENY");
	assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
	assert.equal(response.headers.get("permissions-policy"), PERMISSIONS_POLICY);
	assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
	assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
}

test("an HTML response gets the CSP and all the common headers", () => {
	const source = new Response("<!doctype html><title>x</title>", {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
	const response = withSecurityHeaders(source, "html");

	assertCommonHeaders(response);
	assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
});

test("a JSON response gets no-store and no CSP", () => {
	const source = new Response(JSON.stringify({ ok: true }), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
	const response = withSecurityHeaders(source, "json");

	assertCommonHeaders(response);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("content-security-policy"), null);
});

test("an HTML response is not marked no-store", () => {
	const source = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
	assert.equal(withSecurityHeaders(source, "html").headers.get("cache-control"), null);
});

test("an asset gets the CSP only when it is HTML", () => {
	const page = withSecurityHeaders(
		new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
		"asset",
	);
	assert.equal(page.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);

	const quiet = [
		"text/javascript",
		"text/css",
		"image/png",
		"image/svg+xml",
		"text/plain",
		"application/manifest+json",
	];
	for (const type of quiet) {
		const asset = withSecurityHeaders(
			new Response("x", { headers: { "content-type": type } }),
			"asset",
		);
		assertCommonHeaders(asset);
		assert.equal(asset.headers.get("content-security-policy"), null, type);
		assert.equal(asset.headers.get("cache-control"), null, type);
	}
});

test("a response with no content-type of its own is not treated as HTML", () => {
	const response = withSecurityHeaders(new Response("x"), "asset");
	// A string body makes the Response text/plain, not text/html.
	assert.equal(response.headers.get("content-security-policy"), null);
	assertCommonHeaders(response);
});

test("the body, the status and the existing headers all survive", async () => {
	const source = new Response("hello", {
		status: 429,
		statusText: "Too Many Requests",
		headers: { "content-type": "application/json; charset=utf-8", "retry-after": "900" },
	});
	const response = withSecurityHeaders(source, "json");

	assert.equal(response.status, 429);
	assert.equal(response.statusText, "Too Many Requests");
	assert.equal(response.headers.get("retry-after"), "900");
	assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
	assert.equal(await response.text(), "hello");
});

test("a 304 with no body survives being stamped", () => {
	const response = withSecurityHeaders(new Response(null, { status: 304 }), "asset");
	assert.equal(response.status, 304);
	assert.equal(response.body, null);
	assertCommonHeaders(response);
});

// ------------------------------------------------- the two load-bearing rules

test("Web Serial stays allowed for this site and nothing else is", () => {
	assert.equal(
		PERMISSIONS_POLICY,
		"serial=(self), usb=(), camera=(), microphone=(), geolocation=(), payment=()",
	);
	assert.match(PERMISSIONS_POLICY, /(^|[ ,])serial=\(self\)/);
});

test("the CSP is strict about script and deliberately loose about style", () => {
	const directives = new Map(
		CONTENT_SECURITY_POLICY.split("; ").map((part) => {
			const [name, ...values] = part.split(" ");
			return [name, values.join(" ")];
		}),
	);

	// No inline script anywhere on the site, so no excuse for either of these.
	assert.equal(directives.get("script-src"), "'self'");
	assert.ok(!CONTENT_SECURITY_POLICY.includes("unsafe-eval"));

	// CodeMirror injects a <style> element at runtime; see src/headers.ts.
	assert.equal(directives.get("style-src"), "'self' 'unsafe-inline'");

	assert.equal(directives.get("default-src"), "'self'");
	assert.equal(directives.get("connect-src"), "'self'");
	assert.equal(directives.get("img-src"), "'self' data:");
	assert.equal(directives.get("font-src"), "'self'");
	assert.equal(directives.get("manifest-src"), "'self'");
	assert.equal(directives.get("worker-src"), "'none'");
	assert.equal(directives.get("object-src"), "'none'");
	assert.equal(directives.get("base-uri"), "'self'");
	assert.equal(directives.get("form-action"), "'self'");
	assert.equal(directives.get("frame-ancestors"), "'none'");
	assert.ok(directives.has("upgrade-insecure-requests"));
});

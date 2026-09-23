/*
 * Stamp data-theme="light" or "dark" on <html> before the page first paints.
 *
 * A classic script loaded from <head>, not part of the module bundle: modules
 * run after the first paint, and a student who picked Light on a dark
 * Chromebook would see a flash of dark every load. It is a file rather than an
 * inline script because the CSP is script-src 'self'.
 *
 * style.css reads only the attribute, never prefers-color-scheme, so this is
 * where "System" is resolved. src/theme.ts owns the button and keeps the
 * attribute in step afterwards; the key and the resolve rule below must match
 * the ones there.
 */
(function () {
	var pref = null;
	try {
		pref = window.localStorage.getItem("uno-ide.v1.theme");
	} catch (e) {
		// Site data blocked: fall through to System.
	}
	var dark =
		pref === "dark" ||
		(pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();

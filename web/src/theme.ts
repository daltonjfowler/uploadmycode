/**
 * The theme button: System, Light, Dark, and round again.
 *
 * public/theme-boot.js has already stamped data-theme on <html> before the
 * first paint. This module owns the button, remembers the choice, and keeps the
 * attribute right afterwards — including when the student is on System and
 * flips their Chromebook between light and dark while the page is open.
 *
 * style.css and the plotter read only the attribute, so they never need to
 * know whether it came from a choice or from the system.
 */

import { loadThemePreference, saveThemePreference, type ThemePreference } from "./storage.ts";

const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

const LABELS: Record<ThemePreference, string> = {
	system: "🖥️ System",
	light: "☀️ Light",
	dark: "🌙 Dark",
};

const NAMES: Record<ThemePreference, string> = {
	system: "System",
	light: "Light",
	dark: "Dark",
};

export function initThemeButton(button: HTMLButtonElement): void {
	const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
	let preference = loadThemePreference();

	function apply(): void {
		// Same rule as theme-boot.js.
		const dark = preference === "dark" || (preference === "system" && darkQuery.matches);
		document.documentElement.dataset.theme = dark ? "dark" : "light";

		const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
		button.textContent = LABELS[preference];
		button.title = `Theme: ${NAMES[preference]}. Click for ${NAMES[next]}.`;
		button.setAttribute("aria-label", `Theme: ${NAMES[preference]}. Click for ${NAMES[next]}.`);
	}

	button.addEventListener("click", () => {
		preference = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
		saveThemePreference(preference);
		apply();
	});

	// Only matters on System; apply() ignores the query otherwise.
	darkQuery.addEventListener("change", apply);

	apply();
}

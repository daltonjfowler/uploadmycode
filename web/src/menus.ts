/**
 * The toolbar's two drop-down menus, File and Settings.
 *
 * Both are plain popovers (the `popover` attribute, opened by a
 * `popovertarget` button), so the browser already does the hard parts: one
 * open at a time, click-away and Escape to close, and drawing above
 * everything. This module does the three things it does not: hang the menu
 * under its button, mark the button while its menu is open, and close File the
 * moment one of its items is picked.
 *
 * The items themselves are wired in main.ts by id, the same as when they were
 * loose toolbar buttons.
 */

export function initMenus(): void {
	const menus = [...document.querySelectorAll<HTMLElement>(".menu[popover]")];

	for (const menu of menus) {
		const button = document.querySelector<HTMLElement>(`[popovertarget="${menu.id}"]`);
		if (!button) continue;

		// beforetoggle runs before the menu is drawn, so it never flashes in the
		// middle of the screen where the browser would put it on its own.
		menu.addEventListener("beforetoggle", (event) => {
			const open = event.newState === "open";
			button.setAttribute("aria-expanded", String(open));
			if (!open) return;
			const rect = button.getBoundingClientRect();
			menu.style.top = `${rect.bottom + 4}px`;
			if (menu.dataset.align === "end") {
				menu.style.left = "auto";
				menu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
			} else {
				menu.style.right = "auto";
				menu.style.left = `${rect.left}px`;
			}
		});
		button.setAttribute("aria-expanded", "false");

		if ("closeOnPick" in menu.dataset) {
			// Capture, so the menu is gone before the item's own handler runs:
			// Rename and Delete open a dialog, and the menu should not sit behind it.
			menu.addEventListener(
				"click",
				(event) => {
					if (event.target instanceof Element && event.target.closest("button")) menu.hidePopover();
				},
				{ capture: true },
			);
		}
	}

	// A menu left open while the window changes size would float away from its
	// button, so it closes instead.
	window.addEventListener("resize", () => {
		for (const menu of menus) if (menu.matches(":popover-open")) menu.hidePopover();
	});
}

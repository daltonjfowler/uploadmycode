import { defineConfig } from "vite";

/**
 * Vite config for the editor frontend.
 *
 * Run it as `vite --root web` (see the npm scripts) so this file, index.html and
 * public/ are all found under web/ while the build output lands in the repo's
 * public/ directory, which is what wrangler.jsonc serves as static assets.
 */
export default defineConfig({
	build: {
		// Relative to root (web/), so this is <repo>/public — the assets directory
		// in wrangler.jsonc. Committed, because `wrangler deploy` only uploads it.
		outDir: "../public",
		// Required: the directory is outside the Vite root, so Vite refuses to
		// clear it unless we say so. Everything in public/ is build output.
		emptyOutDir: true,
		// Chromebooks are the target and they are slow, but they run current
		// Chrome. Default browser targets are fine; keep the sourcemap off so the
		// deployed asset payload stays small.
		sourcemap: false,
	},
	server: {
		// `npm run dev:web` serves the editor; the compile API comes from the
		// local container server (see README, "Running the compile server without
		// Docker"), which listens on 8080 and routes /compile and /format, not
		// /api/compile and /api/format. Neither goes through the Worker in dev, so
		// no class phrase is asked for locally.
		proxy: {
			"/api/compile": {
				target: "http://localhost:8080",
				changeOrigin: false,
				rewrite: () => "/compile",
			},
			// Auto indent. Needs clang-format on PATH for the local server to
			// answer; without it the button reports that it is not available.
			"/api/format": {
				target: "http://localhost:8080",
				changeOrigin: false,
				rewrite: () => "/format",
			},
		},
	},
});

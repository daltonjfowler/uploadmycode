// Backstop for the compilers' sleep clock (same fix as uploadmylaser src/idle-cap.ts, 2026-11-13, and
// uploadmymodel src/idle-cap.js; Dalton 2026-11-16: "all sites should have it").
//
// @cloudflare/containers will not let a container sleep while it counts a request as in flight, and it
// only stops counting once that response body has finished streaming. A body nobody finishes reading,
// or a compiler that never answers, keeps the count above zero forever, so `sleepAfter` never fires.
// That held the laser and model containers awake for hours in November 2026.
//
// The rule here does not trust that count: if nothing has happened for IDLE_CAP_MS, stop the
// container (SIGTERM; container/server.js exits within 2 s), and SIGKILL it if it is still up
// KILL_AFTER_MS later. "Something happened" is a compile or format ARRIVING or ANSWERING: compiles wait
// in line inside the container (server.js enqueue), so a long line goes quiet on arrivals while it
// drains, but it answers at least once per COMPILE_TIMEOUT_MS. The container keeps nothing between
// requests (only a build cache that a cold start rebuilds), so stopping it loses nothing.

/** The longest one compile may run (container/server.js COMPILE_TIMEOUT_MS: ESP32 180 s, UNO 60 s). */
export const LONGEST_COMPILE_MS = 180_000;
export const SLEEP_AFTER_MS = 5 * 60_000; // `sleepAfter = "5m"` on both containers
export const IDLE_CAP_MS = 15 * 60_000;
/** SIGTERM had this long and the container is still up: SIGKILL. Only fires on a real hang. */
export const KILL_AFTER_MS = 60_000;

export type IdleCapAction = "none" | "stop" | "kill";

export function idleCapReached(now: number, lastActivityAt: number, running: boolean): boolean {
	return running && now - lastActivityAt >= IDLE_CAP_MS;
}

/** What the alarm should do. `stopSentAt`: when the cap last sent SIGTERM, null if it has not since the
 *  last activity. */
export function idleCapAction(now: number, lastActivityAt: number, running: boolean, stopSentAt: number | null): IdleCapAction {
	if (!idleCapReached(now, lastActivityAt, running)) return "none";
	const sent = stopSentAt !== null && stopSentAt >= lastActivityAt;
	if (!sent) return "stop";
	return now - stopSentAt >= KILL_AFTER_MS ? "kill" : "none";
}

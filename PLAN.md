# PLAN.md — uploadmycode

Browser Arduino IDE for district Chromebooks. Students open a website, write a sketch, click
**Compile** (server-side `arduino-cli` running in a Cloudflare Container), click **Upload**
(browser flashes the Uno over USB via the Web Serial API). No installs on Chromebooks. Arduino
Uno only. Built and paid for by one teacher; costs must stay small and capped.

This file is the single source of truth for the worker team. Read it fully before touching code.

---

## Status (2026-09-02)

T0–T5 built, tested, committed, and deployed to https://uploadmycode.com. Remaining are the hardware gates only Dalton can run (`docs/T3-TEST.md`, `docs/T4-TEST.md`), the browser click-throughs (`docs/T2-TEST.md`), and the district IT checklist (`docs/CHROMEBOOK-CHECKLIST.md`). T6 was dropped: Tinkercad Circuits covers simulation.

---

## Locked decisions (do not relitigate)

| Decision | Value |
|---|---|
| Board | Arduino Uno ONLY. FQBN `arduino:avr:uno` hardcoded server-side. No board picker. |
| Hosting | One Cloudflare Worker project: static assets (frontend) + `/api/*` routes + one Container (compile). |
| Compile | `arduino-cli` (pinned version) inside a Cloudflare Container. Never in the browser, never WASM. |
| Upload | Web Serial API + STK500v1 (Optiboot bootloader, 115200 baud). Vendored minimal flasher, no heavyweight flashing dependency. |
| Frontend | Vite + vanilla TypeScript + CodeMirror 6. No React, no UI framework. Chromebooks are slow; keep the bundle small. |
| Auth | Rolling class phrase: teacher sets today's phrase (with an expiry) from a `/teacher` page guarded by a `TEACHER_KEY` secret; the Worker checks it on every compile from KV. Students enter it once per tab (`sessionStorage`). Optional school-IP allowlist. No student accounts, no PII stored. Spec in T5. |
| Sketch storage | Browser `localStorage` + download/upload of `.ino` files. No server-side storage in MVP. |
| Libraries | Fixed allowlist baked into the container image. Adding a library = edit Dockerfile, redeploy. Start: `Servo`, `LiquidCrystal`. |
| Cost caps | `max_instances: 1` (raise to 2 only if a real class saturates it), `instance_type: "basic"`, request body cap 100 KB, 6 compiles/min per browser client id + global ceiling 120/min (never per IP: the school shares one), compile timeout 30 s. |

## Architecture

```
Chromebook browser                         Cloudflare
┌─────────────────────────┐               ┌──────────────────────────────┐
│ CodeMirror editor       │  POST         │ Worker                       │
│ localStorage sketches   │  /api/compile │  - class-code check          │
│ Intel HEX parser        │──────────────▶│  - rate limit + size cap     │
│ STK500v1 flasher        │               │  - route to Container (DO)   │
│ serial monitor          │◀──────────────│ Container: arduino-cli       │
└───────────┬─────────────┘  {hex|errors} │  avr core + libs preinstalled│
            │ Web Serial (USB)            └──────────────────────────────┘
            ▼
       Arduino Uno (Optiboot, STK500v1 @ 115200)
```

- Compile round trip: 1–4 s warm. First compile after idle pays a container cold start (roughly 5–15 s); teacher can hit Compile once before class to warm it.
- Upload: browser parses the returned Intel HEX, toggles DTR to reset the Uno into the bootloader, then programs 128-byte flash pages over STK500v1. Blink uploads in ~1–2 s; a full 32 KB sketch in under 10 s.
- Serial monitor uses the same Web Serial port (default 9600 baud) and must release the reader cleanly before an upload takes the port.

## Verified platform facts (checked 2026-08-31 against Cloudflare docs)

- Containers require the Workers Paid plan ($5 USD/month). Included monthly usage: 375 vCPU-minutes, 25 GiB-hours memory, 200 GB-hours disk. Overage: $0.000020/vCPU-second, $0.0000025/GiB-second memory. CPU is billed on ACTIVE usage only; memory/disk on provisioned resources while the instance is awake. Containers scale to zero after idle timeout.
- Instance types: `lite` (1/16 vCPU, 256 MiB), `basic` (1/4 vCPU, 1 GiB), `standard-2` (1 vCPU, 6 GiB). Start with `basic`; if compiles feel slow in T1, measure before bumping (bigger instance = more provisioned memory billed while awake).
- Wrangler config: `containers: [{ class_name, image: "./Dockerfile", instance_type, max_instances }]` + a `durable_objects` binding with the same `class_name` + a `migrations` entry using `new_sqlite_classes`. `max_instances` counts actively RUNNING instances and requests beyond it error — surface that to students as "compiler busy, try again in a few seconds".
- Container image must build for `linux/amd64`.

## Machine + account status (updated 2026-09-01, by the lead)

- Windows 11, PowerShell. Node v24.19.0, npm 11.17.0.
- wrangler 4.127.1 authenticated (OAuth, daltonjfowler@gmail.com, account `8a77f2d8ecd25793e3a979cef8ac2646`). Use `npx wrangler`.
- **Workers Paid is active** on the account (confirmed by Dalton and by a clean container deploy).
- **Docker Desktop 4.88.1 works** (WSL2 backend, engine 29.7.2). `docker` is on PATH in fresh shells. If the engine is down, start `C:UsersMo CharaAppDataLocalProgramsDockerDesktopDocker Desktop.exe` and wait ~10 s.
- **Container is deployed and live.** `POST https://uploadmycode.com/api/compile` compiles Blink: cold start ~16 s, warm ~0.8 s. Measured 2026-09-01 by the lead. Blocker B1 is cleared.
- `npx wrangler deploy` is allowed for T3–T5 workers; it rebuilds the image (cached layers, ~1 min when the Dockerfile is unchanged) and re-uploads assets. Build `public/` from `web/` before deploying.
- Domain `uploadmycode.com` is registered at Cloudflare Registrar on this account (2026-09-01). The lead attaches it as a custom domain; it becomes the final origin for the Chromebook checklist.
- Local gates still run against `node container/server.js` + `tools/` arduino-cli (README recipe) when a full deploy is not needed.

## Risk spikes — resolve before or during T0

1. **District Chrome policy may block Web Serial.** Managed Chromebooks can have `DefaultSerialGuardSetting` set to block. This is the go/no-go risk for the whole project. Dalton asks district IT to allow serial for the site origin (or leave the default ask-per-use prompt) and tests on a REAL managed student Chromebook with a REAL Uno before T2 begins. T0 ships `docs/CHROMEBOOK-CHECKLIST.md` for exactly this conversation.
2. **Clone Unos.** Boards with CH340 USB chips work on ChromeOS without drivers, but verify with the actual classroom hardware. Genuine Uno R3 (VID 0x2341) and CH340 clones (VID 0x1A86) both need to pass the T3 gate.
3. **Cold start each period.** Measured 16 s on the live container (2026-09-01). If painful, add a teacher "warm up" button (a no-op compile). Do NOT add a scheduled keep-alive ping without Dalton's sign-off — it keeps billing awake.

## Ground rules for worker sessions (Opus 4.8)

- **One task per session, in order. Do the task, run the gate, report gate output verbatim, stop.** Do not start the next task. Do not fan out subagents.
- Ask nothing that this file already answers.
- No dependencies beyond those named in the task without flagging first. Pin every version (arduino-cli, avr core, npm packages, base image).
- Keep code boring, small, and readable. A teacher maintains this alone. No cleverness, no premature abstraction.
- Secrets only via `wrangler secret put`. Never in the repo, never in `wrangler.jsonc`.
- Load the `cloudflare:wrangler` skill before running wrangler commands; `cloudflare:workers-best-practices` before writing Worker code. Prefer current docs over memory.
- Local dev: `wrangler dev` runs the Worker + container together (needs Docker running locally).
- Commit at the end of the task with a message naming the task (e.g. `T1: compile service`).

## Tasks

### T0 — Scaffold and deploy the skeleton
Create the Worker project by hand (no framework template): `wrangler.jsonc` with static assets
binding pointing at `public/`, a placeholder `public/index.html`, `src/worker.ts` serving assets
and stubbing `POST /api/compile` with `501`. Add `package.json`, `tsconfig.json`, `.gitignore`
(already present), and `docs/CHROMEBOOK-CHECKLIST.md` (Web Serial policy questions for district
IT, plus the one-Chromebook/one-Uno smoke test steps). Deploy to workers.dev.
**Gate:** deployed URL returns the placeholder page with HTTP 200; `POST /api/compile` returns 501. Paste both curl outputs.

### T1 — Compile service
`container/Dockerfile`: pinned `debian:bookworm-slim`, install pinned `arduino-cli`, run
`arduino-cli core install arduino:avr` (pin the core version), install the library allowlist,
copy `container/server.js` — Node built-in `http` only, no npm deps. `POST /compile` accepts
`{ code: string }`, writes `sketch/sketch.ino` in a temp dir, runs
`arduino-cli compile --fqbn arduino:avr:uno --output-dir out` with a 30 s timeout, returns
`{ ok: true, hex }` (Intel HEX text) or `{ ok: false, stderr }`. One compile at a time per
instance (simple in-process queue). Wire the Worker route through the Durable Object/container
binding per the verified config shape above. Measure warm compile time on `basic`; note it in the
commit message.
**Gate (local, primary):** `POST http://localhost:<port>/compile` with the Blink sketch returns JSON whose `hex` starts with `:10`; a sketch with a missing semicolon returns `ok: false` with a `sketch.ino:N` error line. Paste both responses (truncate hex). Server runs via `node container/server.js` with the pinned Windows `arduino-cli` from `tools/` on PATH — same code the Dockerfile ships.
**Gate (deploy, best-effort):** attempt `npx wrangler deploy`; on Docker/billing failure, write the exact error to `docs/BLOCKERS.md` and stop the attempt.

### T2 — Editor frontend
Vite + TypeScript in `web/`, built into `public/`. CodeMirror 6 with C++ mode. Features: examples
dropdown (Blink, Button, AnalogReadSerial, Fade, Servo Sweep — classic Arduino built-in examples,
verbatim), named sketches autosaved to `localStorage`, new/rename/delete, download/upload `.ino`,
Compile button calling `/api/compile`, error panel that parses `sketch.ino:LINE:COL: error:` and
highlights the line in the editor. Status states: idle / compiling / success / error / compiler-busy.
**Gate:** in a real Chrome session: Blink compiles green; a deliberate syntax error shows the message AND highlights the correct editor line; reload restores the sketch from localStorage.

### T3 — Upload over Web Serial
Vendor two small modules in `web/src/flash/`: an Intel HEX parser and an STK500v1 programmer
(sync via DTR-toggle reset, `0x30 0x20` get-sync retries, load address, program 128-byte pages,
verify optional, exit bootloader). Port request filters for VID `0x2341` (Arduino) and `0x1A86`
(CH340), with a show-all fallback. Progress bar during flash. Human error messages: no port
chosen, sync failed ("unplug, replug, try again"), port already open elsewhere.
**Gate:** hardware gate, Dalton runs it: from Chrome, Blink flashes onto a real Uno and the LED blinks; then a second upload of Fade succeeds without replugging. Worker session ends by writing exact manual test steps into `docs/T3-TEST.md`.

### T4 — Serial monitor
In-page monitor: open port at selectable baud (default 9600), streaming read with autoscroll,
send-line input, clear button. Monitor must pause and release the reader/port cleanly when an
upload starts, then resume after. Handle unplug mid-session without wedging the UI.
**Gate:** hardware gate, Dalton runs it: a counter-printing sketch streams live; clicking Upload while the monitor is open flashes successfully and the monitor resumes after. Steps appended to `docs/T3-TEST.md`.

### T5 — Hardening, rolling class phrase, cost caps, deploy docs
Goal: only students physically in Dalton's class can compile, with zero student accounts.

**Rolling class phrase.**
- Add a KV namespace binding `CLASS_KV` (create it with wrangler; it is included in Workers Paid).
- `POST /api/teacher/phrase` with header `x-teacher-key` (constant-time compare against the
  `TEACHER_KEY` wrangler secret — a long random string Dalton alone holds). Body
  `{ phrase, ttlSeconds }`; server clamps ttl to 15 min … 12 h, normalizes the phrase (trim,
  lowercase, collapse spaces), writes it to KV key `phrase` with `expirationTtl`. Returns the
  expiry time. `GET /api/teacher/phrase` (same header) shows the current phrase + expiry.
  `DELETE` ends it early.
- `/teacher` static page: teacher key field (remembered in that browser's localStorage), phrase
  field, "generate" button (three random simple words, e.g. `blue-robot-pancake`), duration
  picker (1 period = 90 min, half day, full day), big readable display of the current phrase and
  countdown so it can be shown on the projector.
- `POST /api/compile` requires header `x-class-phrase`. Worker reads KV `phrase`; missing or
  expired → 403 `{ ok: false, error: "No class phrase is active. Ask your teacher." }`; wrong →
  403 `{ ok: false, error: "Wrong class phrase. Ask your teacher for today's phrase." }`.
  Compare after the same normalization, constant time.
- Frontend: on first compile, or on any 403, prompt for the phrase; keep it in `sessionStorage`
  only (dies with the tab). Never localStorage.
- Optional in-person lock: env var `ALLOWED_CIDRS` (comma-separated, from district IT). When set
  and non-empty, compiles whose `cf-connecting-ip` is outside every range → 403 with a message
  saying the site only works from school. Empty by default. Document how to obtain the ranges.

**Other hardening.** Rate limit 6 compiles/min per browser client id (`x-client-id`), plus a global ceiling of 120/min as the bill guard; never per IP, the whole school shares one public IP. Reject bodies
over 100 KB at the Worker (413). Confirm `max_instances: 1` and idle sleep. Add a non-root user
to the container image (T1 security note) and verify the image still builds and compiles.

**Docs.** `docs/DEPLOY.md`: fresh-machine deploy, creating `TEACHER_KEY` and the KV namespace,
daily phrase routine (walk in, set phrase, project it, hit Compile once to warm the container),
adding a library to the allowlist, reading the usage dashboard, setting a Cloudflare billing
notification.

**Gate:** curl compile with no phrase → 403; wrong phrase → 403; teacher sets a phrase with
`ttlSeconds: 60` → correct phrase compiles Blink green; after 70 s the same phrase → 403; teacher
endpoint with a wrong `x-teacher-key` → 403; 7th compile inside a minute → 429 with a friendly
JSON message; 200 KB body → 413. Paste outputs.

### T6 — dropped (2026-09-01)
Simulator, shared sketches, teacher view: not happening. The district already uses Tinkercad
Circuits for simulation, so there is nothing to rebuild. Do not start any of this.

## Cost expectation (estimates, verify against dashboard after first real class)

- Fixed: $5/month Workers Paid.
- One class period: ~30 students × ~20 compiles × ~3 vCPU-s ≈ 30 vCPU-min active CPU, well inside the 375 vCPU-min monthly included quota for occasional use; heavy month maybe a few dollars of overage. Memory: `basic` provisions 1 GiB only while awake.
- Guardrails that keep it boring: scale-to-zero, `max_instances: 1`, rate limit, body cap, billing notification (T5 doc).

## References

- https://developers.cloudflare.com/containers/get-started/
- https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/workers/wrangler/configuration/#containers
- arduino-cli docs: https://arduino.github.io/arduino-cli/
- Web Serial API: https://developer.chrome.com/docs/capabilities/serial

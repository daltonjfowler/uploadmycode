# uploadmycode

A browser IDE for Uno boards, built for Chromebook classrooms. A student writes a sketch on a
website, the sketch compiles on a small server container running `arduino-cli`, and the browser
flashes the resulting hex onto the board over USB with the Web Serial API. Nothing is installed on
the student machine — no IDE, no driver, no extension, no account.

It exists because managed Chromebooks cannot run a desktop IDE, and a class of thirty needs the
same tool on every desk in under a minute.

- Uno boards only. The board type is hardcoded server-side; there is no board picker.
- Runs on Cloudflare Workers + Containers. About $5/month plus pennies of usage for one classroom.
- Written and maintained by one teacher. The code is kept boring on purpose.

## What it does

- **Editor** — CodeMirror 6 with C++ highlighting, autocomplete for the common board API, and a
  library dropdown that inserts the right `#include`.
- **Compile** — one POST to the server. Compiler errors come back parsed: a clickable row that
  jumps to the line, and the offending line highlighted in the editor.
- **Upload** — the browser flashes the board itself over Web Serial (STK500v1 against the Optiboot
  bootloader, 115200 baud), with a page-by-page progress bar. Upload is only enabled for hex that
  was built from the exact text on screen.
- **Serial monitor** — nine baud rates, autoscroll, timestamps, a send box. It hands the port to
  the flasher when an upload starts and takes it back afterwards, so a student never has to
  disconnect anything.
- **Sketches** — named, autosaved to `localStorage`, downloadable and importable as `.ino`. No
  server-side storage, no student accounts, no PII.
- **A rolling class phrase** — the teacher sets today's phrase, with an expiry, from a `/teacher`
  page guarded by a secret. Nobody compiles without it. Students type it once per tab and it dies
  with the tab.
- **Cost caps** — one container instance, scale-to-zero, a per-browser rate limit, a global
  ceiling, a request-size cap and a compile timeout. All of it so a runaway loop cannot run up a
  bill overnight.
- **Libraries** — a fixed allowlist baked into the container image, so a compile never touches the
  network. Servo, LiquidCrystal, LiquidCrystal I2C and Stepper ship by default.

## The live site

<https://uploadmycode.com> is the author's own instance, for one teacher's classes. It is not a
public service: every compile needs that day's class phrase, so the site will look broken to anyone
who is not in the room. It is up here as a working reference, not as something to sign up for.

**To use this, run your own copy.** [docs/SETUP.md](docs/SETUP.md) walks a stranger through it end
to end: the supported Cloudflare path, and how to run just the compile server with Docker.

## Commands

```sh
npm install
npm run typecheck   # tsc --noEmit for the Worker and for web/
npm test            # node --test over test/ (Worker logic) and web/test/ (frontend)
npm run dev:web     # Vite dev server for the editor (proxies /api/compile to localhost:8080)
npm run build       # vite build web -> public/
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run deploy      # npm run build, then wrangler deploy (needs Docker running)
```

`wrangler deploy` builds `container/Dockerfile`, so Docker Desktop must be running.
`npm run dev` (`wrangler dev`) also needs it.

## Running the compile server without Docker

`container/server.js` is the same file the image runs, and it runs directly on Windows. Useful for
frontend work: `npm run dev:web` proxies `/api/compile` to it. Nothing here is committed: `tools/`
is gitignored, and the versions must match the pins at the top of `container/Dockerfile`.

```powershell
$tools = "$PWD\tools"
New-Item -ItemType Directory -Force $tools | Out-Null

# 1. Pinned arduino-cli (same version as the Dockerfile).
Invoke-WebRequest -Uri 'https://github.com/arduino/arduino-cli/releases/download/v1.5.1/arduino-cli_1.5.1_Windows_64bit.zip' -OutFile "$tools\arduino-cli.zip"
Expand-Archive "$tools\arduino-cli.zip" -DestinationPath "$tools\arduino-cli" -Force

# 2. Keep the toolchain inside tools/ instead of AppData.
$env:PATH = "$tools\arduino-cli;$env:PATH"
$env:ARDUINO_DIRECTORIES_DATA = "$tools\arduino-data"
$env:ARDUINO_DIRECTORIES_USER = "$tools\arduino-user"
$env:ARDUINO_DIRECTORIES_DOWNLOADS = "$tools\arduino-downloads"

# 3. Pinned core and the library allowlist (same versions as the Dockerfile).
arduino-cli core update-index
arduino-cli core install arduino:avr@1.8.8
arduino-cli lib install Servo@1.3.0
arduino-cli lib install LiquidCrystal@1.0.7
arduino-cli lib install "LiquidCrystal I2C@1.1.2"
arduino-cli lib install Stepper@1.1.3

# 4. Serve on http://localhost:8080.
node container/server.js
```

On any platform, building `container/` with Docker gets you the same server and none of that
setup: see [docs/SETUP.md](docs/SETUP.md), Part B.

## Docs

- [docs/SETUP.md](docs/SETUP.md) — **run your own copy.** Start here if this repo is new to you.
- [docs/DEPLOY.md](docs/DEPLOY.md) — the operator manual for the author's live instance: the daily
  phrase routine, the teacher key, what guards a compile, adding a library, `ALLOWED_CIDRS`, cost
  caps and billing alerts. Most of it applies to any instance.
- [PLAN.md](PLAN.md) — architecture, the locked decisions, and the task list the project was built
  from. Read it before changing anything structural.
- [docs/CHROMEBOOK-CHECKLIST.md](docs/CHROMEBOOK-CHECKLIST.md) — the Web Serial policy conversation
  to have with school IT before you rely on any of this, plus a one-Chromebook smoke test.
- [docs/T2-TEST.md](docs/T2-TEST.md), [docs/T3-TEST.md](docs/T3-TEST.md),
  [docs/T4-TEST.md](docs/T4-TEST.md) — manual test scripts for the editor, for flashing a real
  board, and for the serial monitor. The last two need hardware.

## Trademarks and licensing

ARDUINO and UNO are trademarks of Arduino SA. This project is not affiliated with, sponsored by, or
endorsed by Arduino SA. "Uno" is used here only to describe which board this software is compatible
with.

This repository contains no Arduino software. The container image downloads Arduino's open-source
toolchain from official sources at build time — `arduino-cli` (GPLv3), and the AVR core and its
compiler toolchain (GPL/LGPL) — and runs it as a separate program, over a command line, exactly as
a user would. Nothing from it is copied into, linked with, or redistributed by this repository. If
you build the image, you obtain those components directly from their publishers under their own
licenses.

The editor is [CodeMirror 6](https://codemirror.net), MIT licensed.

This project's own code is MIT licensed — see [LICENSE](LICENSE).

# uploadmycode

Browser Arduino IDE for district Chromebooks. Students write a sketch on a website, the sketch
compiles on a Cloudflare Container running `arduino-cli`, and the browser flashes the resulting
hex onto an Arduino Uno over USB with the Web Serial API. No installs on student machines.

- Arduino Uno only.
- Hosted on Cloudflare Workers + Containers (Workers Paid plan, $5/month + small usage).
- Internal district tool, not a public service.

**Live:** <https://uploadmycode.com> (fallback: <https://uploadmycode.daltonjfowler.workers.dev>)

**Start here:** [PLAN.md](PLAN.md) — architecture, locked decisions, and the T0–T5 task list for
worker sessions. One task per session, in order, gate must pass before stopping.

**Running it:** [docs/DEPLOY.md](docs/DEPLOY.md) — fresh-machine deploy, the teacher key, the daily
routine, adding a library, the IP lock, and keeping the bill small.

## Daily routine

Nobody can compile without today's class phrase, so the day starts by setting one. Open
<https://uploadmycode.com/teacher.html>, press **Generate**, pick how long it lasts (1 period, half
day, or full day), press **Set phrase**, and project the page or write the phrase on the board.
Then open the editor and click **Compile** once — that wakes the container so the first student pays
a warm compile instead of a 15-second cold start. Students type the phrase once per tab; it lives in
`sessionStorage` and is gone when the tab closes. Press **End now** to shut it off early; otherwise
it expires on its own. Full version, including what each refusal message means:
[docs/DEPLOY.md](docs/DEPLOY.md).

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

## Docs

- [docs/DEPLOY.md](docs/DEPLOY.md) — deploying, the teacher key, the daily phrase routine, adding a library, `ALLOWED_CIDRS`, cost caps and billing alerts.
- [docs/T2-TEST.md](docs/T2-TEST.md) — editor click-through (compile, error highlight, autosave, autocomplete toggle).
- [docs/T3-TEST.md](docs/T3-TEST.md) — flashing a real Uno from Chrome (hardware gate, Dalton runs it); reset-polarity troubleshooting.
- [docs/T4-TEST.md](docs/T4-TEST.md) — serial monitor with a real Uno, including Upload while connected (hardware gate, Dalton runs it).
- [docs/CHROMEBOOK-CHECKLIST.md](docs/CHROMEBOOK-CHECKLIST.md) — district IT Web Serial policy questions and the one-Chromebook/one-Uno smoke test. Go/no-go for the whole project.

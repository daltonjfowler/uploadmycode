# Run your own copy

This repo is one teacher's classroom tool, published so other people can run it. The live site at
<https://uploadmycode.com> is the author's own instance and is locked behind a class phrase, so it
is no use to you — you want your own.

There are two ways in.

- **[Part A — the supported path](#part-a--the-supported-path-cloudflare).** Deploy the whole thing
  to Cloudflare: editor, compile container, class phrase, rate limits. About twenty minutes and
  $5/month. This is the path that is tested and the one the rest of the docs assume.
- **[Part B — the compile server on its own](#part-b--the-compile-server-on-its-own-docker).** Build
  and run just the compiler with Docker, anywhere. Useful for hacking on the frontend, and the
  starting point if you want to host the whole thing somewhere that is not Cloudflare — but read
  what that actually costs you at the end of Part B before you commit to it.

Once you are running, [DEPLOY.md](DEPLOY.md) is the day-to-day manual: the class phrase routine,
what guards a compile, adding a library, cost caps, billing alerts.

---

# Part A — the supported path (Cloudflare)

## A1. What you need first

| | | |
|---|---|---|
| A Cloudflare account | on the **Workers Paid** plan | $5/month. Containers are not on the free plan, and the compiler is a container, so there is no free version of this. Sign up at <https://dash.cloudflare.com>, then Workers & Pages → Plans → Workers Paid. |
| **Node.js 22 or newer** | <https://nodejs.org> | `wrangler` needs ≥ 22. Check with `node --version`. |
| **Docker Desktop** | <https://www.docker.com/products/docker-desktop/> | `wrangler deploy` builds the container image on your machine, so the engine must be running. Check with `docker version` and make sure a **Server** section prints, not just a Client. |
| A browser | Chrome or Edge | Web Serial is a Chromium API. Firefox and Safari can edit and compile but cannot flash a board. |

Nothing is installed globally. `wrangler` comes from `npm install` and is always run through `npx`.

You do **not** need a domain. Cloudflare gives every Worker a free `*.workers.dev` URL, and that
URL is HTTPS, which is all Web Serial requires.

## A2. Get the code

```sh
git clone https://github.com/daltonjfowler/uploadmycode.git
cd uploadmycode
npm install
```

## A3. Log wrangler in

```sh
npx wrangler login
```

A browser window opens; approve it. Then confirm which account you are pointed at:

```sh
npx wrangler whoami
```

Write down the account id it prints. Everything below lands in that account.

## A4. Make `wrangler.jsonc` yours

Open `wrangler.jsonc`. Three things in it belong to the author's account, not yours.

### The KV namespace id — you must replace this

```jsonc
"kv_namespaces": [
  { "binding": "CLASS_KV", "id": "1826452392d7425b96e48aa005f9be77" }
]
```

That id points at a namespace in the author's account. Your deploy cannot write to it. Create your
own:

```sh
npx wrangler kv namespace create CLASS_KV
```

It prints a block containing a new `id`. Put **that** id in `wrangler.jsonc` in place of the one
above, keeping `"binding": "CLASS_KV"` exactly as it is — the Worker looks the binding up by name.

This namespace holds exactly one key, `phrase`, which is today's class phrase and its expiry.

### The custom domain — remove it unless you own one

```jsonc
"routes": [
  { "pattern": "uploadmycode.com", "custom_domain": true },
  { "pattern": "www.uploadmycode.com", "custom_domain": true }
],
```

That is the author's domain. Deploying with it will fail, because you do not own it.

**If you do not have a domain: delete the whole `routes` block.** `"workers_dev": true` is already
set just above it, so your site comes up at

```
https://<worker-name>.<your-subdomain>.workers.dev
```

`<worker-name>` is the `"name"` field in `wrangler.jsonc` (`uploadmycode` unless you change it) and
`<your-subdomain>` is the one Cloudflare assigned your account — it is in the dashboard under
Workers & Pages → your Worker, and `wrangler deploy` prints the finished URL at the end. That URL
is HTTPS and works for everything, class included.

**If you do own a domain on Cloudflare**, replace the two patterns with yours and leave
`custom_domain: true`. Cloudflare issues the certificate; there is nothing else to do. The domain
must already be in the same Cloudflare account. Leave `workers_dev` on as a fallback: if the domain
is ever misconfigured, a class is not stuck.

### The Worker name — optional

`"name": "uploadmycode"` is what the Worker is called in your dashboard and the first label of the
workers.dev URL. Names are scoped to your account, so keeping it collides with nobody. Change it if
you want a different URL; nothing else in the repo depends on it.

If you edit `wrangler.jsonc`, run `npm run types` afterwards to regenerate
`worker-configuration.d.ts`, or `npm run typecheck` may complain about a binding it has not heard
of.

## A5. Set the teacher key

`TEACHER_KEY` is the secret that decides who may set a class phrase. It is not in the repo and must
never be. Make a long random one — this is the only thing standing between a stranger and your
compile bill, so do not pick a word.

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

Copy the output, then:

```sh
npx wrangler secret put TEACHER_KEY
```

Paste it at the prompt. Nothing echoes. Check it landed with `npx wrangler secret list` — names
show, values never do.

Deploying without this is safe but useless: the teacher endpoint refuses everyone until the secret
exists, so no phrase can be set and nobody can compile.

## A6. Deploy

```sh
npm run deploy
```

That is `vite build web` (frontend into `public/`) followed by `wrangler deploy` (Worker, static
assets, and a build of the container image). **The first deploy takes several minutes** — it builds
the whole image: Debian, Node, `arduino-cli`, the AVR core, the libraries, and a warm-up compile.
Later deploys reuse cached layers and take about a minute if the Dockerfile has not changed.

Wrangler prints the deployed URL when it finishes. That is your site.

## A7. First-run check

Five minutes, in this order. Each step fails in a way that tells you which of the steps above went
wrong.

1. **Open the URL.** The editor loads: a toolbar, a code editor with a blank sketch template, an
   Output panel, a collapsed Serial Monitor strip. If you get a 404, the deploy did not finish.
2. **Open `<your-url>/teacher.html`.** Paste the teacher key from A5 into the Teacher key field and
   press **Remember on this machine**, then press **Refresh**. It should answer `no phrase set`
   rather than an error. *An error here means the secret is missing or does not match — redo A5.*
3. **Press Generate, pick a duration, press Set phrase.** The phrase appears in large type with a
   countdown. *A KV error here means the namespace id in A4 is still the author's — redo A4.*
4. **Go back to the editor and press Compile.** It asks for the class phrase; type the one from
   step 3 and press Save. The status pill goes `Compiling…`, then green **`Compiled`**, and the
   output reads `Compiled with no errors.` and a program size. **The first compile after a deploy
   takes about 15 seconds** while the container cold-starts; after that it is about a second.
   *A timeout or "compiler is busy" that never clears means the container did not build or start —
   check `npx wrangler tail` while you press Compile.*
5. **Plug an Uno into the machine and press Upload.** The browser asks which serial port; pick the
   board. The progress bar counts pages and the status pill goes green `Uploaded`. The board's L
   LED starts blinking.

If all five pass, you have a working instance.

## A8. Make it yours

Optional, but the defaults are the author's:

- The footer of the editor (`web/index.html`) and the diagnostics page
  (`web/public/serial-test.html`) say "Internal district tool" and link to the author's site. Edit
  those, then `npm run build` and deploy again.
- `public/` is build output and is committed to the repo, which is what `wrangler deploy` uploads.
  Always `npm run build` after touching anything in `web/`, or you will deploy the old page.
- Icons and the PWA manifest are in `web/public/`. `npm run icons` regenerates the PNG sizes from
  `icon.svg`.

## A9. The daily routine, in one paragraph

Set a phrase before class, project it, press Compile once to wake the container. Students type the
phrase once per tab; it lives in `sessionStorage` and is gone when the tab closes. Press **End now**
to shut it off early, or let the countdown do it. The full version — including what every refusal
message on a student's screen means — is [DEPLOY.md, section 1](DEPLOY.md#1-the-daily-routine).

## A10. Adding a library

Students cannot install libraries; the set is baked into the image, which is what keeps a compile
from ever touching the network. Adding one is: pin a version in `container/Dockerfile`, add an
`arduino-cli lib install` line to the existing chain, add an entry to `web/src/libraries.ts` so it
appears in the editor's dropdown, then redeploy. Step by step, with the exact lines:
[DEPLOY.md, section 5](DEPLOY.md#5-adding-a-library-to-the-allowlist).

## A11. What it actually costs

For one teacher and a few classes a day, this is a $5/month project.

| Line | Amount | Notes |
|---|---|---|
| Workers Paid plan | **$5.00 / month** | Fixed. Required for Containers. Includes the Workers and KV usage this project generates many times over. |
| Container CPU | included, then $0.000020 / vCPU-second | 375 vCPU-minutes included per month. One compile is roughly 1–3 vCPU-seconds. |
| Container memory | included, then $0.0000025 / GiB-second | 25 GiB-hours included. Billed while the instance is **awake**, not only while compiling. |
| Container disk | included, then usage | 200 GB-hours included. |
| Workers requests | included | A class of thirty does not come close. |
| KV | included | One key, read once per compile. |
| **Realistic total** | **$5/month, plus pennies in a heavy month** | |

A class period of 30 students compiling 20 times each at ~3 vCPU-seconds is about 30 vCPU-minutes —
an eighth of the monthly included CPU, for one period. You would need a lot of periods to leave the
included allowance.

The guardrails that keep it that way are all already on: one container instance, `basic` size,
scale-to-zero after 10 minutes idle, 6 compiles a minute per browser, a 120/minute global ceiling, a
100 KB request cap and a 30-second compile timeout. **Do not add a scheduled ping to keep the
container warm** — memory is billed the whole time the instance is awake, so a keep-alive bills all
night. Warming it by hand before class costs one compile.

Set a billing alert on the first day: [DEPLOY.md, section 7](DEPLOY.md#7-cost-and-how-to-keep-it-that-way).

## A12. Optional: deploy from GitHub instead of your laptop

Cloudflare can build and deploy on push, so you do not need Docker or Node locally after the first
time. Worth it if you deploy from a school machine.

1. Push your fork to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings** → **Build** → connect the
   repository.
3. Build command `npm run build`, deploy command `npx wrangler deploy`.
4. Add `TEACHER_KEY` as a **secret** in the Worker's settings if you have not already (a secret set
   with `wrangler secret put` is already there and stays).

Pushes to the chosen branch then build the container image and deploy on Cloudflare's machines.
`npm run deploy` from your laptop keeps working either way.

---

# Part B — the compile server on its own (Docker)

`container/` is a self-contained HTTP compile service. Nothing in it knows about Cloudflare.

## B1. Build and run

```sh
docker build --platform linux/amd64 -t uno-compiler ./container
docker run --rm -p 8080:8080 uno-compiler
```

`--platform linux/amd64` is not optional in the Dockerfile — the AVR toolchain binaries are x86_64.
On an Apple Silicon Mac it will run under emulation and compiles will be slower.

The build downloads pinned, checksum-verified copies of Node, `arduino-cli`, the AVR core and four
libraries, then does a warm-up compile so the first real request is not paying for the core.
Expect several minutes the first time.

On start it prints one line:

```json
{"event":"listening","port":8080,"fqbn":"arduino:avr:uno"}
```

`PORT` is read from the environment and defaults to 8080.

## B2. The HTTP contract

Two routes, and that is the whole surface.

**`GET /health`** → `200 {"ok":true}`

**`POST /compile`**, body `{"code":"<sketch source>"}`:

| Outcome | Status | Body |
|---|---|---|
| Compiled | 200 | `{"ok":true,"hex":"<Intel HEX text>"}` |
| Did not compile | 200 | `{"ok":false,"stderr":"sketch.ino:34:3: error: expected ';' before 'delay'..."}` |
| Not POST | 405 | `{"ok":false,"stderr":"Use POST for /compile."}` |
| Body over 256 KB | 413 | `{"ok":false,"stderr":"Sketch is too large."}` |
| Not JSON, or no `code` string in it | 400 | `{"ok":false,"stderr":"Request body must be JSON."}` |
| Any other path | 404 | `{"ok":false,"stderr":"Unknown route."}` |

**A sketch that does not compile is a 200.** A failed compile is a normal outcome, not an HTTP
error; only a malformed *request* gets a 4xx. Anything reading this API should branch on `ok`, not
on the status code.

Other details worth knowing:

- The board is fixed: `arduino-cli compile --fqbn arduino:avr:uno`. There is no board parameter.
- One compile runs at a time, per container. Requests queue in-process; the toolchain saturates a
  quarter vCPU on its own.
- A compile is killed at 30 seconds and comes back as `ok:false`.
- Server-side temp paths are stripped out of error text before it is returned, so a student sees
  `sketch.ino:34:3`, not a path from inside the container.
- The process runs as an unprivileged user (`uploader`, uid 10001), not root.

Try it:

```sh
curl -s http://localhost:8080/health

curl -s -X POST http://localhost:8080/compile \
  -H "content-type: application/json" \
  -d '{"code":"void setup(){pinMode(LED_BUILTIN,OUTPUT);}\nvoid loop(){digitalWrite(LED_BUILTIN,HIGH);delay(1000);digitalWrite(LED_BUILTIN,LOW);delay(1000);}"}'
```

The second should return `{"ok":true,"hex":":10000000...`.

## B3. What this does *not* give you

Read this before planning a deployment that is not on Cloudflare.

**This container is the compiler and nothing else.** Everything that makes the site safe to point a
class at lives in the Worker layer in `src/`, and that code is written for Cloudflare Workers — it
uses the Workers runtime, KV for the class phrase, and a Durable Object to hold the rate-limit
counters. It does not run on Node. So a fully non-Cloudflare deployment means **you write your own
web server and your own auth in front of this container**, covering at minimum:

- the class phrase, or whatever gate keeps strangers off your compiler,
- rate limiting and a request size cap — this container has a 256 KB body cap and a compile timeout,
  and no other opinion about who is calling it,
- serving the static site,
- HTTPS.

Do not expose `/compile` to the internet unauthenticated. It runs a compiler toolchain on text that
anyone sends it.

**The frontend is a plain static build.** `npm run build` puts the whole editor into `public/` as
HTML, JS and CSS — any web server can host it, and it needs no Node at runtime. Two requirements:

1. It POSTs to **`/api/compile`** on its own origin, so your server has to answer that path and
   forward to this container's `/compile`. That is one line of proxy config; `web/vite.config.ts`
   does exactly this rewrite for local development.
2. **Web Serial needs a secure context.** The Upload button and the serial monitor only exist on
   `https://` or on `http://localhost`. A plain-http server on a LAN address will serve the editor
   and never be able to flash a board.

## B4. Running the server without Docker

`container/server.js` uses Node built-ins only and has no npm dependencies, so it runs directly on
any machine with Node and `arduino-cli` on `PATH`. That is the fastest loop for frontend work:
`npm run dev:web` proxies `/api/compile` straight to it. The Windows recipe, with the pinned
versions, is in the README under "Running the compile server without Docker".

Set `ARDUINO_CLI` to an absolute path if the binary is not on `PATH`.

---

## Where to go next

- [DEPLOY.md](DEPLOY.md) — the operator manual. Written for the author's instance, but sections 1
  and 3 through 8 apply to any instance.
- [CHROMEBOOK-CHECKLIST.md](CHROMEBOOK-CHECKLIST.md) — **read this before you rely on it in a
  school.** Managed Chrome policy can block Web Serial outright, and that decision belongs to
  whoever runs your fleet, not to you. There are questions to ask them and a smoke test that
  produces a yes or a no.
- [../PLAN.md](../PLAN.md) — architecture and the decisions behind it.
- [T2-TEST.md](T2-TEST.md), [T3-TEST.md](T3-TEST.md), [T4-TEST.md](T4-TEST.md) — manual test scripts
  for the editor, for flashing a board, and for the serial monitor.

# Deploying and running uploadmycode

> **New here? Read [SETUP.md](SETUP.md) first.** This file is the operator manual for the author's
> own instance, and it names his URLs throughout. SETUP.md is the one that walks a stranger through
> standing up their own copy. Come back here afterwards: sections 1 and 3 through 8 apply to any
> instance, with your own URL substituted.

Everything an owner of this project needs that is not in the code: how to get it onto Cloudflare
from a bare machine, how the class phrase works day to day, how to add a library, and how to keep
the bill small and boring.

Live: <https://uploadmycode.com> (fallback <https://uploadmycode.daltonjfowler.workers.dev>).
Teacher page: <https://uploadmycode.com/teacher.html>.

---

## 1. The daily routine

Five things, about a minute, before the first student compiles.

1. Open <https://uploadmycode.com/teacher.html>. The teacher key is remembered per browser, so on
   your own laptop the page already knows it.
2. Press **Generate**, or type your own phrase.
3. Pick how long it lasts: 1 period (90 min), half day (4 h), or full day (8 h).
4. Press **Set phrase**. The phrase appears in large type with a countdown. Project that, or write
   it on the board.
5. Open the editor and click **Compile** once. That wakes the container, so the first student pays
   a warm compile (about 1 s) instead of a cold start (about 15 s).

At the end of the day, or any time you want it shut off early, press **End now**. The phrase also
ends by itself when the countdown runs out — that is the point of the expiry, and forgetting to end
it is not a hole.

Students type the phrase once per tab. It lives in `sessionStorage`, so closing the tab forgets it
and a Chromebook that goes back in the cart carries nothing into tomorrow.

**If a student says "it will not compile":** look at the message on their screen. It is one of

| Message | Means |
|---|---|
| No class phrase is active. Ask your teacher. | Nothing is set, or it expired. Set one. |
| Wrong class phrase. Ask your teacher for today's phrase. | Typo, or yesterday's phrase in a tab that was never closed. Retype it. |
| That is a lot of compiles in one minute. Wait N seconds… | That Chromebook has compiled six times in a minute. Wait. |
| The compiler is very busy right now. Wait a minute… | The whole site is at its ceiling of 120 compiles a minute. Rare; wait. |
| That sketch is too big to compile. The limit is 100 KB. | They pasted something enormous. |
| The compiler is busy or starting up. | Cold start, or two compiles landed at once. Wait and retry. |
| uploadmycode only works from school. | The optional IP lock is on and they are off-site (section 6). |

Capital letters and extra spaces do not matter: the phrase is trimmed, lowercased and its spaces
collapsed on both sides before it is compared.

---

## 2. Deploying from a fresh machine

You need: a computer, the repo, a Cloudflare account on the **Workers Paid** plan ($5/month —
Containers require it), and about twenty minutes the first time.

### 2.1 Install the tools

- **Node.js 24 LTS** — <https://nodejs.org>. Check with `node --version`.
- **Docker Desktop** — <https://www.docker.com/products/docker-desktop/>. `wrangler deploy` builds
  `container/Dockerfile`, so the engine must be running. Check with `docker version`; the Server
  section must be there, not just the Client.
- Nothing else is installed globally. `wrangler` comes from `npm install` and is run with `npx`.

### 2.2 Get the code and the dependencies

```powershell
git clone <this repo> uploadmycode
cd uploadmycode
npm install
```

### 2.3 Log wrangler in

```powershell
npx wrangler login
```

A browser opens; approve it for the account that holds the domain. Confirm with:

```powershell
npx wrangler whoami
```

Check the account id it prints against the one the live site is deployed to (it is in the
dashboard URL, and in `npx wrangler deployments list`). If `whoami` shows a different account, you
are about to deploy to the wrong place — stop.

### 2.4 Create the KV namespace (only if this is a brand new account)

The namespace already exists for the live project and its id is in `wrangler.jsonc`. On a new
account — which includes anyone who cloned this repo, because that id is not theirs:

```powershell
npx wrangler kv namespace create CLASS_KV
```

Copy the printed id into the `kv_namespaces` block of `wrangler.jsonc`. See
[SETUP.md, A4](SETUP.md#a4-make-wranglerjsonc-yours) for the other two things in that file that are
specific to this account.

### 2.5 Set the teacher key

See section 3. Deploying without it is safe but useless: the teacher endpoint refuses every request
until the secret exists, so no phrase can be set and nobody can compile.

### 2.6 Deploy

```powershell
npm run deploy
```

That is `vite build web` (frontend into `public/`) followed by `wrangler deploy` (Worker, static
assets, and a build of the container image). The first deploy on a machine builds the whole image
and takes several minutes; later ones reuse cached layers and take about a minute if the Dockerfile
has not changed.

### 2.7 Check it

```powershell
# The editor.
Invoke-WebRequest https://uploadmycode.com/ | Select-Object -ExpandProperty StatusCode

# The teacher page.
Invoke-WebRequest https://uploadmycode.com/teacher.html | Select-Object -ExpandProperty StatusCode

# A compile with no phrase must be refused.
try {
  Invoke-WebRequest -Method POST -Uri https://uploadmycode.com/api/compile `
    -ContentType 'application/json' -Body '{"code":"void setup(){} void loop(){}"}'
} catch { $_.Exception.Response.StatusCode.value__ }   # expect 403
```

Then set a phrase from the teacher page and compile Blink in the editor.

### 2.8 The custom domain

`uploadmycode.com` and `www.uploadmycode.com` are attached as custom domains in `wrangler.jsonc`
`routes`. Cloudflare issues the certificate; nothing to do by hand. `workers.dev` stays enabled as a
fallback, which is worth keeping: if the domain is ever misconfigured the class is not stuck.

---

## 3. The teacher key

`TEACHER_KEY` is a Worker **secret**. It is the one thing that decides who may set a class phrase.
It is never in the repo, never in `wrangler.jsonc`, and never in a doc.

### Create or rotate it

```powershell
# Generate a long random key and put it on the clipboard.
$key = -join ((48..57) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$key | Set-Clipboard

# Upload it. Paste at the prompt.
npx wrangler secret put TEACHER_KEY
```

Then open `/teacher.html`, paste the key, press **Remember on this machine**, and press
**Refresh** — it should answer without an error.

Rotating is the same command; the new value replaces the old one the moment the upload finishes.
Rotate if you ever type the key on a student machine, if it lands in a screenshot, or if it goes
into a chat message.

Anyone with the key can set a phrase. Nobody with the key can read student data, because there is
none — no accounts, no server-side sketches, nothing but one KV key holding today's phrase.

### Local development

`wrangler dev` reads the gitignored `.dev.vars` file:

```
TEACHER_KEY=some-long-random-string
ALLOWED_CIDRS=
```

`.dev.vars` is in `.gitignore`. Keep it that way. `wrangler types` also reads it, which is how
`TEACHER_KEY` ends up in the generated `Env` type.

### Checking what is set

```powershell
npx wrangler secret list
```

Values are never shown, only names. If `TEACHER_KEY` is missing from that list, the teacher endpoint
is refusing everyone and the Worker log says so.

---

## 4. What actually guards a compile

`POST /api/compile` runs five checks before it will hand anything to the container. The order is
the design, and it lives in one file, `src/compile-gate.ts`:

1. **Size.** Over 100 KB → 413. Answered from `Content-Length` before the body is read where
   possible, and re-checked against the real byte count after, so a chunked upload cannot slip past.
2. **School IP lock.** Off unless `ALLOWED_CIDRS` is set (section 6).
3. **Class phrase.** Read from KV, compared in constant time after both sides are normalized.
   Missing or expired → 403 "No class phrase is active"; wrong → 403 "Wrong class phrase". A wrong
   phrase is *only ever* a 403: never counted, never delayed, never a lockout (section 4a).
4. **Per-client rate limit.** Six compiles a minute for the `x-client-id` the browser sends,
   counted in the container's Durable Object, with a `Retry-After` header on the 429. It runs
   after the phrase check on purpose, so wrong guesses can never spend anybody's compiles.
5. **Global ceiling.** 120 compile requests a minute across everyone → 429. The bill guard.

Only after all five is the container touched.

A phrase is valid only while `Date.now() < expiresAt`. KV's own `expirationTtl` is set as well, but
a KV read can be served from a per-location cache for up to 60 seconds, so the Worker never trusts
the key's absence alone — it re-checks the timestamp every time.

The teacher endpoint compares the key in constant time and waits a fixed 300 ms before every
rejection, so guessing is slow and the reply time says nothing about how close a guess was.

---

## 4a. Abuse protection

**Read this first: the whole school leaves Cloudflare through ONE public IP address.** Every
Chromebook in the building shares it. So anything this Worker counts "per IP" is really counted per
*school*, and any penalty it hands out per IP is handed to the whole class at once. That single
fact decides every number below.

There used to be per-IP lockouts here: ten wrong phrases in ten minutes locked that address out of
compiling, five wrong teacher keys locked it out of `/teacher.html`. On paper they slowed a
guesser down. In a classroom they handed one bored student a switch that turns off compiling for
thirty classmates — or locks the teacher out of his own phrase page — in about fifteen clicks. They
are gone. Do not put them back.

Very little was bought by them anyway:

- **A wrong answer is already cheap to refuse.** A wrong phrase costs one KV read (usually served
  from a cache) and two hashes. A wrong teacher key costs two hashes and the fixed 300 ms pause.
  The container never starts either way, so no wrong guess costs compute.
- **The teacher key is 192 bits of randomness.** What stops a brute force is the length of the key,
  not a counter. There is no number of guesses per hour that matters at that size.
- **The phrase is not a password.** It is three words, it is written on the board, and it expires
  within hours. It keeps the rest of the internet off the compiler; it was never meant to hold
  against somebody sitting in the room.

### What is actually enforced

| Guard | Limit | Then | Message |
|---|---|---|---|
| Wrong class phrase | none | 403, every time, straight away | "Wrong class phrase. Ask your teacher for today's phrase." |
| Wrong teacher key | none, per person | 403 after a fixed 300 ms | "Wrong teacher key." |
| Wrong teacher keys, everywhere | more than 100 in 15 minutes | wrong keys get 429 for 15 minutes — **a correct key still gets in** | "Too many wrong keys from everywhere right now. Try again in N minutes. The right key still works." |
| Compiles, per client id | 6 per minute | 429 until the window slides | "That is a lot of compiles in one minute. Wait N seconds…" |
| Compile requests, everyone | 120 per minute | 429 until the window slides | "The compiler is very busy right now. Wait a minute and try again." |

Every 429 carries `Retry-After` in seconds. There is no `x-lockout` header any more: a 429 from
`/api/compile` is now always about pace, never about the phrase, so the editor no longer has to
tell two kinds of 429 apart.

**The per-client limit.** The editor mints one random id the first time it is used
(`crypto.randomUUID()`), keeps it in `localStorage` under `uno-ide.v1.client-id`, and sends it
as `x-client-id` on every compile. Six a minute is then six a minute *per Chromebook* instead of
six for the whole school, which is what the old per-IP limit really meant.

The id is not a credential and is not treated as one. Anyone can mint a fresh one for every request
and walk straight past the per-client limit — that is fine and expected. It is a fuse against a
stuck loop or a page left hammering Ctrl-Enter, not a lock. **The phrase is the lock**, and the
ceiling below is what keeps somebody who does that from mattering to the bill. A request with no
id, or with an id that is not `^[A-Za-z0-9-]{8,64}$`, drops into a shared per-IP "anonymous"
bucket with the same six a minute. That is where `curl` lands. No student ever does.

**The global ceiling.** One number, `GLOBAL_COMPILE_MAX_PER_MINUTE` in `src/ratelimit.ts`, set
to 120 a minute and counted after the phrase check. It protects the bill, not the door: it is there
so a runaway script, a bug in the page, or a phrase that leaked cannot quietly run up container
time overnight. Know the headroom before you rely on it — thirty students compiling twice a minute
is 60, and thirty students compiling four times a minute is exactly 120. A class in a debugging
frenzy is the one plausible way to meet it. **If that happens, raise the number.** It is not a
security boundary and treating it as one will only annoy a class.

**The teacher-key guard cannot lock you out.** The key is compared *first*, and the wide guard is
consulted only once a key has already turned out to be wrong. A correct key therefore gets in
however much junk anybody else is sending. That ordering is the whole safety argument, and
`test/teacher-guard.test.mjs` pins it by asserting the guard class has no method a correct key can
reach.

**If a class cannot compile, the phrase is the only thing that can be wrong.** Set it again from
`/teacher.html`. Nothing else can put the room in a bad state: there is no lockout to wait out and
no counter that needs forgiving.

All of it is counted in the compile container's Durable Object — the single instance every request
already passes through — which makes the counts site-wide rather than per Worker isolate. Nothing
is written to storage: if that object is ever evicted the counts reset, which is an acceptable
trade for a fuse.

The numbers live in two files, with tests beside each:

| What | Where | Tests |
|---|---|---|
| 6 compiles/minute/client, 120/minute total, the client-id shape | `src/ratelimit.ts` | `test/ratelimit.test.mjs` |
| more than 100 wrong teacher keys / 15 minutes | `src/teacher-guard.ts` | `test/teacher-guard.test.mjs` |
| the order of the five checks | `src/compile-gate.ts` | `test/compile-gate.test.mjs` |

### Optional: a Cloudflare Rate Limiting rule on `/api/teacher/*`

Not configured, and not needed: a wrong key is refused for two hashes and a 300 ms pause, with no
KV read and no container. Add it only if the teacher page ever draws real traffic, because a zone
rule refuses at Cloudflare's edge and the Worker never runs at all, which is cheaper still.
Dashboard steps, if that day comes:

1. <https://dash.cloudflare.com> → the `uploadmycode.com` zone → **Security** → **WAF** → **Rate
   limiting rules** → **Create rule**.
2. Name it `teacher-endpoint`. Match **Custom filter expression**: field *URI Path*, operator
   *starts with*, value `/api/teacher/`.
3. Characteristics: **IP** (the free tier's only choice).
4. Period **10 seconds**, requests **20**, duration **60 seconds**, action **Block**.
5. Deploy.

Remember what section 4a says about one address: this rule is per IP, so at school it is per
*school*, and it is per school for students as well as for a script. Keep the numbers loose: the
teacher page fires one GET on load and one request per button press, so twenty in ten seconds is
far above real use and far below a script. A blocked request gets Cloudflare's own 429 page, not
this site's JSON, so do not tighten it to where a real person can hit it.

---

## 4b. Security headers, and https only

Two things happen to every request before anything else does. Both live in `src/headers.ts`, both
are tested in `test/headers.test.mjs`, and both are wired in at the top of the `fetch` handler in
`src/worker.ts`.

**Plain http gets a 301 to https.** Path and query are kept, the port is dropped (Cloudflare
answers plain http on 8080 and friends, and those ports serve no TLS), and `localhost` is left
alone so `wrangler dev` still works.

**Every response is stamped**, static files included. That last word is why
`assets.run_worker_first` in `wrangler.jsonc` is now `true` instead of `["/api/*"]`: with the old
value the asset server answered `/` on its own and the Worker never ran, so nothing outside
`/api/*` carried a single header.

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | A year. The browser stops trying http at all. |
| `X-Content-Type-Options` | `nosniff` | An uploaded `.ino` is never guessed into something executable. |
| `X-Frame-Options` | `DENY` | Nobody frames the teacher page to harvest the key. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | The class phrase never leaves in a URL. |
| `Permissions-Policy` | `serial=(self), usb=(), camera=(), microphone=(), geolocation=(), payment=()` | **`serial=(self)` is load-bearing.** Drop it and Upload and the serial monitor stop working. Everything else is off by name. |
| `Cross-Origin-Opener-Policy` | `same-origin` | A window this site opens cannot reach back into it. |
| `X-Robots-Tag` | `noindex, nofollow` | Internal district tool. `public/robots.txt` says the same to crawlers that read it. |
| `Cache-Control` | `no-store` on `/api/*` only | A phrase or a compiled sketch has no business in a shared cache or on a Chromebook's disk. |

And on HTML only:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self';
  worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self';
  frame-ancestors 'none'; upgrade-insecure-requests
```

(One line in the real header; wrapped here to fit.)

### Why `style-src` allows `'unsafe-inline'` and `script-src` does not

`script-src 'self'` is strict, with no `'unsafe-inline'` and no nonce, because the site has no
inline script left at all. The teacher page and the Web Serial test page used to carry one each;
they are now `public/teacher.js` and `public/serial-test.js`, loaded with `defer`. Keep it that
way: an inline `<script>` added to any page under `web/` will simply not run in a browser.

`style-src` is the exception, and it is deliberate. CodeMirror styles the editor by building a
`<style>` element at runtime (style-mod, reached through `EditorView.theme` in `web/src/editor.ts`),
and `teacher.html` and `serial-test.html` each carry their own `<style>` block so they keep working
with no build step. CodeMirror can be given a nonce — the `EditorView.cspNonce` facet — but a nonce
must be minted per response and written into the HTML, which means rewriting every HTML file on
every request and giving up the asset cache, and it would still not cover the two standalone pages.
Inline style cannot fetch or execute anything; inline script can. So style is loose, script is
strict.

`worker-src 'none'` is safe because nothing here starts a Worker, a SharedWorker or a service
worker — checked across `web/src` and the CodeMirror packages. If a dependency ever does, this is
the directive that will break first, and `'self'` is the fix.

### Dashboard, not code

Two zone settings do the same job one layer earlier and are worth turning on by hand. Neither is
configured by this repo, and neither replaces the Worker:

1. <https://dash.cloudflare.com> → the `uploadmycode.com` zone → **SSL/TLS** → **Edge Certificates**
   → **Always Use HTTPS**: on. Cloudflare then redirects before the Worker is even invoked.
2. Same page → **HSTS (HTTP Strict Transport Security)** → Enable, if desired. Read the warning
   first: with `includeSubDomains` and a long max-age, every subdomain of `uploadmycode.com` must
   serve valid TLS for as long as the max-age lasts. The Worker already sends the header itself, so
   this only adds Cloudflare's own copy on responses the Worker does not produce.

### Checking it

```powershell
curl.exe -sSI https://uploadmycode.com/            # CSP + all seven common headers
curl.exe -sSI https://uploadmycode.com/teacher     # same, and it is HTML
curl.exe -sSI http://uploadmycode.com/             # 301 to https, no body
curl.exe -sS -o NUL -D - -X POST https://uploadmycode.com/api/compile `
  -H "content-type: application/json" -d "{}"      # cache-control: no-store, and no CSP
```

---

## 5. Adding a library to the allowlist

Students cannot install libraries. The set is baked into the image, which is what keeps a compile
from ever touching the network.

1. Find the exact version:

   ```powershell
   npx wrangler containers  # not needed; use the local tools/ arduino-cli:
   arduino-cli lib search Adafruit_NeoPixel
   ```

2. In `container/Dockerfile`, add a pin next to the others near the top:

   ```dockerfile
   ARG NEOPIXEL_VERSION=1.12.3
   ```

3. Add the install to the existing `arduino-cli lib install` chain in the same `RUN`:

   ```dockerfile
       && arduino-cli lib install "Adafruit NeoPixel@${NEOPIXEL_VERSION}" \
   ```

4. Add it to the editor's Library dropdown, in `web/src/libraries.ts`:

   ```ts
   { label: "Adafruit NeoPixel", header: "Adafruit_NeoPixel.h", note: "addressable LED strips" },
   ```

   That list has to stay in step with the Dockerfile by hand; nothing checks it. A header the image
   does not have still fails, on the server, with avr-gcc's own "No such file or directory".

5. `npm run deploy`. The image rebuilds (a few minutes, because the layer changed) and the next
   compile can `#include` it.

Keep every version pinned. An unpinned library means next year's rebuild is not this year's
compiler, and a sketch that worked in September stops working in May for no visible reason.

---

## 6. The optional in-person lock (`ALLOWED_CIDRS`)

By default the site works from anywhere, as long as you have today's phrase. That is usually the
right trade: a student finishing at home is a feature, not a leak.

If you want compiles restricted to the building, set `ALLOWED_CIDRS` in `wrangler.jsonc` to the
school's public egress ranges. Anything outside every range gets 403 "uploadmycode only works from
school."

### Getting the ranges from district IT

Ask them, in these words:

> I run a small internal website for a classroom electronics unit. I would like to restrict it so
> it only works from inside the district network. What are the **public IPv4 and IPv6 egress
> ranges** (in CIDR notation) that student traffic leaves the district from? I need the ranges as
> they appear to an outside web server, not the internal 10.x addresses.

What you are looking for is something like `203.0.113.0/24` or `2001:db8:1234::/48`. Points worth
raising with them:

- Ask for **all** of them. Districts often have more than one internet circuit, and a failover to
  the second one on a Tuesday morning would lock the class out.
- Ask whether student Chromebooks go out through a **cloud web filter** (Securly, iBoss, Zscaler,
  Lightspeed). If they do, the address the site sees belongs to the filter vendor, not the district,
  and you need the vendor's egress ranges instead. Those are large and shared with other districts,
  so the lock is much weaker; the phrase is still doing the real work.
- Ask whether the ranges are **static**. If IT renumbers, compiles stop working with a message that
  does not say why, in the middle of a period. Get a contact who will warn you.

### Setting it

```jsonc
"vars": {
  "ALLOWED_CIDRS": "203.0.113.0/24,198.51.100.0/22,2001:db8:1234::/48"
}
```

Then `npm run deploy`. Both IPv4 and IPv6 are supported, comma-separated, spaces around entries are
fine. Test it from your phone on cellular data — that is the "outside" case — and from a school
Chromebook before you rely on it.

**Turning it off** is setting it back to `""` and redeploying. Do that first if compiles start
failing and you are not sure why.

Two things to know before you switch it on:

- The check uses Cloudflare's `cf-connecting-ip`. If that header is missing, the request is refused.
- An entry the parser cannot read is skipped and logged, not obeyed. A typo therefore narrows the
  allowlist rather than opening it, but check the Worker log after any change:
  `npx wrangler tail` and look for `ALLOWED_CIDRS entries not understood`.

---

## 7. Cost, and how to keep it that way

Fixed cost is $5/month for Workers Paid. Everything else is usage, and the included monthly
allowance is generous for one classroom: 375 vCPU-minutes, 25 GiB-hours of memory, 200 GB-hours of
disk. A class period of 30 students compiling 20 times each at ~3 vCPU-seconds is about 30
vCPU-minutes.

The guardrails, all already in place:

| Guardrail | Where | Value |
|---|---|---|
| One container instance | `wrangler.jsonc` `max_instances` | 1 |
| Small instance | `wrangler.jsonc` `instance_type` | `basic` (1/4 vCPU, 1 GiB) |
| Sleeps when idle | `src/worker.ts` `sleepAfter` | 10 minutes |
| Compile timeout | `container/server.js` | 30 s |
| Request size cap | `src/worker.ts` | 100 KB |
| Rate limit, per client | `src/ratelimit.ts` | 6 per minute per `x-client-id` (section 4a) |
| Global ceiling | `src/ratelimit.ts` | 120 compile requests per minute, everyone together |
| Wrong-key guard | `src/teacher-guard.ts` | more than 100 wrong teacher keys / 15 min (section 4a) |
| Class phrase | KV + `src/worker.ts` | required on every compile |

Memory and disk are billed while the instance is **awake**, CPU only while it is **working**. That
is why `sleepAfter` is 10 minutes and not an hour, and why there is no scheduled keep-alive ping.
Do not add one: it would keep the instance awake, and therefore billing, all night. Warming up by
hand before class (step 5 of the daily routine) does the same job for the cost of one compile.

### Reading the dashboard

<https://dash.cloudflare.com> → your account → **Workers & Pages** → **uploadmycode**.

- The Worker's own **Metrics** tab: requests, errors, CPU time.
- **Containers** (left sidebar, under Workers & Pages) → the `uploadmycode-compilercontainer`
  application: instance state, vCPU-seconds, memory GiB-seconds, disk. This is the number that
  actually moves your bill.
- Account **Billing** → **Usage** for the plan-wide totals against the included allowance.

Check it after the first real class. That single data point is worth more than any estimate here.

### Setting a billing notification

Do this once, on the first day, before a class ever touches it.

1. <https://dash.cloudflare.com> → your account → **Manage Account** → **Notifications**.
2. **Add** → find **Billing Usage Alert** (under the Billing product).
3. Set the threshold to a percentage of the included usage you want to hear about — 80% is a good
   first alarm.
4. Add your email as the destination. Save.

Also worth adding, from the same screen: **Workers** → *Usage Notification* if you want a heads-up
on request volume rather than money.

If an alert ever fires mid-year, the first two things to look at are the Containers usage graph (is
something keeping the instance awake?) and `npx wrangler tail` (is something compiling in a loop?).

---

## 8. Everyday commands

```powershell
npm install         # once per machine, and after a dependency change
npm run typecheck   # tsc for the Worker and for web/
npm test            # node --test over test/ and web/test/
npm run build       # vite build web -> public/
npm run deploy      # build, then wrangler deploy (needs Docker running)
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npx wrangler tail   # live Worker logs
npx wrangler secret list
npx wrangler kv key get --binding CLASS_KV phrase --remote   # what phrase is set
npx wrangler kv key delete --binding CLASS_KV phrase --remote  # end it from the terminal
```

`npm run deploy` is the only command that changes what students see.

---

## 9. Related docs

- [SETUP.md](SETUP.md) — running your own copy from scratch, for someone who did not build this.
- [PLAN.md](../PLAN.md) — architecture and the locked decisions.
- [CHROMEBOOK-CHECKLIST.md](CHROMEBOOK-CHECKLIST.md) — the Web Serial policy conversation with
  district IT. Go/no-go for the whole project.
- [T2-TEST.md](T2-TEST.md), [T3-TEST.md](T3-TEST.md), [T4-TEST.md](T4-TEST.md) — manual test scripts
  for the editor, the upload, and the serial monitor.

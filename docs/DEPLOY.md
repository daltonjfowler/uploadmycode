# Deploying and running uploadmycode

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
| That is a lot of compiles in one minute. Wait N seconds… | Rate limit. Six a minute per IP. Wait. |
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

The account id in `wrangler.jsonc` history is `8a77f2d8ecd25793e3a979cef8ac2646`. If `whoami` shows a
different account, you are about to deploy to the wrong place — stop.

### 2.4 Create the KV namespace (only if this is a brand new account)

The namespace already exists for the live project and its id is in `wrangler.jsonc`. On a new
account:

```powershell
npx wrangler kv namespace create CLASS_KV
```

Copy the printed id into the `kv_namespaces` block of `wrangler.jsonc`.

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

`POST /api/compile` runs six checks, in this order:

1. **Size.** Over 100 KB → 413. Answered from `Content-Length` before the body is read where
   possible, and re-checked against the real byte count after, so a chunked upload cannot slip past.
2. **School IP lock.** Off unless `ALLOWED_CIDRS` is set (section 6).
3. **Phrase lockout.** Is this address already serving a wrong-phrase lockout? → 429. Checked
   before the KV read, so a locked address costs nothing (section 4a).
4. **Class phrase.** Read from KV, compared in constant time after both sides are normalized.
   Missing or expired → 403 "No class phrase is active"; wrong → 403 "Wrong class phrase".
5. **Rate limit.** Six compiles a minute per IP, counted in the container's Durable Object, with a
   `Retry-After` header on the 429.
6. **Compile.** Only now is the container touched.

A phrase is valid only while `Date.now() < expiresAt`. KV's own `expirationTtl` is set as well, but
a KV read can be served from a per-location cache for up to 60 seconds, so the Worker never trusts
the key's absence alone — it re-checks the timestamp every time.

The teacher endpoint compares the key in constant time and waits a fixed 300 ms before every
rejection, so guessing is slow and the reply time says nothing about how close a guess was.

---

## 4a. Abuse protection

The phrase and the key are short enough to guess if guessing is free, so it is not free. Everything
below is counted in the compile container's Durable Object — the single instance every request
already passes through — which makes the counts site-wide rather than per Worker isolate. Nothing
is written to storage: if that object is ever evicted the counts reset, which is the same trade the
compile rate limit makes.

| Guard | Limit | Then | Message |
|---|---|---|---|
| Wrong teacher key, per IP | 5 in 15 minutes | 429 for 15 minutes from the fifth | "Too many wrong keys from this network. Try again in N minutes." |
| Wrong teacher key, everywhere | more than 100 in 15 minutes | 429 for 15 minutes — **but a correct key still gets in** | "Too many wrong keys from everywhere right now. Try again in N minutes. The right key still works." |
| Wrong class phrase, per IP | 10 in 10 minutes | 429 for 10 minutes from the tenth | "Too many wrong phrases. Wait N minutes, then ask your teacher for today's phrase." |
| Compiles, per IP | 6 per minute | 429 until the window slides | "That is a lot of compiles in one minute…" |

Every 429 carries a `Retry-After` header in seconds. The phrase lockout also sends
`x-lockout: class-phrase`, which is how the editor tells it apart from the ordinary compile rate
limit and shows it next to the phrase field rather than in the output panel.

Details worth knowing before you change any of it:

- **A correct answer clears that address.** A class that fumbled the phrase all morning is not one
  typo away from a lockout all afternoon, and a good teacher key wipes that machine's slate.
- **Setting a phrase unlocks the room.** A whole school usually leaves Cloudflare through one
  address, so the class shares one bucket of ten wrong phrases — and a phrase expiring mid-period
  is exactly when thirty open tabs all send a stale one at once. Setting a new phrase from
  `/teacher.html` therefore forgives every wrong-phrase lockout everywhere. **If a class is ever
  locked out, set the phrase again; that is the fix.** It does not touch teacher-key lockouts.
- **A student with no phrase yet is not a guesser.** A compile with no `x-class-phrase` header at
  all is refused but never counted; only a wrong, non-empty phrase costs a strike. The first
  compile of the day therefore never eats one.
- **The wide teacher guard cannot lock you out.** The key is compared *first*, and the all-IP guard
  is consulted only after a key turns out to be wrong. That ordering is deliberate: if the guard
  ran before the compare, anyone could lock the teacher out of his own class for the price of a
  hundred junk requests. Your own per-IP lock still applies — five wrong keys from your own laptop
  is still fifteen minutes — so if you are locked out and the phrase must change now, set it from
  the terminal instead: `npx wrangler kv key put --binding CLASS_KV phrase ... --remote`, or wait.
- **The lock does not grow while you push on it.** Refused requests are not counted, so retrying
  during a lockout never extends it. The wait shown is the real one.
- **The limits live in one place**, `src/lockout.ts` (`LOCKOUT_POLICIES`), with unit tests in
  `test/lockout.test.mjs`. Change the numbers there and the tests will tell you what you broke.

### Optional: a Cloudflare Rate Limiting rule on `/api/teacher/*`

Not configured, and not needed — the lockouts above already run before any KV read. Add it only if
the teacher page ever draws real traffic, because a zone rule refuses at Cloudflare's edge and the
Worker never runs at all, which is cheaper still. Dashboard steps, if that day comes:

1. <https://dash.cloudflare.com> → the `uploadmycode.com` zone → **Security** → **WAF** → **Rate
   limiting rules** → **Create rule**.
2. Name it `teacher-endpoint`. Match **Custom filter expression**: field *URI Path*, operator
   *starts with*, value `/api/teacher/`.
3. Characteristics: **IP** (the free tier's only choice).
4. Period **10 seconds**, requests **20**, duration **60 seconds**, action **Block**.
5. Deploy.

Keep the numbers loose. The teacher page fires one GET on load and one request per button press,
so twenty in ten seconds is far above real use and far below a script. A blocked request gets
Cloudflare's own 429 page, not this site's JSON, so do not tighten it to where a real person can
hit it.

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

4. `npm run deploy`. The image rebuilds (a few minutes, because the layer changed) and the next
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

> I run a small internal website for my Arduino unit. I would like to restrict it so it only works
> from inside the district network. What are the **public IPv4 and IPv6 egress ranges** (in CIDR
> notation) that student traffic leaves the district from? I need the ranges as they appear to an
> outside web server, not the internal 10.x addresses.

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
| Rate limit | `src/ratelimit.ts` | 6 per minute per IP |
| Failure lockouts | `src/lockout.ts` | 5 wrong keys / 15 min, 10 wrong phrases / 10 min (section 4a) |
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

- [PLAN.md](../PLAN.md) — architecture and the locked decisions.
- [CHROMEBOOK-CHECKLIST.md](CHROMEBOOK-CHECKLIST.md) — the Web Serial policy conversation with
  district IT. Go/no-go for the whole project.
- [T2-TEST.md](T2-TEST.md), [T3-TEST.md](T3-TEST.md), [T4-TEST.md](T4-TEST.md) — manual test scripts
  for the editor, the upload, and the serial monitor.

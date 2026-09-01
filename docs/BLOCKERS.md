# Blockers

Things that are built and tested but not yet deployed, and why. Delete an entry
once it is cleared.

---

## B1 — Container cannot be built or deployed: Docker engine is not running

**Status:** open. **Found:** 2026-08-31, during T1. **Owner:** Dalton.

Docker Desktop 4.88.1 is installed at
`C:\Users\Mo Chara\AppData\Local\Programs\DockerDesktop` (CLI at
`resources\bin\docker.exe`, not on PATH), but WSL2 / Virtual Machine Platform were
installed in the same session and **the machine has not rebooted yet**, so the
engine cannot start.

The client talks; the server does not:

```
> & "C:\Users\Mo Chara\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe" info
Client:
 Version:    29.7.2
 Context:    desktop-linux
...
Server:
ERROR: request returned 500 Internal Server Error for API route and version
http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.55/info, check if the server
supports the requested API version
errors pretty printing info
```

Wrangler needs the Docker CLI **even for `--dry-run`**, so nothing about the
image has been verified on a real build:

```
> npx wrangler deploy --dry-run --outdir <tmp>
✨ Read 1 file from the assets directory C:\Users\Mo Chara\Desktop\uno-web-ide\public
Total Upload: 55.40 KiB / gzip: 13.72 KiB

X [ERROR] The Docker CLI is needed to build the configured image before deploying
  (even in dry-run mode) but could not be launched.
```

Note the two lines before the error: wrangler parsed `wrangler.jsonc` and read
the assets directory before it reached the image step, so the `containers` /
`durable_objects` / `migrations` config itself is syntactically accepted.

### What this does and does not block

- **Not blocked:** the compile pipeline itself. `container/server.js` runs on
  Windows against the same pinned `arduino-cli` the image installs, and the T1
  gate passes there. See the T1 commit message for the verbatim outputs.
- **Blocked:** `container/Dockerfile` has never been built. Its pins and
  checksums were taken from the upstream release files, but no line of it has
  been executed.
- **Blocked:** `wrangler deploy`, so `POST /api/compile` on
  <https://uno-web-ide.daltonjfowler.workers.dev> still returns the T0 `501`.
  The live site is unchanged, not broken.

### To clear

1. Reboot the machine, then start Docker Desktop and wait for the whale icon to
   go steady.
2. `& "C:\Users\Mo Chara\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe" info`
   should print a `Server:` block with no error. Add
   `C:\Users\Mo Chara\AppData\Local\Programs\DockerDesktop\resources\bin` to PATH
   so wrangler can find `docker`.
3. `npx wrangler deploy`. The first build downloads the AVR toolchain, so expect
   several minutes.
4. Re-run the two T1 gate checks against
   `https://uno-web-ide.daltonjfowler.workers.dev/api/compile`.

`--containers-rollout=none` deploys the Worker without the container. It is not
useful here: the compile route would answer 503 for every student. Do not use it
as a workaround.

### Unknown, and will surface on that first deploy

Whether the account is on the **Workers Paid** plan. Containers require it
($5/month). A billing error on the first `wrangler deploy` belongs here as B2,
not in a retry loop.

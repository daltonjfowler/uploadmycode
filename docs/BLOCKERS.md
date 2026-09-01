# Blockers

Things that are built and tested but not yet deployed, and why. Delete an entry
once it is cleared.

No open blockers.

---

## Cleared

- **B1 — Container could not be built or deployed (no Docker engine).** Cleared 2026-09-01:
  WSL2 installed, machine rebooted, Docker Desktop 4.88.1 running. `npx wrangler deploy` built
  `container/Dockerfile` clean on its first run and rolled it out. Live gate on
  `https://uploadmycode.com/api/compile`: cold Blink 16.3 s, warm Blink
  0.8 s, missing-semicolon sketch returns `sketch.ino:8:3: error: expected ';' before 'delay'`.
  Workers Paid was already active on the account.

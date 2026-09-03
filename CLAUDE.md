# CLAUDE.md — uploadmycode

Classroom tool: browser IDE for Uno boards, for Chromebooks. Compile on a Cloudflare Container
(`arduino-cli`), flash the Uno from the browser via Web Serial. Uno only, ever.

Public repo, MIT licensed. Do not put anything in it that is specific to Dalton's account or
school: no keys, no phrase values, no district name. `docs/SETUP.md` is the doc a stranger reads;
`docs/DEPLOY.md` is the operator manual for Dalton's own instance. Keep "Arduino" out of
user-facing prose — the hardware is "the Uno" or "Uno boards" — but leave real names and
identifiers alone (`arduino-cli`, `arduino:avr:uno`, `ARDUINO_*` env vars, code identifiers,
download URLs). See the "Trademarks and licensing" section of README.md.

Rules for every session in this repo:

1. Read `PLAN.md` first. It holds the locked decisions, the architecture, and tasks T0–T5 (T6 was dropped; do not revive it).
2. **One task per session, in the listed order.** Do the task, run its gate, report the gate
   output verbatim, commit as `T<N>: <short name>`, stop. Never start the next task, never spawn
   subagents.
3. Do not relitigate locked decisions. Do not add dependencies the task does not name without
   flagging first. Pin all versions.
4. Keep code boring and small — one teacher maintains this alone.
5. Secrets via `wrangler secret put` only.
6. Load `cloudflare:wrangler` before wrangler commands and `cloudflare:workers-best-practices`
   before writing Worker code.
7. T3 and T4 gates need real hardware; the worker writes exact manual test steps for Dalton
   instead of claiming the gate passed.

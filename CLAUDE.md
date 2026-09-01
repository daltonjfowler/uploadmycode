# CLAUDE.md — uploadmycode

Classroom tool: browser Arduino IDE for Chromebooks. Compile on a Cloudflare Container
(`arduino-cli`), flash an Arduino Uno from the browser via Web Serial. Uno only, ever.

Rules for every session in this repo:

1. Read `PLAN.md` first. It holds the locked decisions, the architecture, and tasks T0–T6.
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

# CLAUDE.md — uploadmycode

Classroom tool: browser IDE for Uno boards and (when a teacher switches it on) ESP32 boards. Compile on a
Cloudflare Container (`arduino-cli`), flash from the browser via Web Serial. "Uno only, ever" was lifted by Dalton
on 2026-10-10: ESP32 is a teacher toggle (`src/boards.ts`), compiled by a separate `Esp32Container`
(`container/Dockerfile.esp32`, same server.js with BOARD=esp32), flashed with esptool-js (`web/src/flash/esp32.ts`).
The ESP32 Wi-Fi safety failsafe (`container/esp32-guard.js`: no deauth / beacon spam / sniffing / Marauder; text
check plus a symbol check of the linked .elf) is on unless a teacher switches it off, and that override always
expires. Never weaken it, and never let a student request set `x-allow-wifi-tools`: only the Worker sets it.
User-facing name (Dalton 2026-10-10): "Arduino UNO and ESP32 tool", used as a description; the site name stays
uploadmycode.

Public repo, MIT licensed. Do not put anything in it that is specific to Dalton's account or
school: no keys, no phrase values, no district name. `docs/SETUP.md` is the doc a stranger reads;
`docs/DEPLOY.md` is the operator manual for Dalton's own instance. Keep "Arduino" out of
user-facing prose, except the "Arduino UNO and ESP32 tool" description and board picker Dalton asked for — the hardware is "the Uno" or "Uno boards" — but leave real names and
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

Wrong-guess lockout (`src/lockout.ts`, Cache API, falls open): 5 wrong phrases or teacher keys in a
row per DEVICE (`x-device-id`, `web/src/device.ts`; no id = per IP) lock 5 s, doubling to a 300 s cap;
checked before the compare, cleared by a right answer. Never key it per IP (Dalton 2026-09-28: a
school shares one IP).

Teacher accounts (Dalton 2026-10-30): `src/teachers.ts` (server) and `web/src/teacher-account.ts` + `.css`
(teacher page) are the SAME files on all four uploadmy sites: change one, copy to all four. Each teacher picks
their own password (start code first); accounts live in the shared `TEACHERS_KV` namespace, sessions are signed
with this site's `TEACHER_SESSION_KEY` secret and sent as `x-teacher-key` (display.js reads the same
`uploadmycode.teacherKey` entry). The old shared `TEACHER_KEY`(_2) still works until those secrets are deleted.
A wrong key, password or session is a 401 and counts in the lockout above. Teacher changes are logged with the
name (`logChange`, "Recent changes"). The teacher page is a Vite page now (`web/teacher.html` + `web/src/teacher.ts`).

## Code navigation: Serena (Dalton 2026-10-10)
Use the Serena MCP tools by default in this repo. Start with `activate_project` on this repo's root folder
(config in `.serena/project.yml`), then `get_symbols_overview` / `find_symbol` / `find_referencing_symbols`
to read, and `replace_symbol_body` / `replace_content` / `insert_*_symbol` to edit. Plain Read/Grep only for
non-code files or quick discovery.

# Uno Web IDE

Browser Arduino IDE for district Chromebooks. Students write a sketch on a website, the sketch
compiles on a Cloudflare Container running `arduino-cli`, and the browser flashes the resulting
hex onto an Arduino Uno over USB with the Web Serial API. No installs on student machines.

- Arduino Uno only.
- Hosted on Cloudflare Workers + Containers (Workers Paid plan, $5/month + small usage).
- Internal district tool, not a public service.

**Live:** <https://uno-web-ide.daltonjfowler.workers.dev> — T0 placeholder page, no editor yet.

**Start here:** [PLAN.md](PLAN.md) — architecture, locked decisions, and the T0–T5 task list for
worker sessions. One task per session, in order, gate must pass before stopping.

## Commands

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run deploy      # wrangler deploy
```

`npm run dev` (`wrangler dev`) needs Docker once T1 adds the container. See PLAN.md.

## Before T2

Run [docs/CHROMEBOOK-CHECKLIST.md](docs/CHROMEBOOK-CHECKLIST.md). Web Serial policy on managed
Chromebooks is the go/no-go risk for the whole project.

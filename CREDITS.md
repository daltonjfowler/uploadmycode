# Credits

uploadmycode is a thin shell around other people's work. This file lists every open-source project
the tool stands on, so you can go find them, read their code, and support them.

Two things to be clear about up front.

- **Nothing here is copied code.** This repository contains no third-party source. The container
  image *downloads* the compiler toolchain from its publishers at build time and runs it as a
  separate program. The flasher and the hex parser in `web/src/flash/` were written from public
  protocol documents; the documents are credited below as references, not as code.
- **Nobody listed here endorses this project.** Being credited is not affiliation, sponsorship or
  approval. ARDUINO and UNO are trademarks of Arduino SA; see
  [README.md, "Trademarks and licensing"](README.md#trademarks-and-licensing).

Every version below, and nearly every URL, was read out of a local file — a `package.json` in
`node_modules`, the library index `arduino-cli` itself ships, a `library.properties` or `LICENSE` in
an installed package, or a download URL in `container/Dockerfile`. The handful of links that are
just a project's official home, named from knowledge rather than read from a file, say so where
they appear and are listed together in
[How each fact was checked](#how-each-fact-was-checked) at the bottom. Where a license could not be
read from a local file it says **(license: see project page)** rather than a guess. Where a project
publishes no funding link that this repo can see, there is no support line — starring the repo and
filing good bug reports is the support on offer.

---

## The compile toolchain

Downloaded, checksum-verified and baked into the container image by `container/Dockerfile`. None of
it is redistributed by this repository — build the image and you get it from its publishers, under
their own licenses.

### Arduino CLI 1.5.1

The compiler front end. Every student sketch becomes a hex file by way of one
`arduino-cli compile --fqbn arduino:avr:uno`.

- License: **GPL-3.0** — verified from the `LICENSE.txt` in the release archive
- Repo: <https://github.com/arduino/arduino-cli>
- Docs: <https://arduino.github.io/arduino-cli/>

### Arduino AVR Boards core 1.8.8 (`arduino:avr`)

The board definitions and the C++ core library — `setup()`, `loop()`, `pinMode()`,
`digitalWrite()`, `Serial` and the rest of the API students actually type.

- License: **LGPL-2.1-or-later** — verified from the header of `cores/arduino/Arduino.h`
- Repo: <https://github.com/arduino/ArduinoCore-avr>
- Reference: <https://www.arduino.cc/en/Reference/HomePage>

Installing this core also pulls two tools this project never calls, because the browser does the
flashing. They ship in the image all the same, so they are credited all the same:

- **AVRDUDE 8.0.0-arduino1** — license **GPL-2.0**, verified from the `LICENSE.txt` in the installed
  tool. Project home, stated plainly rather than read from a file:
  <https://github.com/avrdudes/avrdude>
- **arduinoOTA 1.3.0** — **(license: see project page)**; no license file ships with it. Project
  home, stated plainly rather than read from a file: <https://github.com/arduino/arduinoOTA>

### The AVR GCC toolchain — `avr-gcc` 7.3.0-atmel3.6.1-arduino7

The actual compiler, assembler and linker. This is the Atmel/Microchip AVR build of the GNU
toolchain that the core above depends on, and it is what turns a sketch into machine code for the
ATmega328P.

Three separate projects in one bundle:

- **GCC 7.3.0** — license **GPL-3.0-or-later, with the GCC Runtime Library Exception** (GCC's own
  terms; no license file ships in the extracted bundle). <https://gcc.gnu.org/>
- **GNU Binutils** (`avr-as`, `avr-ld`, `avr-objcopy`) — license **GPL-3.0-or-later** (the
  project's own terms). <https://www.gnu.org/software/binutils/>
- **avr-libc 2.0.0** — the C library for AVR. License: a **3-clause BSD** license (the project's
  own terms). <https://www.nongnu.org/avr-libc/>

The version numbers above were read from the installed toolchain: `avr-gcc --version` prints
`(GCC) 7.3.0`, and `avr/include/avr/version.h` defines `__AVR_LIBC_VERSION_STRING__ "2.0.0"`.

## The classroom library allowlist

Four libraries, pinned in `container/Dockerfile`, baked into the image so a compile never touches
the network. They are what the editor's library dropdown offers.

### Servo 1.3.0

Drives hobby servos. By Michael Margolis and Arduino.

- License: **LGPL-2.1** — verified from `LICENSE.txt` in the installed library
- Home: <https://www.arduino.cc/reference/en/libraries/servo/>
- Repo: <https://github.com/arduino-libraries/Servo>

### LiquidCrystal 1.0.7

Text LCDs on the HD44780 chipset, wired directly. By Arduino and Adafruit.

- License: **LGPL-2.1-or-later** — verified from the License section of the library's `README.adoc`
- Home: <https://www.arduino.cc/en/Reference/LiquidCrystal>
- Repo: <https://github.com/arduino-libraries/LiquidCrystal>

### LiquidCrystal I2C 1.1.2

The same displays over two wires instead of six. By **Frank de Brabander**, maintained by Marco
Schwartz.

- **(license: see project page)** — no license file ships in the release, and the library index
  carries no license field
- Home: <https://github.com/marcoschwartz/LiquidCrystal_I2C>
- The release the index actually serves is built from
  <https://github.com/johnrickman/LiquidCrystal_I2C>

### Stepper 1.1.3

Unipolar, bipolar and five-phase stepper motors. Original by Tom Igoe, with two-wire work by
Sebastian Gassner, the combination version by Tom Igoe and David A. Mellis, a four-wire fix from
Noah Shibley, high-speed stepping and a timer rollover fix by Eugene Kozlenko, and five-phase
support by Ryan Orendorff.

- License: **LGPL-2.1-or-later** — verified from the header of `src/Stepper.cpp`
- Home: <https://www.arduino.cc/en/Reference/Stepper>
- Repo: <https://github.com/arduino-libraries/Stepper>

## The editor

### CodeMirror 6

The whole editing surface: the text editor, C++ syntax highlighting, autocomplete for the board
API, search, undo, and the line highlight that a compiler error jumps to. By **Marijn Haverbeke**
and contributors.

Seven packages are used, all **MIT**, all verified from the `license` field and `LICENSE` file in
`node_modules`:

| Package | Version |
|---|---|
| `@codemirror/state` | 6.7.2 |
| `@codemirror/view` | 6.43.10 |
| `@codemirror/language` | 6.12.4 |
| `@codemirror/commands` | 6.11.0 |
| `@codemirror/autocomplete` | 6.20.3 |
| `@codemirror/search` | 6.7.2 |
| `@codemirror/lang-cpp` | 6.0.3 |

- Home: <https://codemirror.net/>
- Repos: <https://code.haverbeke.berlin/codemirror/> and
  <https://github.com/codemirror/lang-cpp>
- Forum: <https://discuss.codemirror.net/>
- **Support: <https://github.com/sponsors/marijnh>** — the author's GitHub Sponsors page,
  fetched live on 2026-09-02; the page itself says "Fund me (CodeMirror, ProseMirror, Lezer,
  Eloquent JavaScript)", so it covers the `@lezer/highlight` package below as well. Not read
  from a local file; disclosed in the table at the bottom.

### `@lezer/highlight` 1.2.3

The syntax-highlighting tag vocabulary the editor theme is written against. Same author, same
family as CodeMirror.

- License: **MIT** — verified from the `license` field and `LICENSE` in `node_modules`
- Repo: <https://github.com/lezer-parser/highlight>

## Build and deploy tooling

### Vite 8.2.2

Bundles `web/` into the static `public/` directory, and runs the dev server. By Evan You and
contributors.

- License: **MIT** — verified from the `license` field in `node_modules`
- Home: <https://vite.dev>
- Repo: <https://github.com/vitejs/vite>
- **Support: <https://github.com/vitejs/vite?sponsor=1>** — read from the `funding` field of the
  installed package

### TypeScript 5.9.3

The language the Worker and the frontend are written in, and the typecheck gate. By Microsoft.

- License: **Apache-2.0** — verified from the `license` field in `node_modules`
- Home: <https://www.typescriptlang.org/>
- Repo: <https://github.com/microsoft/TypeScript>

### Wrangler 4.127.1

Builds the container image, uploads the static site, and deploys the Worker. By Cloudflare.

- License: **MIT OR Apache-2.0** — verified from the `license` field in `node_modules`
- Repo: <https://github.com/cloudflare/workers-sdk>

### `@cloudflare/containers` 0.3.7

The `Container` class the Worker extends to start, sleep and talk to the compile container.

- License: **MIT OR Apache-2.0** — verified from the `license` field in `node_modules`
- Repo: <https://github.com/cloudflare/containers>

### Everything underneath

Vite and Wrangler pull in a large tree of smaller packages, and several of their authors do publish
sponsor links. `npm fund` prints the current list from the installed tree — including
[Parcel/Lightning CSS](https://opencollective.com/parcel), [PostCSS](https://opencollective.com/postcss/),
[libvips](https://opencollective.com/libvips), [Express](https://opencollective.com/express), and
individual maintainers of `picomatch`, `nanoid`, `tinyglobby`, `supports-color`, `@sindresorhus/is`,
`error-stack-parser-es` and `@oxc-project/types`. Those URLs come straight out of the `funding`
fields in `node_modules`; run `npm fund` yourself for the live list.

## Inside the container image

### Debian 12 "bookworm" (slim)

The base image, pinned by digest in `container/Dockerfile`. Everything else in the image is
installed on top of it.

- License: thousands of packages, each under its own license, all meeting the Debian Free Software
  Guidelines. **(license: see project page)**
- Home: <https://www.debian.org/>

### Node.js 24.19.0

Runs `container/server.js`, the small HTTP service that receives a sketch and shells out to the
compiler. It uses Node built-ins only — no npm dependencies inside the container.

- License: **MIT** — verified from the `LICENSE` file of the same Node version installed locally
- Home: <https://nodejs.org/>
- Repo: <https://github.com/nodejs/node>

---

## References — documentation, not code

Nothing in this section contributed source. Each one is a document that was read while writing this
project's own code, and each deserves the credit anyway.

### Optiboot

The bootloader already burned onto an Uno. It is the other end of every upload: the browser resets
the board, Optiboot wakes up, and the two of them speak STK500v1 at 115200 baud. Its published
behaviour — which commands it answers, the 128-byte page size, how long it listens after a reset —
is what `web/src/flash/stk500v1.ts` was written against.

By **Peter Knight** (Cathedrow), building on work by Jason P. Kyle, Spiff and Ladyada, with the
Arduino-specific modifications by **Bill Westfield** (WestfW).

- License: **GPL-2.0-or-later** — verified from the header of `optiboot.c`, which ships inside the
  AVR core above at `bootloaders/optiboot/`
- Home: <https://github.com/Optiboot/optiboot> — the current project home. The copy bundled with
  the core still points at the retired `code.google.com/p/optiboot`.

### The STK500 protocol — Atmel application note AVR061

The command bytes, the `14 … 10` INSYNC/OK framing, and the word-addressed load-address command
that `web/src/flash/stk500v1.ts` implements all come from Atmel's published STK500 communication
protocol, application note **AVR061**. Atmel is now part of Microchip Technology.

- Home: <https://www.microchip.com/>
- The same constant table is visible in `bootloaders/optiboot/stk500.h` inside the AVR core, where
  its own first line reads `/* STK500 constants list, from AVRDUDE */`.

### The Intel HEX format specification

*Hexadecimal Object File Format Specification*, published by Intel. Record structure, the record
types, and the two's-complement checksum implemented in `web/src/flash/intel-hex.ts` come from it.

- Home: <https://www.intel.com/>

### The public-domain example sketches

`docs/T2-TEST.md` quotes two example sketches verbatim as manual test fixtures. Both carry the line
"This example code is in the public domain." in their own comment blocks.

- **Blink** — modified by Scott Fitzgerald, Arturo Guadalupi and Colby Newman.
  <https://www.arduino.cc/en/Tutorial/BuiltInExamples/Blink>
- **Sweep** — by BARRAGAN, modified by Scott Fitzgerald.
  <https://www.arduino.cc/en/Tutorial/LibraryExamples/Sweep>

---

## How each fact was checked

So you can redo it rather than trust it.

| Fact | Source |
|---|---|
| npm package versions, licenses, repos, funding | the `license`, `repository` and `funding` fields and the `LICENSE` files in `node_modules/<pkg>/`; `npm fund` for the transitive list |
| Pinned toolchain and library versions | the `ARG` block at the top of `container/Dockerfile` |
| `arduino-cli` download URL and license | the release URL in `container/Dockerfile`; `LICENSE.txt` in the extracted release |
| Library authors, versions and home URLs | `arduino-cli lib search <name> --format json`, and `library.properties` in each installed library |
| Library repo URLs | the release archive URL in that same index, which is of the form `downloads.arduino.cc/libraries/github.com/<owner>/<repo>-<version>.zip` |
| Library licenses | `LICENSE.txt`, `README.adoc` or the source header inside each installed library |
| AVR core license and repo | `cores/arduino/Arduino.h` and `README.md` inside the installed core |
| Toolchain versions pulled by the core | `toolsDependencies` in the core's `installed.json`; `avr-gcc --version`; `avr/include/avr/version.h` |
| Optiboot author and license | `bootloaders/optiboot/optiboot.c` and `README.TXT` inside the installed core |
| Node.js version and license | the `NODE_VERSION` pin in `container/Dockerfile`; the `LICENSE` file of that same version |
| Example sketch attribution | the comment blocks quoted in `docs/T2-TEST.md` |
| CodeMirror / Lezer funding link | `https://github.com/sponsors/marijnh`, fetched live 2026-09-02; the page names CodeMirror and Lezer itself |
| The rest | a handful of URLs are official project homes stated plainly rather than read from a file: gcc.gnu.org, gnu.org/software/binutils, nongnu.org/avr-libc (printed as a bare host in `optiboot.c`), nodejs.org and github.com/nodejs/node, debian.org, microchip.com, intel.com, github.com/Optiboot/optiboot, github.com/avrdudes/avrdude, github.com/arduino/arduinoOTA |

The setup that makes this reproducible is in the README under
["Running the compile server without Docker"](README.md#running-the-compile-server-without-docker):
it puts `arduino-cli`, the core, the toolchain and the four libraries under `tools/`, where all of
the files named above can be read.

Anything wrong or missing here is a bug. Open an issue.

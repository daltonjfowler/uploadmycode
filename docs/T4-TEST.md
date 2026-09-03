# T4 manual test — the serial monitor, and sharing the board with Upload

**Status: NOT run by the worker session that wrote it, and it cannot be.** The T4 session had no
board, no USB port and no browser. Nothing below has touched a wire. Dalton runs this; until he
does, T4 is not green.

What *was* run headlessly, and passed:

- `npm run typecheck` — clean.
- `npm test` — 35 tests, 13 of them new, against a fake port built from real web streams: a chunk
  boundary that splits both a line and a multi-byte character, the 2000-line buffer cap, the three
  line endings, the pause/resume handover (reader released, port closed, reopened at the same baud,
  reading again), a reopen that keeps failing, and an unplug followed by a replug and a reconnect.
- `npm run build` — clean. 533.28 kB / 174.84 kB gzip, up 8.92 kB (2.63 kB gzip) from T3.

Those tests prove the bytes and the state machine. They prove **nothing** about whether Chrome
hands the port back fast enough after a real upload, whether a real Uno resets when the monitor
opens the port, or what 9600 baud looks like on a real cable. That is this document.

T3's setup, failure messages and troubleshooting still apply: see
[docs/T3-TEST.md](T3-TEST.md). Run T3's Part A first if it has not been run — a board that will not
flash cannot pass T4 either.

---

## What you need

- One Uno (genuine R3 or a CH340 clone) and its USB cable. Nothing wired to the board.
- Google Chrome, normal window, not Incognito.
- **Close the Arduino IDE** and any other tab with this page open. Two things cannot hold one port.

## Setup

Identical to T3: two terminals (`node container\server.js` and `npm run dev:web`), then
**http://localhost:5173/** in Chrome. Testing against <https://uploadmycode.com> instead is fine and
skips the first terminal — and it is the only way to test on a Chromebook.

Plug the Uno in **now** and leave it plugged in until step A12 says otherwise.

---

## Part A — the gate

Fill in "Actual" as you go. Steps A9 and A10 are the gate proper; everything before them is
getting into position.

| # | Do this | Expect | Actual |
|---|---|---|---|
| A1 | Look at the bottom of the page, under the Output panel. | A new strip: **SERIAL MONITOR**, then the grey words **Not connected**, then a **Show** link on the right. Nothing else — the panel starts collapsed so it does not steal lines from the editor. | |
| A2 | Click **Show**. | The panel opens: a **Connect** button, a **Baud** dropdown reading **9600**, **Autoscroll** (ticked), **Timestamps** (unticked), a **Clear** link, an empty output area, and a greyed-out message box with **Ending** set to *Newline* and a **Send** button. The output area holds one line: `-- Click Connect and pick the board. Whatever the sketch prints with Serial.println shows up here.` The link now reads **Hide**. | |
| A3 | Open the **Baud** dropdown. | Nine rates in order: 300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200. Close it again on **9600**. | |
| A4 | Click in the editor, Ctrl+A, paste the **Counter** sketch from the bottom of this file, and click **Compile**. | Green `Compiled`. Output: `Program size: 3862 bytes of 32256 (12%).` (Compiled against the pinned arduino-cli 1.5.1 / avr 1.8.8 on 2026-08-31. A different number here means the toolchain moved, not that the monitor is broken.) | |
| A5 | Click **Upload**, pick the board in Chrome's chooser, and click Connect. | Progress bar to `page 31 of 31`, then green **`Uploaded 3862 bytes in NNN ms (31 pages).`** The **L** LED beside pin 13 starts flashing once a second. | |
| A6 | In the monitor strip, click **Connect**. | **No port chooser**: Chrome already granted this board for the Upload, and the monitor reuses it. Within a second the state goes to green **Connected at 9600 baud**, the output shows `-- Connected at 9600 baud.`, and then a new line **once a second**: `count: 1`, `count: 2`, `count: 3`, … The button now reads **Disconnect**, and the message box at the bottom is no longer greyed out. | |
| A7 | Watch for ten seconds without touching anything. | The numbers keep climbing, one a second, and the view stays pinned to the newest line. No stutter, no duplicated line, no `count: 12count: 13` run together on one line. | |
| A8 | Click into the message box, type `hello there` and press **Enter**. | Your line appears immediately as `> hello there`, the box empties, and within a second the board answers `you said: hello there` on its own line, in between the counts. | |
| A9 | **The gate, part one.** Leave the monitor connected and counting. Click in the editor and change the two words the sketch prints — `"counter ready"` to `"tick ready"` and `"count: "` to `"tick: "` — and change `delay(1000)` to `delay(500)`. (Or paste the **Tick** sketch from the bottom of this file, which is the same three changes.) Click **Compile**. | Green `Compiled`, `Program size: 3858 bytes of 32256 (12%).` The monitor keeps streaming `count: N` the whole time — compiling does not touch the board. | |
| A10 | **The gate, part two.** Click **Upload**. Do not touch anything else. | In order, and within about five seconds: (1) the monitor prints `-- Paused for upload…` and its state pill goes amber **Paused for upload**; (2) **no port chooser appears** — the monitor's board is the board; (3) the usual progress bar runs `page 1 of 31` … `page 31 of 31` and the status pill goes green **`Uploaded 3858 bytes in NNN ms (31 pages).`**; (4) the monitor prints `-- Resumed at 9600 baud.` and its pill goes green **Connected at 9600 baud** again; (5) new lines appear reading **`tick: 1`, `tick: 2`, …, twice a second**. This is the T4 gate. | |
| A11 | Look at the whole monitor output. | The history above `-- Paused for upload…` is still there: the old `count:` lines were not wiped by the upload. The `tick:` counter starts from 1, because the board reset. Missing the very first `tick ready` line is normal and not a failure — the monitor reopens the port a fraction of a second after the board starts running. | |
| A12 | **Unplug the USB cable** while the ticks are streaming. | Within about a second: the ticks stop, the monitor prints `-- Board disconnected. Plug the USB cable back in, then click Connect.`, the pill goes grey **Not connected**, the button goes back to **Connect**, and the message box greys out. **The page must not freeze** — click Compile and watch it still work. | |
| A13 | Plug the cable back in, wait three seconds, click **Connect**. | Either it connects straight away, or Chrome asks you to pick the board once (a replug can hand out a fresh port). Then `-- Connected at 9600 baud.` and `tick: 1`, `tick: 2`, … again. A replug does not need a page reload. | |

If A10 shows the four monitor lines in that order and the ticks come back, and A12 does not wedge
the page, **the T4 gate is green.** Say so in the commit or tell the lead.

---

## Part B — the rest of the panel

None of these is the gate, but each one is a hand in the air during a lesson.

| # | Do this | Expect | Actual |
|---|---|---|---|
| B1 | While ticks are streaming, scroll the monitor output **up** with the wheel. | The **Autoscroll** tick box unticks itself, and the view stays where you put it while new lines keep arriving below. This is the scroll lock. | |
| B2 | Scroll back down to the bottom. | Autoscroll re-ticks itself and the view starts chasing the newest line again. Ticking the box by hand does the same thing. | |
| B3 | Tick **Timestamps**. | Every line — including the ones already on screen — gains a prefix like `[14:32:07.418] `. Untick it and they all go away again. The times are local Chromebook time. | |
| B4 | Click the monitor's **Clear** link. | The monitor output empties. The **Output** panel above it is untouched (it has its own Clear), the connection stays up, and new ticks keep arriving. | |
| B5 | Set **Ending** to *No line ending*, type `hi` and press Enter. | `> hi` appears, but the board does **not** answer `you said: hi` — the sketch waits for a newline that never comes. Set Ending back to *Newline*, send `hi` again, and the answer arrives (possibly as `you said: hihi`, since the first `hi` was still sitting in the board's buffer). | |
| B6 | Change **Baud** to 19200 while connected. | `-- Now listening at 19200 baud.`, and the output turns to garbage like `ÿð@Cÿ` because the board is still sending at 9600. Set it back to 9600: `-- Now listening at 9600 baud.` and the ticks read properly again. Changing baud reopens the port, so the board resets and the count restarts. | |
| B7 | Click **Disconnect**. | `-- Disconnected.`, pill grey **Not connected**, message box greyed out, button reads **Connect**. The board keeps running the sketch — the L LED keeps flashing — it is only the page that stopped listening. | |
| B8 | Click **Hide**, then reload the page (F5). | The panel comes back **collapsed**, because that is how you left it. Click Show: the Baud dropdown still reads whatever you last chose. The output area starts empty apart from the first `-- Click Connect…` line; nothing from before the reload is kept. | |
| B9 | With the monitor **connected**, open the Arduino IDE's own Serial Monitor on the same COM port. | The Arduino IDE fails to open the port, or this page's monitor drops with `-- Board disconnected…`. Either is correct — one port, one owner. Close the Arduino IDE afterwards. | |
| B10 | Reverse of B9: close everything, open the **Arduino IDE** serial monitor on the board first, then click **Connect** on this page. | Red-free but plain: the monitor prints `-- Could not open the board's port. Either something else is using it — close the Arduino IDE and any other tab with this page open — or the board came unplugged. Plug it back in, then click Connect again.` No stack trace, no hang, and Connect is clickable again. | |
| B11 | Reload the page (so no port is remembered in the tab), click **Connect**, and press **Cancel** in Chrome's port chooser. | The monitor prints `-- No board chosen. Plug the Uno in and click Connect again — the next list shows every port on the computer, so pick the one the board is on.` It says **Connect**, not "Upload". Connect is clickable again, and the next click lists every serial port on the computer. | |
| B12 | Open the page in **Firefox**. | The Output panel gives the "this browser cannot talk to USB devices" message as in T3 B8, the monitor's **Connect** button is **greyed out**, and the monitor shows `-- The Serial Monitor needs Chrome too. Connect is switched off in this browser.` | |
| B13 | *(Optional, memory check.)* Change `delay(1000)` to `delay(1)` in the Counter sketch, compile, upload, and let it run for two minutes with the monitor open. | The page stays responsive and Chrome's memory does not climb without limit: the monitor keeps only the last **2000 lines** and drops the rest. Scroll up — the top of the buffer is a `count:` line in the thousands, not `count: 1`. Put the delay back to 1000 afterwards. | |

### On a managed Chromebook, additionally

| # | Do this | Expect | Actual |
|---|---|---|---|
| C1 | Run Part A steps A4–A13 on a **managed student** Chromebook against <https://uploadmycode.com>, with a board from the classroom set. | Identical behaviour to Windows. This is the run that counts for the classroom. | |
| C2 | With the panel open, look at how much of the editor is left on the Chromebook's screen. | The editor should still show a workable number of lines with both the Output and the Serial Monitor panels open. If it is uncomfortably squeezed, say so — the monitor's height is one number in `web/src/style.css` (`.monitor-output { height: 9rem }`). | |

---

## When it does not work

### The counter never appears, but the upload worked

Almost always a baud mismatch: the sketch says `Serial.begin(9600)` and the monitor must say 9600
too. Garbage characters mean the two disagree; **nothing at all** usually means the board reset and
is waiting, so press the board's reset button once with the monitor connected.

### Upload fails only when the monitor is connected

That is the handover failing, and it is the one thing this task is about. Note **which** of the four
lines from A10 appeared before it broke:

- No `-- Paused for upload…` at all → `pauseForUpload()` was not reached; tell the lead.
- Paused, then "Could not open the board's port" from the **upload** → Chrome had not finished
  handing the port back. Raise `reopenDelayMs` in `web/src/main.ts`'s `new SerialMonitor({…})` — but
  the delay that matters here is on the flasher's side, so tell the lead rather than guessing.
- Uploaded fine, then `-- Could not reopen the board: …` → the reverse: the monitor came back too
  early. `reopenAttempts` is 3 and `reopenDelayMs` is 250 ms in `web/src/monitor.ts`; raising the
  delay to 500 is the first thing to try, and it is a one-line change.

### Everything doubles up: `ccoouunntt`

Two readers on one port — a second tab with the page open, or the Arduino IDE. Close them.

---

## Sketch text for these steps

### Counter (step A4)

Compiles to **3862 bytes** (11% by `arduino-cli`, shown as 12% on the page, which rounds instead of
truncating). Checked against the pinned toolchain on 2026-08-31.

```cpp
// Serial monitor test sketch. Counts once a second, blinks the L LED with the
// count, and repeats back anything you send it.
unsigned long count = 0;

void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("counter ready");
}

void loop() {
  count = count + 1;
  Serial.print("count: ");
  Serial.println(count);
  digitalWrite(LED_BUILTIN, count % 2);

  if (Serial.available() > 0) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    Serial.print("you said: ");
    Serial.println(line);
  }

  delay(1000);
}
```

### Tick (step A9)

**3858 bytes.** Three changes from Counter — two different words and half the delay — so that a
successful second upload is visible from across the room and unmistakable in the monitor.

```cpp
// The same sketch with two changes you can see: it says "tick" instead of
// "count", and it goes twice as fast.
unsigned long count = 0;

void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("tick ready");
}

void loop() {
  count = count + 1;
  Serial.print("tick: ");
  Serial.println(count);
  digitalWrite(LED_BUILTIN, count % 2);

  if (Serial.available() > 0) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    Serial.print("you said: ");
    Serial.println(line);
  }

  delay(500);
}
```

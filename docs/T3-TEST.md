# T3 manual test — flashing a real Uno from the browser

**Status: NOT run by the worker session that wrote it, and it cannot be.** The T3 session had no
board and no browser. What *was* run headlessly, and passed:

- `npm run typecheck` — clean.
- `npm test` — 22 tests, including the Intel HEX parser against the real Blink hex the live
  container returns (924 bytes, first bytes `0C 94 5C 00`), a damaged-checksum case, and the whole
  STK500v1 conversation against a fake Uno (sync retry, signature check, the exact 133 bytes of
  page 0, the padded last page, leave-progmode last).
- `npm run build` — clean.

**None of that touches a wire.** Everything below — the reset pulse actually resetting a board, the
baud rate, the port permissions, the LED — is unverified. Dalton runs this. Until he does, T3 is
not green.

If a step fails, read [When it does not work](#when-it-does-not-work) at the bottom before
changing any code; the two most likely faults are named there with the exact lines to change.

---

## What you need

- One Uno (genuine R3, or a CH340 clone — test both if the classroom has both) and its USB
  cable. Nothing else plugged into the board.
- Google Chrome. Not Edge-in-IE-mode, not Firefox. On a Chromebook, a **managed student**
  Chromebook is the one that matters; a personal one proves less.
- Nothing else talking to the board: **close the Arduino IDE**, close any other tab with this page
  open, close PuTTY / the ChromeOS serial terminal.

## Setup — two terminals

Same as the T2 setup. Both stay open for the whole test.

**Terminal 1 — the compile server**

```powershell
cd <your clone folder>
$tools = "$PWD\tools"
$env:ARDUINO_CLI = "$tools\arduino-cli\arduino-cli.exe"
$env:ARDUINO_DIRECTORIES_DATA = "$tools\arduino-data"
$env:ARDUINO_DIRECTORIES_USER = "$tools\arduino-user"
$env:ARDUINO_DIRECTORIES_DOWNLOADS = "$tools\arduino-downloads"
node container\server.js
```

Expected, immediately: `{"event":"listening","port":8080,"fqbn":"arduino:avr:uno"}`

**Terminal 2 — the editor**

```powershell
cd <your clone folder>
npm run dev:web
```

Expected: `➜  Local:   http://localhost:5173/`

Open **http://localhost:5173/** in Chrome, in a normal (not Incognito) window.

> `http://localhost` counts as a secure context, so Web Serial works there. Any *other* host must be
> `https://`. Testing against the deployed <https://uploadmycode.com> instead is fine and skips
> terminal 1 — and it is the only way to test on a Chromebook. The steps are otherwise identical.

Plug the Uno in **now**, before the first upload, and leave it plugged in for the whole of Part A.

> Since T4 there is also a collapsed **SERIAL MONITOR** strip under the Output panel. Leave it
> collapsed for this test: none of the steps below change because of it. Sharing one board between
> that monitor and the Upload button is its own document, [docs/T4-TEST.md](T4-TEST.md).

---

## Part A — the gate

These eleven steps are the T3 gate. Fill in "Actual" as you go.

| # | Do this | Expect | Actual |
|---|---|---|---|
| 1 | Look at the toolbar. | Buttons read: New, Rename, Delete, Download, Import, then Autocomplete, then **Compile** and **Upload** on the right. **Upload is greyed out.** Hover it: the tooltip says "Compile first — the board can only be sent a sketch that has just compiled." | |
| 2 | Click in the editor, Ctrl+A, and paste the **Blink** sketch from the bottom of this file. | The Blink code replaces the template, syntax-coloured. Upload is **still greyed out** — pasting is not compiling. | |
| 3 | Click **Compile**. | Status pill goes `Compiling…` then green **`Compiled`**. Output: `Compiled with no errors.` and `Program size: 924 bytes of 32256 (3%).` **Upload is now enabled**, and its tooltip reads "Send this sketch to the Uno over USB." | |
| 4 | Type a single space at the end of any line. | Upload greys out again the instant you type. The status pill goes back to `Ready`. | |
| 5 | Press Ctrl+Z to undo the space, then click **Compile** again. | Green `Compiled`, Upload enabled again. | |
| 6 | Click **Upload**. | Chrome opens its port chooser: a small window titled something like "localhost:5173 wants to connect to a serial port", listing your board — Chrome names it whatever the driver does, so expect something like `USB Serial Device (COM4)`, `Arduino Uno`, or `USB-SERIAL CH340`. **Only boards on the two allowed USB vendor ids are listed**, so if the list is empty go to [No board in the list](#no-board-in-the-list). | |
| 7 | Click your board, then **Connect**. | Within about two seconds: the RX/TX LEDs on the board flicker, a progress bar appears under "Output" counting `page 1 of 8` … `page 8 of 8`, the status pill reads `Uploading…` and then green **`Uploaded`**, and the output reads `Uploaded 924 bytes in NNN ms (8 pages).` and `The board is running your sketch now.` NNN should be somewhere around 300–1500. | |
| 8 | Look at the board. | The orange **L** LED next to pin 13 is blinking: one second on, one second off, forever. This is the gate. | |
| 9 | **Without touching the USB cable**, click in the editor and change **both** `delay(1000);` lines to `delay(100);`. Click **Compile**. | Green `Compiled`, `Program size: 922 bytes of 32256 (3%).` (Two bytes smaller: the shorter constant. Confirmed against the live compiler on 2026-09-01.) Upload is enabled. | |
| 10 | Click **Upload** again. | **No port chooser this time** — Chrome remembers the board. Straight to the progress bar, `page 1 of 8` … `page 8 of 8`, and a green `Uploaded 922 bytes in NNN ms (8 pages).` | |
| 11 | Look at the board. | The L LED is now blinking about five times a second. Second upload, no replug: gate passed. | |

If steps 8 and 11 both show the LED doing the right thing, **the T3 gate is green.** Write that in
the commit or tell the lead.

---

## Part B — the failure messages

These are the messages a fourteen-year-old hits on a bad day. None of them is the gate, but a wrong
one costs a whole period of class time.

| # | Do this | Expect | Actual |
|---|---|---|---|
| B1 | Click **Upload**, and in the port chooser click **Cancel** instead of Connect. | Red status `No board`. Output: "No board chosen. Plug the Uno in and click Upload again — the next list shows every port on the computer, so pick the one the board is on." Nothing hangs; Upload is clickable again. | |
| B2 | Click **Upload** again, and Cancel again. | The chooser this time lists **every** serial port on the computer, not just the boards (on Windows you will see COM ports for other things). After cancelling: "No board chosen. Check the USB cable is plugged into the Uno and into the Chromebook, then click Upload again." | |
| B3 | Open the Arduino IDE (or any serial terminal) and connect it to the Uno's port. Leave it connected. Back in Chrome, Compile and click **Upload**, pick the board. | Red status `Upload failed` and a message naming the clash: "Could not open the board's port. Either something else is using it — close the Arduino IDE and any other tab with this page open — or the board came unplugged…" **Not** a stack trace, and not a hang. Close the Arduino IDE afterwards. | |
| B4 | **Unplug the USB cable.** Click **Upload**. | `Upload failed`, with either the B3 message (Chrome cannot open a port whose device is gone) or "The board did not answer. Unplug the board, plug it back in, then try Upload again." Either is fine — both tell you to plug it in. A frozen page is not fine. Plug the board back in afterwards. | |
| B5 | With the board plugged back in: press and **hold** the board's reset button, then click **Upload** and pick the board, and keep holding reset for ten seconds. | After about three seconds of trying: red `Upload failed`, message exactly "The board did not answer. Unplug the board, plug it back in, then try Upload again." Release reset. | |
| B6 | Click **Upload** once more (board plugged in, nothing held). | It works again — a failed upload does not wedge the page or leave the port locked. | |
| B7 | Open the same page in a **second Chrome tab**, compile Blink there, and click Upload while the first tab still has the board. | The second tab reports the port is in use, in the words from B3. (This is the classroom case of a student opening the page twice.) | |
| B8 | Open **http://localhost:5173/** in **Firefox**. | The Output panel says, on load, that the browser cannot talk to USB devices and to use Chrome, and a red **Web Serial test page** link appears in the Output panel header. Click it: `/serial-test.html` opens in a new tab and says Web Serial is not available. Since T4, the Serial Monitor's **Connect** button is greyed out in the same breath. | |

### On a managed Chromebook, additionally

| # | Do this | Expect | Actual |
|---|---|---|---|
| C1 | Do Part A steps 1–11 on a **managed student** Chromebook against <https://uploadmycode.com>, with a board from the classroom set. | Identical behaviour to Windows. | |
| C2 | If the port chooser never appears and the page says Web Serial is blocked, stop and take `/serial-test.html` and `docs/CHROMEBOOK-CHECKLIST.md` to district IT. | This is risk spike 1 in PLAN.md, not a bug in T3. | |
| C3 | Repeat step 6–8 with a **CH340 clone** Uno as well as a genuine one. | Both appear in the filtered chooser (`0x2341` and `0x1A86` are both allowed) and both flash. | |

---

## When it does not work

Read this before editing anything.

### "The board did not answer" every time

This is the single most likely failure, and it is almost certainly the reset pulse, not the
protocol. The flasher toggles DTR and RTS to reset the board, and which *edge* actually resets it
depends on the USB-serial chip. The current code deliberately makes both edges:

`web/src/flash/stk500v1.ts`, `resetIntoBootloader()`:

```ts
await transport.setSignals({ dataTerminalReady: false, requestToSend: false });
await sleep(timing.resetPulseMs);   // 50 ms
await transport.setSignals({ dataTerminalReady: true, requestToSend: true });
await sleep(timing.resetPulseMs);   // 50 ms
await transport.setSignals({ dataTerminalReady: false, requestToSend: false });
await sleep(timing.resetSettleMs);  // 250 ms
```

Things to try, in order, each of them a one-line change to `DEFAULT_TIMING` in the same file:

1. **Watch the board while you click Upload.** If the L LED flashes and the RX LED blinks once, the
   board *is* resetting and the problem is timing, not polarity — try 2. If nothing on the board
   moves at all, the reset never happened — try 3.
2. Raise `resetSettleMs` from 250 to 400, and lower it to 100. Optiboot only listens for about a
   second after reset, so both "too early" and "too late" look identical from the browser. One of
   the two directions usually fixes it.
3. Swap the order: assert first (`true, true`), then release. Reversing the two `setSignals` calls
   in the middle of that block is the whole change. Some CH340 drivers invert the lines.
4. Raise `syncAttempts` from 5 to 10. Costs nothing when the board is healthy.

Do **not** change the byte sequences to fix this. `npm test` proves the bytes are right against the
protocol; only the reset is guesswork.

### No board in the list

The chooser is filtered to USB vendor `0x2341` (Arduino) and `0x1A86` (CH340). A board with some
other chip (FTDI `0x0403`, or a CP2102 `0x10C4`) will not show. Cancel — the next Upload click
lists every port, which is exactly what that fallback is for. If the classroom's boards are all on
a fourth chip, add its vendor ID to `VENDOR_ARDUINO`/`VENDOR_CH340` in `web/src/flash/serial.ts`.

### It uploads but the LED does nothing

The upload reported success, so the bytes went out and the board acknowledged every page. Check the
obvious first: it is the small orange **L** LED beside pin 13, not the green ON LED. If the board
was doing something else before, and now does nothing at all, the sketch was written to the wrong
address — tell the lead, and quote the "page N of 8" count you saw.

### "That board is not an Uno"

The chip answered with a signature that is not `1E 95 0F`. That is real: it is a Nano/Mega/Leonardo
or a counterfeit with a different chip. The message names the signature it got — write it down.
Uno-only is a locked decision in PLAN.md; do not widen it without Dalton.

---

## Sketch text for these steps

### Blink (step 2)

Compiles to 924 bytes.

```cpp
// the setup function runs once when you press reset or power the board
void setup() {
  // initialize digital pin LED_BUILTIN as an output.
  pinMode(LED_BUILTIN, OUTPUT);
}

// the loop function runs over and over again forever
void loop() {
  digitalWrite(LED_BUILTIN, HIGH);  // turn the LED on (HIGH is the voltage level)
  delay(1000);                      // wait for a second
  digitalWrite(LED_BUILTIN, LOW);   // turn the LED off by making the voltage LOW
  delay(1000);                      // wait for a second
}
```

### Fast Blink (step 9)

The same sketch with both delays changed to 100. **922 bytes** (checked against the live compiler
on 2026-09-01). Step 9 exists so that the second upload changes something you can see across the
room without changing the sketch's shape — if the LED keeps blinking at one second, the second
upload silently did nothing.

```cpp
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(100);
  digitalWrite(LED_BUILTIN, LOW);
  delay(100);
}
```

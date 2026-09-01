# T2 manual test — the editor in a real browser

**Status: NOT run by the worker session that wrote it.** The session that built T2 had no way to
drive a real browser. Parts 1 and 2 of the T2 gate (typecheck, build, and the error parser against
real `arduino-cli` output) were run headlessly and passed; everything in this file is part 3, the
browser half, and it is **unverified** until someone works through it.

Dalton runs this. Every step says exactly what to click and exactly what should happen. Write the
"Actual" column in as you go; anything that does not match is a T2 bug, not a T3 problem.

---

## Setup — two terminals

Both must stay open for the whole test.

**Terminal 1 — the compile server** (this is the same `container/server.js` the container runs; see
the README section "Running the compile server without Docker"). If `tools/` is not there yet, run
the README recipe first.

```powershell
cd C:\Users\Mo Chara\Desktop\uploadmycode
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
cd C:\Users\Mo Chara\Desktop\uploadmycode
npm run dev:web
```

Expected: `➜  Local:   http://localhost:5173/`

The dev server proxies `/api/compile` to `http://localhost:8080/compile`, so the page talks to the
real compiler on exactly the path it will use in production.

Open **http://localhost:5173/** in Chrome. Use a normal (not Incognito) window: the test needs
`localStorage` to survive a reload.

> Starting clean: if you have used the page before, open DevTools (F12) → Application → Local
> Storage → `http://localhost:5173` → delete the three `uno-ide.v1.*` keys, then reload. Steps 1
> and 2 below assume a first visit.

---

## Part A — the gate (these three are the T2 gate)

| # | Do this | Expect | Actual |
|---|---|---|---|
| A1 | Look at the page on first load. | Toolbar across the top, editor filling the middle, "Output" panel at the bottom, footer at the very bottom. The sketch dropdown says `sketch`. The editor contains the blank Arduino template: `void setup() {` with `// put your setup code here, to run once:`, then `void loop() {` with `// put your main code here, to run repeatedly:`. | |
| A2 | In the **Examples** dropdown, choose **Blink**. | A new sketch called `Blink` appears in the Sketch dropdown and opens. The editor shows the classic Blink comment block and code, syntax-coloured. | |
| A3 | Click **Compile**. | The status pill turns to `Compiling…`, then within a few seconds to a green **`Compiled`**. The output panel reads `Compiled with no errors.` and `Program size: 924 bytes of 32256 (3%).` | |
| A4 | In the editor, find the line `digitalWrite(LED_BUILTIN, HIGH);` (line 33). Delete the semicolon at the end of it. | The line now ends `digitalWrite(LED_BUILTIN, HIGH)`. | |
| A5 | Click **Compile**. | Status pill turns red and reads **`Errors`**. In the output panel a red clickable row appears: `Line 34:3  error: expected ';' before 'delay'`. Underneath it, the raw compiler text, starting `sketch.ino: In function 'void loop()':`. | |
| A6 | Look at the editor. | **Line 34** — the `delay(1000);` line, the one gcc named — has a pink/red background and a red bar down its left edge, and the editor has scrolled so it is visible. (gcc points at the token after the missing semicolon, so line 34 is correct, not line 33.) | |
| A7 | Click somewhere else in the editor, then click the red error row in the output panel. | The caret jumps back to line 34, column 3. | |
| A8 | Put the semicolon back on line 33 and click **Compile**. | Status goes green (`Compiled`) again, the red row disappears, and the red line highlight is gone. | |
| A9 | Press **F5** to reload the page. | The page comes back with `Blink` still selected in the Sketch dropdown and the Blink code still in the editor, exactly as you left it. | |

If A3, A5+A6, and A9 all pass, the T2 gate is green.

---

## Part B — the rest of T2

| # | Do this | Expect | Actual |
|---|---|---|---|
| B1 | Type `digi` in the middle of `loop()`. | A completion popup appears with **digitalWrite** and **digitalRead**, each with its signature beside it (`(pin, value)`, `(pin)`). Press Enter on `digitalWrite`: it inserts `digitalWrite(pin, HIGH)` with `pin` selected; Tab moves to the next placeholder. | |
| B2 | Untick the **Autocomplete** checkbox in the toolbar. Type `digi` again. | **No popup at all.** Nothing appears, and Ctrl-Space does nothing either. | |
| B3 | Reload the page (F5). | The Autocomplete checkbox is still unticked. Typing `digi` still shows nothing. | |
| B4 | Tick **Autocomplete** back on and type `digi`. | The popup is back. Leave it ticked. | |
| B5 | Type `for` and accept the `for` snippet. | A full `for (int i = 0; i < count; i++) { }` block is inserted with `count` selected. | |
| B6 | Click **New**. Accept the suggested name. | A new empty sketch opens containing the blank Arduino template (same text as A1), and it is selected in the Sketch dropdown. | |
| B7 | Click **Rename**, type `my test`, OK. | The dropdown entry changes to `my test`. Reload: it is still `my test`. | |
| B8 | Click **Download**. | Chrome downloads `my test.ino`. Open it in Notepad: it is the sketch text. | |
| B9 | Click **Upload**, pick the `my test.ino` you just downloaded. | A new sketch `my test 2` appears and opens with the same code. (Names are never silently overwritten.) | |
| B10 | Click **Delete** on `my test 2`, confirm. | It disappears from the dropdown and another sketch opens. Deleting the last remaining sketch gives you a fresh blank `sketch`. | |
| B11 | Open each of the five **Examples** in turn and Compile each one. | All five compile green: Blink, Button, AnalogReadSerial, Fade, Servo Sweep. (Servo Sweep proves the container's Servo library is reachable.) | |
| B12 | Stop the compile server (Ctrl-C in terminal 1) and click **Compile**. | Status reads `Failed` and the output says `Could not reach the compiler. Check the Wi-Fi and try again.` — not a blank page or a stack trace. Restart the server afterwards. | |
| B13 | Switch ChromeOS/Windows to dark mode (Settings → Appearance), with the page open. | The whole page — toolbar, editor, gutter, output panel, footer — flips to a dark palette and stays readable. Switch back to light and it flips back. No reload needed. | |
| B14 | Look at the footer. | It reads "Arduino Uno only. Internal district tool." on the left and a **Made by Dalton Fowler** link on the right. Clicking it opens `https://daltonjfowler.com` in a **new tab**, leaving the editor open. | |
| B15 | Narrow the window to about half the screen. | The toolbar wraps onto two rows. Nothing is cut off and the page never scrolls sideways. | |
| B16 | Press **Ctrl+Enter**. | Same as clicking Compile. | |
| B17 | Open `http://localhost:5173/serial-test.html`. | The old Web Serial diagnostic page, moved here from the T0 placeholder. The bordered box says whether Web Serial is available, and the **Test Web Serial (pick a port)** button still opens Chrome's port chooser and prints `usbVendorId` / `usbProductId`. This is the page `docs/CHROMEBOOK-CHECKLIST.md` now sends the district to. | |

### Checking the hex is kept for T3

After a green compile, open DevTools (F12) → Console and type:

```js
window.uploadmycode.state.hex.slice(0, 60)
```

For Blink, expect exactly `:100000000C945C000C946E000C946E000C946E00CA` followed by a line break —
the first record of an Intel HEX file. Then type one character in the editor and run it again: it
is now `null`, because the hex no longer matches the code. T3's Upload button relies on that.

---

## What was already verified headlessly

Run these two yourself if you want to see them again; both exit 0.

```powershell
npm run typecheck
npm test
npm run build
```

Also confirmed by the T2 session, against the local compile server through the Vite proxy on
`/api/compile` (so this exercises the real request path, not a stub):

- All five examples compiled: Blink 924 bytes, Button 892, AnalogReadSerial 1848, Fade 1144,
  Servo Sweep 2128. Every `hex` started with `:10`.
- Blink with the semicolon removed from line 33 returned
  `sketch.ino:34:3: error: expected ';' before 'delay'`, which the parser turned into
  `{ line: 34, column: 3, severity: "error", message: "expected ';' before 'delay'" }`.

What that does **not** prove, and what Part A is for: that the DOM is wired up, that CodeMirror
renders, that the line decoration lands on the right line on screen, and that localStorage survives
a reload.

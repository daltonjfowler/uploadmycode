# T2 manual test — the editor in a real browser

**Status: NOT run by the worker session that wrote it.** The session that built T2 had no way to
drive a real browser. Parts 1 and 2 of the T2 gate (typecheck, build, and the error parser against
real `arduino-cli` output) were run headlessly and passed; everything in this file is part 3, the
browser half, and it is **unverified** until someone works through it.

Dalton runs this. Every step says exactly what to click and exactly what should happen. Write the
"Actual" column in as you go; anything that does not match is a T2 bug, not a T3 problem.

**Updated during T3.** The Examples dropdown was removed (Dalton's call: students get their code
from the lesson, not from a menu), so the steps that used to pick an example now paste the sketch
text printed at the bottom of this file. The button that opens a `.ino` from disk was renamed
**Import**, because T3 added an **Upload** button and "Upload" means "send it to the board", the
way it does in the Arduino IDE (the desktop program). The Upload button itself is tested in
`docs/T3-TEST.md`, not here.

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
> Storage → `http://localhost:5173` → delete every `uno-ide.v1.*` key, then reload. Steps 1
> and 2 below assume a first visit.

> **About the class phrase (added in T5).** In production `/api/compile` goes through the Worker,
> which refuses any compile that does not carry today's class phrase. The first Compile of a tab
> therefore shows a **Class phrase** field in the Output panel and sends nothing until it is filled
> in; the phrase is kept in `sessionStorage` for that tab only. The dev server proxies straight to
> the compile server and never touches the Worker, so **no phrase is asked for in the steps below**.
> To exercise the phrase itself, set one at `/teacher.html` on the live site and run A2 and A3
> against <https://uploadmycode.com>. See [DEPLOY.md](DEPLOY.md).

---

## Part A — the gate (these three are the T2 gate)

| # | Do this | Expect | Actual |
|---|---|---|---|
| A1 | Look at the page on first load. | Toolbar across the top, editor filling the middle, "Output" panel at the bottom, footer at the very bottom. The sketch dropdown says `sketch`. The editor contains the blank sketch template: `void setup() {` with `// put your setup code here, to run once:`, then `void loop() {` with `// put your main code here, to run repeatedly:`. There is **no** Examples dropdown. | |
| A2 | Click in the editor, press Ctrl+A, then paste the **Blink** sketch from "Sketch text for these steps" at the bottom of this file. | The editor shows the Blink comment block and code, syntax-coloured. The sketch is still called `sketch`. `digitalWrite(LED_BUILTIN, HIGH);` must land on **line 33** — check the gutter; if it does not, the paste picked up an extra blank line and the line numbers below will be off by one. | |
| A3 | Click **Compile**. | The status pill turns to `Compiling…`, then within a few seconds to a green **`Compiled`**. The output panel reads `Compiled with no errors.` and `Program size: 924 bytes of 32256 (3%).` | |
| A4 | In the editor, find the line `digitalWrite(LED_BUILTIN, HIGH);` (line 33). Delete the semicolon at the end of it. | The line now ends `digitalWrite(LED_BUILTIN, HIGH)`. | |
| A5 | Click **Compile**. | Status pill turns red and reads **`Errors`**. In the output panel a red clickable row appears: `Line 34:3  error: expected ';' before 'delay'`. Underneath it, the raw compiler text, starting `sketch.ino: In function 'void loop()':`. | |
| A6 | Look at the editor. | **Line 34** — the `delay(1000);` line, the one gcc named — has a pink/red background and a red bar down its left edge, and the editor has scrolled so it is visible. (gcc points at the token after the missing semicolon, so line 34 is correct, not line 33.) | |
| A7 | Click somewhere else in the editor, then click the red error row in the output panel. | The caret jumps back to line 34, column 3. | |
| A8 | Put the semicolon back on line 33 and click **Compile**. | Status goes green (`Compiled`) again, the red row disappears, and the red line highlight is gone. | |
| A9 | Press **F5** to reload the page. | The page comes back with `sketch` still selected in the Sketch dropdown and the Blink code still in the editor, exactly as you left it. | |

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
| B6 | Click **New**. Accept the suggested name. | A new empty sketch opens containing the blank sketch template (same text as A1), and it is selected in the Sketch dropdown. | |
| B7 | Click **Rename**, type `my test`, OK. | The dropdown entry changes to `my test`. Reload: it is still `my test`. | |
| B8 | Click **Download**. | Chrome downloads `my test.ino`. Open it in Notepad: it is the sketch text. | |
| B9 | Click **Import**, pick the `my test.ino` you just downloaded. | A new sketch `my test 2` appears and opens with the same code. (Names are never silently overwritten.) | |
| B10 | Click **Delete** on `my test 2`, confirm. | It disappears from the dropdown and another sketch opens. Deleting the last remaining sketch gives you a fresh blank `sketch`. | |
| B11 | Click **New**, accept the name, then paste the **Servo Sweep** sketch from the bottom of this file and Compile. | Green `Compiled`, `Program size: 2128 bytes of 32256 (7%).` This is the one step that proves the container's Servo library is reachable — nothing else in the test uses `#include`. | |
| B12 | Stop the compile server (Ctrl-C in terminal 1) and click **Compile**. | Status reads `Failed` and the output says `Could not reach the compiler. Check the Wi-Fi and try again.` — not a blank page or a stack trace. Restart the server afterwards. | |
| B13 | Switch ChromeOS/Windows to dark mode (Settings → Appearance), with the page open. | The whole page — toolbar, editor, gutter, output panel, footer — flips to a dark palette and stays readable. Switch back to light and it flips back. No reload needed. | |
| B14 | Look at the footer. | It reads "Uno boards only. Internal district tool." on the left, then a **Teacher** link and a **Made by Dalton Fowler** link on the right. Clicking Made by Dalton Fowler opens `https://daltonjfowler.com` in a **new tab**, leaving the editor open. Teacher goes to `/teacher.html`, which the dev server does serve; its buttons will not work locally, though, because the dev server only proxies `/api/compile` and not the teacher API. Use the live site for the teacher page. | |
| B15 | Narrow the window to about half the screen. | The toolbar wraps onto two rows, with **Compile**, **Upload** and the status pill together on one of them. The editor keeps every row the panels below it do not need. Nothing is cut off and the page never scrolls sideways. | |
| B16 | Press **Ctrl+Enter**. | Same as clicking Compile. | |
| B17 | Open `http://localhost:5173/serial-test.html`. | The old Web Serial diagnostic page, moved here from the T0 placeholder. The bordered box says whether Web Serial is available, and the **Test Web Serial (pick a port)** button still opens Chrome's port chooser and prints `usbVendorId` / `usbProductId`. This is the page `docs/CHROMEBOOK-CHECKLIST.md` now sends the district to. | |
| B18 | **Live site only.** Set a phrase at <https://uploadmycode.com/teacher.html>, then open <https://uploadmycode.com/> in a fresh tab and click **Compile**. | Nothing is sent. A **Class phrase** field appears in the Output panel, the status pill reads `Phrase needed`, and the output says `Type today's class phrase to compile.` Type the phrase, press **Save**, and it compiles green: the field collapses to one small line reading `Class phrase set · Change`, and **Change** re-opens it. Reload the tab: it compiles without asking again and still shows that one line. Close the tab, open a new one: it asks again. Press **End now** on the teacher page and compile: `No class phrase is active. Ask your teacher.`, and the field opens again. | |
| B19 | Click **New**, accept the name, then open the **Library** dropdown in the toolbar and pick **Servo — hobby servos**. Open it a second time and pick **Servo** again. | The first pick puts `#include <Servo.h>` on **line 1**, a blank line under it and the template below that; the caret sits at the end of that line and the dropdown has snapped back to `Library…`. One **Ctrl+Z** takes the whole line out again. The second pick adds **nothing**: the status pill reads `Already included`, the output panel says `This sketch already has #include <Servo.h> on line 1.`, line 1 is highlighted as the current line, and both go back to `Ready` on their own after a couple of seconds. | |

### Checking the hex is kept for the Upload button

This is what makes Upload safe: the page will only flash hex that was built from the exact text on
screen. After a green compile, open DevTools (F12) → Console and type:

```js
window.uploadmycode.state.hex.slice(0, 60)
```

For Blink, expect exactly `:100000000C945C000C946E000C946E000C946E00CA` followed by a line break —
the first record of an Intel HEX file. Then type one character in the editor and run it again: it
is now `null`, because the hex no longer matches the code, and the Upload button greys out at the
same moment.

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

- Five sketches compiled: Blink 924 bytes, Button 892, AnalogReadSerial 1848, Fade 1144,
  Servo Sweep 2128. Every `hex` started with `:10`. (They were the Examples menu at the time; the
  menu is gone, but the sizes above are still what the compiler returns for that text. Blink's
  924 bytes was re-confirmed against the live container on 2026-09-01 during T3.)
- Blink with the semicolon removed from line 33 returned
  `sketch.ino:34:3: error: expected ';' before 'delay'`, which the parser turned into
  `{ line: 34, column: 3, severity: "error", message: "expected ';' before 'delay'" }`.

What that does **not** prove, and what Part A is for: that the DOM is wired up, that CodeMirror
renders, that the line decoration lands on the right line on screen, and that localStorage survives
a reload.

---

## Sketch text for these steps

There is no Examples menu any more. Copy the block you need from here — Ctrl+A in the editor first,
so you replace the template rather than adding to it.

### Blink (A2 onwards)

Compiles to **924 bytes**. `digitalWrite(LED_BUILTIN, HIGH);` is line 33 and `delay(1000);` is
line 34, which is what steps A4 to A7 depend on.

```cpp
/*
  Blink

  Turns an LED on for one second, then off for one second, repeatedly.

  Most Arduinos have an on-board LED you can control. On the UNO, MEGA and ZERO
  it is attached to digital pin 13, on MKR1000 on pin 6. LED_BUILTIN is set to
  the correct LED pin independent of which board is used.
  If you want to know what pin the on-board LED is connected to on your Arduino
  model, check the Technical Specs of your board at:
  https://www.arduino.cc/en/Main/Products

  modified 8 May 2014
  by Scott Fitzgerald
  modified 2 Sep 2016
  by Arturo Guadalupi
  modified 8 Sep 2016
  by Colby Newman

  This example code is in the public domain.

  https://www.arduino.cc/en/Tutorial/BuiltInExamples/Blink
*/

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

### Servo Sweep (B11)

Compiles to **2128 bytes**. The only sketch here with an `#include`, so it is the one that proves
the compile container really has the Servo library installed.

```cpp
/* Sweep
  by BARRAGAN <http://barraganstudio.com>
  This example code is in the public domain.

  modified 8 Nov 2013
  by Scott Fitzgerald
  https://www.arduino.cc/en/Tutorial/LibraryExamples/Sweep
*/

#include <Servo.h>

Servo myservo;  // create Servo object to control a servo
// twelve Servo objects can be created on most boards

int pos = 0;  // variable to store the servo position

void setup() {
  myservo.attach(9);  // attaches the servo on pin 9 to the Servo object
}

void loop() {
  for (pos = 0; pos <= 180; pos += 1) {  // goes from 0 degrees to 180 degrees
    // in steps of 1 degree
    myservo.write(pos);  // tell servo to go to position in variable 'pos'
    delay(15);           // waits 15 ms for the servo to reach the position
  }
  for (pos = 180; pos >= 0; pos -= 1) {  // goes from 180 degrees to 0 degrees
    myservo.write(pos);  // tell servo to go to position in variable 'pos'
    delay(15);           // waits 15 ms for the servo to reach the position
  }
}
```

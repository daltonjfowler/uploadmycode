# Chromebook + Web Serial checklist

This is the go/no-go check for the whole project. The site compiles sketches on a server, but the
**browser** is what flashes the Arduino Uno, using the Web Serial API. If managed Chrome policy
blocks Web Serial on student Chromebooks, nothing else in this project matters.

Do this **before** T2 (editor) and T3 (upload) are worth building out.

There are two parts:

1. Questions for district IT (below).
2. A one-Chromebook / one-Uno smoke test that produces a yes or no.

**Site origin to allowlist:** `https://uno-web-ide.daltonjfowler.workers.dev`

What the site is, in one paragraph for IT: an internally-built classroom tool for an Arduino unit.
It is served over HTTPS from Cloudflare. There is no install, no extension, no student account, and
no student data is stored on the server. The only device permission it ever needs is Web Serial
access to an Arduino board plugged into the student's USB port, to copy a compiled program onto it.

---

## Part 1 — Questions for district IT

### The policies that decide this

| Policy | What it controls | What we need |
|---|---|---|
| `DefaultSerialGuardSetting` | Default Web Serial behavior for all sites. `3` = sites may ask the user. `2` = access denied. Unset = sites may ask, and users can change it themselves. | Must **not** be `2` for our origin. `3` is fine. |
| `SerialAskForUrls` | URL patterns allowed to prompt the user for a serial port, even when the default is deny. | Add our origin here if the default is `2`. |
| `SerialBlockedForUrls` | URL patterns never allowed serial access. | Our origin must **not** appear here. |
| `SerialAllowAllPortsForUrls` | Origins auto-granted access to **all** serial ports, with no prompt. | We do not need this. Do not ask for it. |
| `SerialAllowUsbDevicesForUrls` | Origins auto-granted access to **specific** USB devices by vendor/product ID, with no prompt. | Optional. The smoothest classroom experience, still narrowly scoped. |

Policy reference pages:

- <https://chromeenterprise.google/policies/default-serial-guard-setting/>
- <https://chromeenterprise.google/policies/serial-allow-usb-devices-for-urls/>
- <https://chromeenterprise.google/policies/serial-allow-all-ports-for-urls/>

### Ask for one of these, in this order of preference

**Option A — least privilege, preferred.** Leave `DefaultSerialGuardSetting` at `3` (or unset) so
sites may ask, and confirm our origin is not in `SerialBlockedForUrls`. If the district default is
`2` (deny), add only our origin to `SerialAskForUrls`.

Result: the student clicks Upload, Chrome shows its own port chooser, the student picks the Arduino.
Chrome remembers the choice for that site until the profile is cleared. Nothing is granted silently.

**Option B — no prompt, scoped to Arduino boards only.** Everything in Option A, plus our origin in
`SerialAllowUsbDevicesForUrls`, limited to the vendor IDs of the classroom boards.

Result: no chooser at all. Faster with 30 students. Access is still limited to Arduino-class USB
serial chips on our one origin.

Example value (confirm the exact IDs with step 6 of the smoke test before submitting this):

```json
[
  {
    "devices": [
      { "vendor_id": 9025 },
      { "vendor_id": 10755 },
      { "vendor_id": 6790, "product_id": 29987 }
    ],
    "urls": ["https://uno-web-ide.daltonjfowler.workers.dev"]
  }
]
```

**Option C — do not request.** `SerialAllowAllPortsForUrls` grants every serial port with no prompt.
Broader than this project needs.

### USB IDs of the boards we use

`vendor_id` and `product_id` in the policy JSON are **decimal**, not hex.

| Board | Vendor ID | Product ID |
|---|---|---|
| Genuine Arduino Uno R3 | `0x2341` = **9025** | `0x0043` = **67** |
| Arduino.org-era Uno | `0x2A03` = **10755** | `0x0043` = **67** |
| CH340 clone Uno | `0x1A86` = **6790** | `0x7523` = **29987** |

Confirm against the actual classroom hardware. Step 6 of the smoke test prints the real numbers off
the board in your hand.

### Other questions to ask

1. Which OU do the student Chromebooks live in? The policy must apply to **that** OU, and to the
   student **user** accounts that sign in on them, not just to a test OU.
2. Is `DefaultSerialGuardSetting` currently set at the district level, and to what value?
3. Do students sign in with normal managed accounts, or in a managed guest session or kiosk mode?
   Permissions granted in a guest session do not survive sign-out, so the port chooser would appear
   every period. Good to know in advance, not a blocker.
4. Is `DeveloperToolsAvailability` restricted for students? Not needed for this project. It only
   changes how the smoke test is run (see step 5 note).
5. Are there other USB restrictions on the ChromeOS fleet that would stop a USB serial device from
   being recognized at all?
6. What ChromeOS version is the student fleet on?
7. Can we get **one** test Chromebook plus a test student account in the same OU as the class, so
   the smoke test below is a real result and not a teacher-account result?

---

## Part 2 — Smoke test: one Chromebook, one Uno

Run this on a **managed student Chromebook**, signed in as a **student account** in the same OU as
the class. A teacher account on a teacher device proves nothing about student policy.

**You need:** the Chromebook, one Arduino Uno, one USB cable that carries data (many charge-only
cables do not), and about ten minutes.

| # | Step | Expected | Actual |
|---|---|---|---|
| 1 | Sign in to the managed Chromebook as a student account. | Normal student session. | |
| 2 | Open `https://uno-web-ide.daltonjfowler.workers.dev/serial-test.html` | The "Web Serial test" page loads. (The site root is the editor; this page is the diagnostic.) | |
| 3 | Read the bordered box on the page. | "Web Serial API: **AVAILABLE** in this browser." | |
| 4 | Plug the Uno into the Chromebook. | Green power LED on the board is lit. | |
| 5 | Click the **Test Web Serial (pick a port)** button. | Chrome shows its own port chooser dialog, listing at least one port. | |
| 6 | Pick the Arduino in the chooser and click Connect. | Page prints `PASS: port chosen.` plus `usbVendorId` and `usbProductId`. **Write these numbers down.** | |
| 7 | Reload the page and click the button again. | Chrome may skip the chooser or show it again. Either is fine. Note which happened. | |
| 8 | Open `chrome://version` | Record the ChromeOS and Chrome version numbers. | |

Also record: date, tester name, OU name, board type (genuine or clone), and the exact text of any
error message.

### How to read the result

| What you saw | What it means | What to do |
|---|---|---|
| Step 3 says **NOT AVAILABLE** | Web Serial is switched off in this browser. Policy or an old ChromeOS. | Go back to IT with Option A. This is the blocker. |
| Step 5 throws `SecurityError` or a policy message | `DefaultSerialGuardSetting` is `2`, or the origin is in `SerialBlockedForUrls`. | Go back to IT with Option A. Send them the exact error text. |
| Step 5 chooser opens but is **empty** | Chrome is allowed, but ChromeOS does not see the board. Cable, port, or a USB-serial chip the OS has no driver for. | Try a known-data USB cable. Try the other USB port. Try a genuine Uno and a clone. This is a hardware problem, not a policy problem. |
| Step 5 throws `NotFoundError` after you closed the dialog | You cancelled. Not a failure. | Run step 5 again. |
| Step 6 prints PASS | **Green. Web Serial works on student Chromebooks.** | Record the IDs. T3 can proceed. |

A pass here does not yet prove the board can be flashed. It proves the browser is allowed to open
the port, which is the part the district controls. Flashing is proven by the T3 hardware gate.

### If it cannot pass

Web Serial blocked with no path to an exception kills the browser-flashing design. Do not paper over
it. The fallbacks, in order:

1. One teacher machine acts as the flashing station; students still write and compile on their own
   Chromebooks and the teacher uploads.
2. The optional T6 in-browser simulator, so a class with no working hardware path can still run code.

Both are worse than the real thing. Get the policy answer first.

---

## Part 3 — Report back

Send Dalton: pass or fail for every numbered step, the exact text of any error, the `usbVendorId`
and `usbProductId` from step 6, the versions from step 8, and which of Option A or Option B the
district agreed to.

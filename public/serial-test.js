// Plain script, no build step: this file is copied to the site root as-is
// so the district smoke test needs no DevTools and no editor.
var hasSerial = "serial" in navigator;

document.getElementById("serial-check").textContent = hasSerial
	? "Web Serial API: AVAILABLE in this browser."
	: "Web Serial API: NOT AVAILABLE in this browser.";

var result = document.getElementById("serial-result");

// The USB-serial chip behind each vendor id, so a teacher can tell which driver a board needs.
var CHIPS = {
	0x2341: "Arduino (genuine)",
	0x1a86: "WCH CH340 / CH9102 (clone Uno, many ESP32 boards)",
	0x10c4: "Silicon Labs CP210x (many ESP32 boards)",
	0x0403: "FTDI",
	0x303a: "Espressif built-in USB (ESP32-S2/S3/C3, not a classic ESP32)",
};

document.getElementById("serial-test").addEventListener("click", async function () {
	if (!hasSerial) {
		result.textContent = "FAIL: navigator.serial does not exist. Web Serial is off.";
		return;
	}
	result.textContent = "Asking for a port...";
	try {
		var port = await navigator.serial.requestPort();
		var info = port.getInfo();
		result.textContent =
			"PASS: port chosen.\nusbVendorId: " +
			info.usbVendorId +
			" (0x" +
			(info.usbVendorId || 0).toString(16) +
			")\nusbProductId: " +
			info.usbProductId +
			" (0x" +
			(info.usbProductId || 0).toString(16) +
			")\nUSB chip: " +
			(CHIPS[info.usbVendorId] || "unknown (not a USB board, or an unusual chip)");
	} catch (err) {
		result.textContent = "FAIL or CANCELLED: " + err.name + ": " + err.message;
	}
});

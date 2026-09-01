// Plain script, no build step: this file is copied to the site root as-is
// so the district smoke test needs no DevTools and no editor.
var hasSerial = "serial" in navigator;

document.getElementById("serial-check").textContent = hasSerial
	? "Web Serial API: AVAILABLE in this browser."
	: "Web Serial API: NOT AVAILABLE in this browser.";

var result = document.getElementById("serial-result");

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
			")";
	} catch (err) {
		result.textContent = "FAIL or CANCELLED: " + err.name + ": " + err.message;
	}
});

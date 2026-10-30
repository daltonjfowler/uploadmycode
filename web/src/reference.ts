/**
 * The Reference dialog's list: where to read about the language and every
 * library the compile images bundle (Dalton, 2026-10-29: "so kids can find
 * info on the stuff they use"). main.ts draws the dialog from this array and
 * nothing else, so adding a library to the Reference is one entry here.
 *
 * THIS LIST MUST STAY IN SYNC WITH `container/Dockerfile`,
 * `container/Dockerfile.esp32` and `LIBRARIES` in libraries.ts.
 * web/test/reference.test.mjs fails when an `arduino-cli lib install` line, a
 * Library dropdown entry or an ESP32 warm-up header has no entry here, or when
 * an entry names an install line that is gone.
 *
 * Where the links came from (checked 2026-10-29, every one answered 200):
 * - the `url=` line of each library's own library.properties, at the version the
 *   Dockerfile pins, or the `website` / `repository` of that version in
 *   arduino-cli's library index. Old www.arduino.cc/en/Reference/... links are
 *   written as the docs.arduino.cc page they redirect to. SPI's old link
 *   redirects to a 404, so it points at the SPI page that exists.
 * - ESP32 core libraries: the Espressif docs, and the library's folder in the
 *   arduino-esp32 repo at the exact core version the image installs
 *   (ESP32_CORE_VERSION, checked against the Dockerfile by the test).
 *
 * HID ships in the AVR core too but is left out on purpose: it needs a board
 * with native USB, which the Uno does not have.
 */

/** Which section of the dialog an entry sits in. "any" is the top, for everyone. */
export type ReferenceBoard = "any" | "uno" | "esp32";

export interface ReferenceLink {
	/** The link text. Short: it shares a line with the other links. */
	label: string;
	url: string;
}

export interface ReferenceEntry {
	/** What a student calls it. Library names stay their real names. */
	name: string;
	/** The header a sketch includes, without the angle brackets. None for parts that come in with another library. */
	header?: string;
	/** One plain line: what it is for. */
	about: string;
	board: ReferenceBoard;
	/** The exact name in the Dockerfile's `arduino-cli lib install` line, when one installs it. */
	install?: string;
	links: readonly ReferenceLink[];
}

/** The ESP32 core version in container/Dockerfile.esp32. The GitHub links point at this tag. */
export const ESP32_CORE_VERSION = "3.3.12";

const ESP32_DOCS = "https://docs.espressif.com/projects/arduino-esp32/en/latest";
const ESP32_LIBS = `https://github.com/espressif/arduino-esp32/tree/${ESP32_CORE_VERSION}/libraries`;

export const REFERENCE: readonly ReferenceEntry[] = [
	// ---- for everyone
	{
		name: "Language reference",
		about: "Every built-in command, like pinMode, digitalWrite, analogRead, delay and Serial.print.",
		board: "any",
		links: [{ label: "Language reference", url: "https://docs.arduino.cc/language-reference/" }],
	},

	// ---- UNO: installed by container/Dockerfile, in the order its install lines run
	{
		name: "Servo",
		header: "Servo.h",
		about: "Turn a hobby servo to an angle.",
		board: "uno",
		install: "Servo",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/servo/" },
			{ label: "Code (GitHub)", url: "https://github.com/arduino-libraries/Servo" },
		],
	},
	{
		name: "LiquidCrystal",
		header: "LiquidCrystal.h",
		about: "Show text on a character LCD wired to six pins.",
		board: "uno",
		install: "LiquidCrystal",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/liquidcrystal/" },
			{ label: "Code (GitHub)", url: "https://github.com/arduino-libraries/LiquidCrystal" },
		],
	},
	{
		name: "LiquidCrystal I2C",
		header: "LiquidCrystal_I2C.h",
		about: "Show text on an LCD with a 4-wire I2C backpack.",
		board: "uno",
		install: "LiquidCrystal I2C",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/liquidcrystal-i2c/" },
			{ label: "Code (GitHub)", url: "https://github.com/johnrickman/LiquidCrystal_I2C" },
		],
	},
	{
		name: "Stepper",
		header: "Stepper.h",
		about: "Move a stepper motor a set number of steps.",
		board: "uno",
		install: "Stepper",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/stepper/" },
			{ label: "Code (GitHub)", url: "https://github.com/arduino-libraries/Stepper" },
		],
	},
	{
		name: "Arduino SensorKit",
		header: "Arduino_SensorKit.h",
		about: "The Grove sensor kit: its screen, motion, air pressure, temperature and humidity sensors.",
		board: "uno",
		install: "Arduino_Sensorkit",
		links: [
			{ label: "Kit guide", url: "https://sensorkit.arduino.cc/" },
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/arduino_sensorkit/" },
			{ label: "Code (GitHub)", url: "https://github.com/arduino-libraries/Arduino_SensorKit" },
		],
	},
	// The kit's parts. Students include only Arduino_SensorKit.h, so no header.
	{
		name: "SensorKit screen (U8g2)",
		about: "The little OLED screen. Oled uses this library's commands, like Oled.drawString.",
		board: "uno",
		links: [
			{ label: "Oled commands", url: "https://github.com/olikraus/u8g2/wiki/u8x8reference" },
			{ label: "Code (GitHub)", url: "https://github.com/olikraus/u8g2" },
		],
	},
	{
		name: "SensorKit temperature and humidity (DHT20)",
		about: "The temperature and humidity sensor. Comes in with Arduino_SensorKit.h.",
		board: "uno",
		install: "DHT20",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/dht20/" },
			{ label: "Code (GitHub)", url: "https://github.com/RobTillaart/DHT20" },
			{ label: "DHT11 version", url: "https://github.com/Seeed-Studio/Grove_Temperature_And_Humidity_Sensor" },
		],
	},
	{
		name: "SensorKit motion (LIS3DHTR)",
		about: "The accelerometer that senses tilt and movement. Comes in with Arduino_SensorKit.h.",
		board: "uno",
		install: "Grove-3-Axis-Digital-Accelerometer-2g-to-16g-LIS3DHTR",
		links: [{ label: "Code (GitHub)", url: "https://github.com/Seeed-Studio/Seeed_Arduino_LIS3DHTR" }],
	},
	{
		name: "SensorKit air pressure (BMP280)",
		about: "The air pressure sensor. Comes in with Arduino_SensorKit.h.",
		board: "uno",
		links: [{ label: "Code (GitHub)", url: "https://github.com/Seeed-Studio/Grove_BMP280" }],
	},

	// ---- UNO: part of the AVR core, so no install line
	{
		name: "Wire",
		header: "Wire.h",
		about: "Talk to I2C parts, like screens and sensors, on the SDA and SCL pins.",
		board: "uno",
		links: [{ label: "Reference", url: "https://docs.arduino.cc/language-reference/en/functions/communication/wire/" }],
	},
	{
		name: "SPI",
		header: "SPI.h",
		about: "Talk to SPI parts, like SD card readers and some screens.",
		board: "uno",
		links: [{ label: "Reference", url: "https://docs.arduino.cc/language-reference/en/functions/communication/SPI/" }],
	},
	{
		name: "SoftwareSerial",
		header: "SoftwareSerial.h",
		about: "An extra serial port on any two pins, for parts like Bluetooth or GPS modules.",
		board: "uno",
		links: [{ label: "Reference", url: "https://docs.arduino.cc/learn/built-in-libraries/software-serial/" }],
	},
	{
		name: "EEPROM",
		header: "EEPROM.h",
		about: "Save small numbers that stay after the board is unplugged.",
		board: "uno",
		links: [{ label: "Reference", url: "https://docs.arduino.cc/learn/built-in-libraries/eeprom/" }],
	},

	// ---- ESP32: the core's own docs, then container/Dockerfile.esp32's install lines
	{
		name: "ESP32 docs",
		about: "Everything about coding the ESP32: pins, Wi-Fi, Bluetooth and the rest of its built-in libraries.",
		board: "esp32",
		links: [
			{ label: "ESP32 docs", url: `${ESP32_DOCS}/` },
			{ label: "All built-in libraries", url: `${ESP32_DOCS}/libraries.html` },
		],
	},
	{
		name: "ESP32Servo",
		header: "ESP32Servo.h",
		about: "Turn a hobby servo on the ESP32. Use this instead of Servo.",
		board: "esp32",
		install: "ESP32Servo",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/esp32servo/" },
			{ label: "Commands", url: "https://madhephaestus.github.io/ESP32Servo/annotated.html" },
			{ label: "Code (GitHub)", url: "https://github.com/madhephaestus/ESP32Servo" },
		],
	},
	{
		name: "LiquidCrystal I2C",
		header: "LiquidCrystal_I2C.h",
		about: "Show text on an LCD with a 4-wire I2C backpack.",
		board: "esp32",
		install: "LiquidCrystal I2C",
		links: [
			{ label: "Reference", url: "https://docs.arduino.cc/libraries/liquidcrystal-i2c/" },
			{ label: "Code (GitHub)", url: "https://github.com/johnrickman/LiquidCrystal_I2C" },
		],
	},

	// ---- ESP32: part of the ESP32 core (the ones container/esp32-buckets.js warms up)
	{
		name: "WiFi",
		header: "WiFi.h",
		about: "Join a Wi-Fi network.",
		board: "esp32",
		links: [
			{ label: "Reference", url: `${ESP32_DOCS}/api/wifi.html` },
			{ label: "Code and examples", url: `${ESP32_LIBS}/WiFi` },
		],
	},
	{
		name: "WebServer",
		header: "WebServer.h",
		about: "Make a web page the ESP32 serves, to show readings or take button presses.",
		board: "esp32",
		links: [{ label: "Code and examples", url: `${ESP32_LIBS}/WebServer` }],
	},
	{
		name: "HTTPClient",
		header: "HTTPClient.h",
		about: "Load web pages and send data to websites.",
		board: "esp32",
		links: [{ label: "Code and examples", url: `${ESP32_LIBS}/HTTPClient` }],
	},
	{
		name: "WiFiClientSecure",
		header: "WiFiClientSecure.h",
		about: "Secure https connections, used with HTTPClient.",
		board: "esp32",
		links: [{ label: "Code and examples", url: `${ESP32_LIBS}/NetworkClientSecure` }],
	},
	{
		name: "ESPmDNS",
		header: "ESPmDNS.h",
		about: "Give the ESP32 a name on the network, like myboard.local.",
		board: "esp32",
		links: [{ label: "Code and examples", url: `${ESP32_LIBS}/ESPmDNS` }],
	},
	{
		name: "BluetoothSerial",
		header: "BluetoothSerial.h",
		about: "Send text over Bluetooth, like a serial monitor with no cable.",
		board: "esp32",
		links: [
			{ label: "Reference", url: `${ESP32_DOCS}/api/bluetooth.html` },
			{ label: "Code and examples", url: `${ESP32_LIBS}/BluetoothSerial` },
		],
	},
	{
		name: "BLE",
		header: "BLEDevice.h",
		about: "Bluetooth Low Energy: talk to phones and other BLE gadgets.",
		board: "esp32",
		links: [
			{ label: "Reference", url: `${ESP32_DOCS}/api/ble.html` },
			{ label: "Code and examples", url: `${ESP32_LIBS}/BLE` },
		],
	},
	{
		name: "Preferences",
		header: "Preferences.h",
		about: "Save settings that stay after the ESP32 is unplugged.",
		board: "esp32",
		links: [
			{ label: "Reference", url: `${ESP32_DOCS}/api/preferences.html` },
			{ label: "Code and examples", url: `${ESP32_LIBS}/Preferences` },
		],
	},
	{
		name: "Wire",
		header: "Wire.h",
		about: "Talk to I2C parts, like screens and sensors.",
		board: "esp32",
		links: [
			{ label: "Reference", url: `${ESP32_DOCS}/api/i2c.html` },
			{ label: "Code and examples", url: `${ESP32_LIBS}/Wire` },
		],
	},
];

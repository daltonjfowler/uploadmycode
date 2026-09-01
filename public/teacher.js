(function () {
	"use strict";

	var API = "/api/teacher/phrase";
	var KEY_STORAGE = "uploadmycode.teacherKey";

	var keyInput = document.getElementById("key");
	var phraseInput = document.getElementById("phrase");
	var durationSelect = document.getElementById("duration");
	var display = document.getElementById("display");
	var phraseNow = document.getElementById("phrase-now");
	var countdown = document.getElementById("countdown");
	var message = document.getElementById("message");

	/** Unix ms the current phrase dies, or 0 when there is none. */
	var expiresAt = 0;

	// Short, spellable, classroom-safe. Three of these joined with
	// hyphens is easy to read off a projector and easy to type once.
	var WORDS = [
		"apple", "anchor", "banjo", "blue", "bridge", "cactus", "candle", "cedar",
		"cherry", "cobalt", "comet", "copper", "coral", "crayon", "delta", "dragon",
		"ember", "falcon", "ferry", "forest", "garden", "ginger", "granite", "harbor",
		"hazel", "indigo", "island", "jasper", "jungle", "kayak", "lantern", "lemon",
		"lily", "magnet", "mango", "maple", "marble", "meadow", "mint", "nickel",
		"olive", "orbit", "otter", "pancake", "pebble", "pepper", "piano", "pilot",
		"planet", "pumpkin", "quartz", "quilt", "rabbit", "radish", "ranger", "raven",
		"river", "robot", "rocket", "saffron", "sailor", "silver", "sparrow", "spruce",
		"sunset", "tandem", "thunder", "tiger", "timber", "tulip", "umbrella", "valley",
		"velvet", "walnut", "willow", "window", "yellow", "zebra"
	];

	function randomWord() {
		var pick = new Uint32Array(1);
		crypto.getRandomValues(pick);
		return WORDS[pick[0] % WORDS.length];
	}

	function generatePhrase() {
		var picked = [];
		while (picked.length < 3) {
			var word = randomWord();
			// Three different words: "robot-robot-maple" reads like a typo.
			if (picked.indexOf(word) === -1) picked.push(word);
		}
		return picked.join("-");
	}

	/**
	 * The Worker's own 429 sentence, verbatim, minutes and all.
	 *
	 * There is only one thing that answers 429 here: the site-wide
	 * guard that arms after a hundred WRONG keys from anywhere. A
	 * correct key is never refused by it, so seeing this means the
	 * key in the box is wrong, not that you are locked out.
	 */
	function busyText(body) {
		return body && body.error
			? body.error
			: "Too many wrong keys from everywhere right now. Try again in 15 minutes. The right key still works.";
	}

	function say(text, tone) {
		message.textContent = text;
		message.dataset.tone = tone || "plain";
	}

	function loadKey() {
		try {
			return window.localStorage.getItem(KEY_STORAGE) || "";
		} catch (error) {
			return "";
		}
	}

	function currentKey() {
		return keyInput.value.trim();
	}

	/**
	 * One call to the teacher API. Returns { status, body } and never
	 * throws, so every caller has one shape to read.
	 */
	function call(method, payload) {
		var key = currentKey();
		if (key === "") {
			return Promise.resolve({ status: 0, body: { error: "Type the teacher key first." } });
		}

		var init = { method: method, headers: { "x-teacher-key": key } };
		if (payload) {
			init.headers["content-type"] = "application/json";
			init.body = JSON.stringify(payload);
		}

		return fetch(API, init).then(
			function (response) {
				return response
					.json()
					.catch(function () {
						return { error: "The server sent a reply this page could not read." };
					})
					.then(function (body) {
						return { status: response.status, body: body };
					});
			},
			function () {
				return { status: 0, body: { error: "Could not reach the server. Check the network." } };
			}
		);
	}

	/** Draw whatever the server last told us. */
	function show(body) {
		if (body && body.phrase) {
			expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : 0;
			phraseNow.textContent = body.phrase;
			display.dataset.live = "yes";
		} else {
			expiresAt = 0;
			phraseNow.textContent = "no phrase set";
			display.dataset.live = "no";
		}
		tick();
	}

	function tick() {
		if (expiresAt === 0) {
			countdown.textContent = "Students cannot compile right now.";
			return;
		}

		var left = Math.floor((expiresAt - Date.now()) / 1000);
		if (left <= 0) {
			// The Worker stops accepting it at exactly this moment too.
			expiresAt = 0;
			phraseNow.textContent = "no phrase set";
			display.dataset.live = "no";
			countdown.textContent = "That phrase has expired. Students cannot compile.";
			return;
		}

		var hours = Math.floor(left / 3600);
		var minutes = Math.floor((left % 3600) / 60);
		var seconds = left % 60;
		var parts = [];
		if (hours > 0) parts.push(hours + " h");
		if (hours > 0 || minutes > 0) parts.push(minutes + " min");
		parts.push(seconds + " s");
		countdown.textContent = "Ends in " + parts.join(" ") + ".";
	}

	function handle(result, okText) {
		if (result.status === 200) {
			show(result.body);
			say(okText, "ok");
			return;
		}
		if (result.status === 403) {
			say("That teacher key was refused. Check it and try again.", "error");
			return;
		}
		if (result.status === 429) {
			// Wrong key, while the site-wide wrong-key guard is armed.
			// The Worker's sentence carries the wait in minutes, so
			// show it word for word rather than inventing a shorter one.
			say(busyText(result.body), "error");
			return;
		}
		var detail = result.body && result.body.error ? result.body.error : "Something went wrong.";
		say(detail, "error");
	}

	document.getElementById("generate").addEventListener("click", function () {
		phraseInput.value = generatePhrase();
		phraseInput.focus();
	});

	document.getElementById("remember").addEventListener("click", function () {
		try {
			window.localStorage.setItem(KEY_STORAGE, currentKey());
			say("Key saved in this browser.", "ok");
		} catch (error) {
			say("This browser will not let the page save the key. Type it each time.", "error");
		}
	});

	document.getElementById("forget").addEventListener("click", function () {
		try {
			window.localStorage.removeItem(KEY_STORAGE);
		} catch (error) {
			// Nothing to do: there was nothing saved.
		}
		keyInput.value = "";
		say("Key forgotten on this device.", "ok");
	});

	document.getElementById("set").addEventListener("click", function () {
		var phrase = phraseInput.value.trim();
		if (phrase === "") {
			say("Type a phrase, or press Generate.", "error");
			return;
		}
		var ttl = Number(durationSelect.value);
		call("POST", { phrase: phrase, ttlSeconds: ttl }).then(function (result) {
			handle(result, "Phrase is live. Write it on the board.");
		});
	});

	document.getElementById("refresh").addEventListener("click", function () {
		call("GET", null).then(function (result) {
			handle(result, "Up to date.");
		});
	});

	document.getElementById("end").addEventListener("click", function () {
		call("DELETE", null).then(function (result) {
			handle(result, "Phrase ended. Nobody can compile now.");
		});
	});

	// Enter in either field is the obvious action for that field.
	phraseInput.addEventListener("keydown", function (event) {
		if (event.key === "Enter") document.getElementById("set").click();
	});
	keyInput.addEventListener("keydown", function (event) {
		if (event.key === "Enter") document.getElementById("refresh").click();
	});

	keyInput.value = loadKey();
	phraseInput.value = generatePhrase();
	window.setInterval(tick, 1000);
	tick();

	// A remembered key means we can show what is live without a click.
	if (keyInput.value !== "") {
		call("GET", null).then(function (result) {
			if (result.status === 200) show(result.body);
			else if (result.status === 403) say("The saved teacher key was refused.", "error");
			else if (result.status === 429) say(busyText(result.body), "error");
		});
	}
})();

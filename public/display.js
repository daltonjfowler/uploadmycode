(function () {
	"use strict";

	var API = "/api/teacher/phrase";
	/* The very same entry teacher.js writes. Same origin, so it is simply there. */
	var KEY_STORAGE = "uploadmycode.teacherKey";
	/* Five seconds. A GET with the right key is never rate limited: see the
	   teacher gate in src/worker.ts, where a correct key is compared first and
	   nothing is counted for it. The one exception is the short wrong-key
	   lockout on this address (at most 300 s), which apply() rides out. */
	var POLL_MS = 5000;

	var body = document.body;
	var phraseEl = document.getElementById("phrase");
	var subEl = document.getElementById("sub");
	var netEl = document.getElementById("net");

	/*
	 * Everything the page draws from.
	 *
	 *   state    "start" before the first answer, then "live", "none" or
	 *            "nokey". Nothing else is ever assigned.
	 *   phrase   what to show, when state is "live".
	 *   expiresAt Unix ms the phrase dies, or 0 when there is no countdown.
	 *   ended    the sentence under "no phrase set". Two of them: the plain one,
	 *            and the one for a phrase that ran out while this window watched.
	 *   offline  the last poll did not land. The state above is then stale on
	 *            purpose: a projector that keeps yesterday's answer for five
	 *            seconds is better than one that blanks on a hiccup.
	 */
	var state = "start";
	var phrase = "";
	var expiresAt = 0;
	var ended = "Students cannot compile right now.";
	var offline = false;
	/* One request at a time, so a slow answer cannot stack up behind the timer. */
	var polling = false;
	/* A key the Worker refused. Not sent again: a projector re-sending a wrong
	   key every five seconds would keep the school's address in the wrong-key
	   lockout (src/lockout.ts) and hold the teacher page out with it. A new
	   key saved on the teacher page is different, so polling resumes. */
	var refusedKey = "";

	function loadKey() {
		try {
			return window.localStorage.getItem(KEY_STORAGE) || "";
		} catch (error) {
			return "";
		}
	}

	/** Paint what the variables above say. Never fetches, never decides. */
	function draw() {
		body.dataset.state = state;
		netEl.textContent = offline ? "reconnecting..." : "";

		if (state === "live") {
			phraseEl.textContent = phrase;
			phraseEl.style.setProperty("--chars", String(Math.max(3, phrase.length)));
			tick();
			return;
		}

		if (state === "none") {
			phraseEl.textContent = "no phrase set";
			phraseEl.style.setProperty("--chars", "13");
			subEl.textContent = ended;
			return;
		}

		if (state === "nokey") {
			phraseEl.textContent = "Open the teacher page on this computer first.";
			subEl.textContent = "";
			return;
		}

		/* "start": nothing has been heard yet. Say nothing rather than guess. */
		phraseEl.textContent = "";
		subEl.textContent = "";
	}

	/**
	 * The countdown line, redrawn once a second between polls so it moves.
	 *
	 * It also owns the local expiry: when the clock runs out this window flips
	 * itself without waiting for the next poll, exactly as the teacher page does,
	 * because the Worker stops accepting that phrase at the same moment.
	 */
	function tick() {
		if (state !== "live") return;

		if (expiresAt === 0) {
			subEl.textContent = "";
			return;
		}

		var left = Math.floor((expiresAt - Date.now()) / 1000);
		if (left <= 0) {
			state = "none";
			expiresAt = 0;
			ended = "That phrase has expired. Students cannot compile.";
			draw();
			return;
		}

		var hours = Math.floor(left / 3600);
		var minutes = Math.floor((left % 3600) / 60);
		if (hours > 0) subEl.textContent = "Expires in " + hours + " h " + minutes + " min.";
		else if (minutes > 0) subEl.textContent = "Expires in " + minutes + " min.";
		else subEl.textContent = "Expires in " + left + " s.";
	}

	/** This browser's device id (same key as web/src/device.ts) for the per-device lockout. */
	var device = null;
	function deviceId() {
		if (device) return device;
		try {
			var stored = window.localStorage.getItem("umc.device");
			if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stored)) return (device = stored);
		} catch (e) {
			// Site data blocked: one id for this page load.
		}
		var hex = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(16)), function (b) {
			return ("0" + b.toString(16)).slice(-2);
		}).join("");
		device = hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
		try {
			window.localStorage.setItem("umc.device", device);
		} catch (e) {
			// Ignored: the in-memory id still works.
		}
		return device;
	}

	/** One GET. Resolves to { status, body } and never rejects. */
	function fetchPhrase(key) {
		return fetch(API, { method: "GET", headers: { "x-teacher-key": key, "x-device-id": deviceId() } }).then(
			function (response) {
				return response.json().then(
					function (parsed) {
						return { status: response.status, body: parsed };
					},
					function () {
						return { status: response.status, body: null };
					}
				);
			},
			function () {
				return { status: 0, body: null };
			}
		);
	}

	/** Turn one answer into the next state. */
	function apply(result) {
		var live =
			result.status === 200 &&
			result.body &&
			typeof result.body.phrase === "string" &&
			result.body.phrase !== "";

		if (live) {
			offline = false;
			state = "live";
			phrase = result.body.phrase;
			expiresAt = typeof result.body.expiresAt === "number" ? result.body.expiresAt : 0;
			draw();
			return;
		}

		/* A 200 whose body did not parse is not proof of anything, so it falls
		   through to the stale-but-honest branch at the bottom instead. */
		if (result.status === 200 && result.body) {
			offline = false;
			state = "none";
			expiresAt = 0;
			ended = "Students cannot compile right now.";
			draw();
			return;
		}

		/*
		 * 403 is a key the Worker refused. 429 is the site-wide wrong-key guard,
		 * which a correct key never meets, so it means the same thing here. Both
		 * are fixed on the teacher page and nowhere else, so both say so.
		 */
		/* The short per-address lockout refuses even a right key until its wait
		   ends, so it says nothing about the key. Keep what is on screen and
		   try again on the next poll. */
		if (result.status === 429 && result.body && result.body.error === "locked") {
			offline = true;
			draw();
			return;
		}

		if (result.status === 403 || result.status === 429) {
			offline = false;
			state = "nokey";
			expiresAt = 0;
			draw();
			return;
		}

		/* Network gone, a 5xx, or a reply this page could not read. Keep what is
		   on screen and say quietly that it is not fresh. */
		offline = true;
		draw();
	}

	function poll() {
		if (polling) return;

		var key = loadKey();
		if (key === "" || key === refusedKey) {
			offline = false;
			state = "nokey";
			expiresAt = 0;
			draw();
			return;
		}

		polling = true;
		fetchPhrase(key).then(function (result) {
			polling = false;
			if (result.status === 403) refusedKey = key;
			apply(result);
		});
	}

	/** Click anywhere: this window is a projector slide, not a control panel. */
	function toggleFullscreen() {
		if (!document.documentElement.requestFullscreen) return;

		if (document.fullscreenElement) {
			var leaving = document.exitFullscreen();
			if (leaving && leaving.catch) leaving.catch(function () {});
			return;
		}
		var entering = document.documentElement.requestFullscreen();
		if (entering && entering.catch) entering.catch(function () {});
	}

	document.addEventListener("click", toggleFullscreen);
	document.addEventListener("fullscreenchange", function () {
		body.dataset.fullscreen = document.fullscreenElement ? "yes" : "no";
	});

	/* Back from another window or another desktop: do not make him wait out the
	   interval, and browsers throttle timers in a hidden tab anyway. */
	document.addEventListener("visibilitychange", function () {
		if (document.visibilityState === "visible") poll();
	});

	draw();
	poll();
	window.setInterval(poll, POLL_MS);
	window.setInterval(tick, 1000);
})();

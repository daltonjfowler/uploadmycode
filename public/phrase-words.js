/**
 * The words the teacher page's Generate button draws from, and the generator.
 *
 * A plain script, like teacher.js, loaded just before it by teacher.html. It is
 * a file of its own so web/test/phrase-words.test.mjs can load exactly this
 * list and check it, rather than a copy.
 *
 * A generated phrase is three different words and a two-digit number:
 * "otter-maple-rocket-47". With 204 words and the numbers 10 to 99 that is
 * 204 x 203 x 202 x 90, about 750 million phrases (a little over 2^29), which
 * is what makes guessing one hopeless at the Worker's per-address limit. The
 * old list was 78 words and no number: about 456 thousand phrases, few enough
 * to try them all in an afternoon.
 *
 * Rules for the list, because a class has to type these off a whiteboard:
 *   - 4 to 7 lowercase letters, spelled the way they sound
 *   - things a kid can picture: animals, food, places, objects, colors
 *   - no names, nothing about bodies or bathrooms, nothing with a second
 *     meaning a class would laugh at
 *   - no sound-alikes (no "pear", "bear", "sail", "ferry") and no words with
 *     two spellings ("grey", "harbour"), so the phrase said out loud is the
 *     phrase typed
 * Adding a word that follows the rules only makes phrases harder to guess.
 * Removing words shrinks the space; the test fails below 2^28.
 */
(function (root) {
	"use strict";

	var WORDS = [
		"acorn", "almond", "anchor", "apple", "apricot", "bagel", "bamboo", "banjo",
		"basket", "beetle", "birch", "bison", "blue", "bread", "breeze", "bridge",
		"bucket", "butter", "button", "cabbage", "cabin", "cactus", "camel", "camera",
		"candle", "canoe", "canyon", "carrot", "cashew", "castle", "cedar", "celery",
		"cheese", "cliff", "clock", "cloud", "clover", "cobalt", "coconut", "comet",
		"compass", "copper", "crab", "crayon", "crimson", "crown", "desert", "dolphin",
		"donkey", "drum", "eagle", "engine", "falcon", "fern", "ferret", "flute",
		"forest", "frog", "frost", "gadget", "galaxy", "garden", "garlic", "gecko",
		"gerbil", "glider", "globe", "goat", "golden", "goose", "granite", "grape",
		"green", "guitar", "hammer", "hamster", "harp", "helmet", "heron", "hippo",
		"hornet", "igloo", "indigo", "island", "jelly", "jungle", "kayak", "kettle",
		"kitten", "kiwi", "koala", "ladder", "lagoon", "lamp", "lantern", "laptop",
		"lemon", "lemur", "lion", "lobster", "lunar", "magenta", "magnet", "mango",
		"maple", "marble", "marker", "meadow", "meteor", "mitten", "moon", "moss",
		"napkin", "navy", "noodle", "oatmeal", "ocean", "octopus", "onion", "orange",
		"orbit", "orchard", "otter", "oyster", "paddle", "pancake", "panda", "parrot",
		"pasta", "peanut", "pencil", "penguin", "pepper", "pickle", "pigeon", "pillow",
		"pine", "pizza", "planet", "plum", "pond", "pony", "popcorn", "potato",
		"pretzel", "puffin", "pumpkin", "puppy", "purple", "puzzle", "quilt", "rabbit",
		"radish", "rainbow", "rhino", "ribbon", "river", "robot", "rocket", "saddle",
		"salad", "scooter", "sheep", "shovel", "silver", "snail", "snow", "soup",
		"spoon", "spruce", "squid", "star", "sunrise", "sunset", "table", "teapot",
		"tent", "thunder", "ticket", "tiger", "toast", "tomato", "tower", "tractor",
		"train", "trout", "truck", "trumpet", "tulip", "tuna", "tunnel", "turtle",
		"valley", "violin", "volcano", "waffle", "wagon", "walnut", "walrus", "window",
		"wolf", "yellow", "zebra", "zipper"
	];

	/** Two digits always, 10 to 99, so nobody wonders whether "07" needs its zero. */
	var NUMBER_MIN = 10;
	var NUMBER_COUNT = 90;

	/** A random whole number from 0 to n - 1, from the browser's secure source. */
	function randomBelow(n) {
		var pick = new Uint32Array(1);
		crypto.getRandomValues(pick);
		return pick[0] % n;
	}

	function generatePhrase() {
		var picked = [];
		while (picked.length < 3) {
			var word = WORDS[randomBelow(WORDS.length)];
			// Three different words: "robot-robot-maple" reads like a typo.
			if (picked.indexOf(word) === -1) picked.push(word);
		}
		picked.push(String(NUMBER_MIN + randomBelow(NUMBER_COUNT)));
		return picked.join("-");
	}

	root.uploadmycodePhrase = {
		WORDS: WORDS,
		NUMBER_COUNT: NUMBER_COUNT,
		generatePhrase: generatePhrase
	};
})(this);

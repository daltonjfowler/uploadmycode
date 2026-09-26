/*
 * The title-bar logo comes alive: the still <img src="/icon.svg" data-logo> is swapped for the
 * drawing in /icon-animated.svg (made by scripts/make-icons.mjs), placed inline so its CSS
 * animation runs in every browser.
 *   Mouse: hover for 3 seconds; it goes still when the pointer leaves.
 *   Touch (phones, tablets, touch Chromebooks): tap it; tap again, or wait 6 seconds, and it stops.
 * The same file on all four family sites. Nothing happens for people who ask for less motion.
 * A plain file, not a module, because the CSP is script-src 'self'.
 */
(function () {
  var HOVER_MS = 3000;
  var TAP_MS = 6000;
  var ANIMATED = '/icon-animated.svg';
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) { /* old browser: animate */ }

  var drawing = null; // the parsed animated SVG, fetched once
  function load() {
    if (!drawing) {
      drawing = fetch(ANIMATED)
        .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
        .then(function (text) {
          var svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
          return svg.nodeName.toLowerCase() === 'svg' ? svg : Promise.reject('not svg');
        });
      drawing.catch(function () { drawing = null; });
    }
    return drawing;
  }

  function hook(img) {
    var timer = 0;
    var live = null;
    var lastPointer = 'mouse';

    function sleep() {
      clearTimeout(timer);
      if (live) {
        live.remove();
        live = null;
        img.style.display = '';
      }
    }

    function wake(byTap) {
      load().then(function (svg) {
        if (live || (!byTap && !img.matches(':hover'))) return;
        live = document.importNode(svg, true);
        var cs = getComputedStyle(img);
        live.setAttribute('width', img.width);
        live.setAttribute('height', img.height);
        live.setAttribute('aria-hidden', 'true');
        live.setAttribute('class', img.className);
        live.style.borderRadius = cs.borderRadius;
        live.style.verticalAlign = cs.verticalAlign;
        live.style.flex = 'none';
        live.style.touchAction = 'manipulation';
        live.addEventListener('pointerleave', function (e) {
          if (e.pointerType === 'mouse') sleep();
        });
        // A tap on the moving robot stops it (and never follows a link around the logo).
        live.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          sleep();
        });
        img.style.display = 'none';
        img.after(live);
        if (byTap) timer = setTimeout(sleep, TAP_MS);
      }, function () { /* no animated file: stay still */ });
    }

    img.style.touchAction = 'manipulation'; // no double-tap zoom delay on the logo
    img.addEventListener('pointerdown', function (e) {
      lastPointer = e.pointerType || 'mouse';
      if (lastPointer !== 'mouse') load();
    });
    img.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'mouse') return; // touch has no hover: taps are handled below
      load();
      clearTimeout(timer);
      timer = setTimeout(function () { wake(false); }, HOVER_MS);
    });
    img.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse' && !live) clearTimeout(timer);
    });
    img.addEventListener('click', function (e) {
      if (lastPointer === 'mouse') return;
      e.preventDefault(); // the logo may sit inside a link home; the words next to it still link
      clearTimeout(timer);
      wake(true);
    });
  }

  function start() {
    var imgs = document.querySelectorAll('img[data-logo]');
    for (var i = 0; i < imgs.length; i++) hook(imgs[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

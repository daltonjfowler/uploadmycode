/*
 * Hover the title-bar logo for 3 seconds and the robot comes alive: the still <img src="/icon.svg">
 * is swapped for the drawing in /icon-animated.svg (made by scripts/make-icons.mjs), placed inline
 * so its CSS animation runs in every browser, and swapped back when the pointer leaves.
 * The same file on all four family sites. Nothing happens for people who ask for less motion.
 * A plain file, not a module, because the CSP is script-src 'self'.
 */
(function () {
  var DELAY_MS = 3000;
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
    function sleep() {
      clearTimeout(timer);
      if (live) {
        live.remove();
        live = null;
        img.style.display = '';
      }
    }
    function wake() {
      load().then(function (svg) {
        if (live || !img.matches(':hover')) return;
        live = document.importNode(svg, true);
        var cs = getComputedStyle(img);
        live.setAttribute('width', img.width);
        live.setAttribute('height', img.height);
        live.setAttribute('aria-hidden', 'true');
        live.setAttribute('class', img.className);
        live.style.borderRadius = cs.borderRadius;
        live.style.verticalAlign = cs.verticalAlign;
        live.style.flex = 'none';
        live.addEventListener('pointerleave', sleep);
        img.style.display = 'none';
        img.after(live);
      }, function () { /* no animated file: stay still */ });
    }
    img.addEventListener('pointerenter', function () {
      load();
      clearTimeout(timer);
      timer = setTimeout(wake, DELAY_MS);
    });
    img.addEventListener('pointerleave', function () {
      if (!live) clearTimeout(timer);
    });
  }

  function start() {
    var imgs = document.querySelectorAll('img[data-logo]');
    for (var i = 0; i < imgs.length; i++) hook(imgs[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

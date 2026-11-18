// TV-only tweaks, injected into the webOS build (not used by the desktop dashboard).
(function () {
  // Scale the page up so it is readable from the couch.
  function fit() {
    var z = Math.max(1, Math.min(2, window.innerWidth / 1300));
    document.documentElement.style.zoom = z;
  }
  fit();
  window.addEventListener("resize", fit);

  // Remote arrow keys scroll the page (the Magic Remote pointer still works for clicking).
  var STEP = 220;
  document.addEventListener("keydown", function (e) {
    var k = e.keyCode;
    if (k === 40) { window.scrollBy(0, STEP); e.preventDefault(); }        // down
    else if (k === 38) { window.scrollBy(0, -STEP); e.preventDefault(); }  // up
    else if (k === 34 || k === 39) { window.scrollBy(0, window.innerHeight * 0.8); e.preventDefault(); } // ch down / right
    else if (k === 33 || k === 37) { window.scrollBy(0, -window.innerHeight * 0.8); e.preventDefault(); } // ch up / left
  });

  // Web links (wiki, downloads) would replace the dashboard inside the app; ignore them on TV.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (a && /^https?:/i.test(a.getAttribute("href"))) e.preventDefault();
  }, true);
})();

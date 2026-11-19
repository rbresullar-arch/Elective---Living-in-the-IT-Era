/* Maintenance mask. From START (Philippine time) every page that loads this file shows only
   the plain text below — no styles, nothing else runs. A page already open switches at START.
   admin.html does not load it. To end maintenance, remove this file's <script> tags (or set START far ahead). */
(function () {
  var START = Date.parse('2026-11-19T22:00:00+08:00');
  var TEXT = 'THIS SITE IS UNDER MAINTENANCE';
  function mask() {
    try { if (window.stop) window.stop(); } catch (e) {}
    var html = document.documentElement;
    while (html.attributes.length) html.removeAttribute(html.attributes[0].name);
    html.innerHTML = '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Under maintenance</title></head><body>' + TEXT + '</body>';
  }
  var wait = START - Date.now();
  if (wait <= 0) { mask(); return; }
  if (wait < 2147483647) setTimeout(mask, wait);
})();

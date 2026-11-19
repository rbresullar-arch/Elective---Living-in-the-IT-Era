/* Maintenance mask, switched from the master console (admin.html → Maintenance).
   The Apps Script answers GET ?action=maint → { maint: { on, from } }. When on (and from is blank or past),
   every page that loads this file shows only the plain text below — no styles, the rest of the page does not load.
   The last answer is kept on the phone, so a masked phone masks at once on the next load (and offline);
   the page asks again on load and every minute, so a change in the console reaches open pages within a minute.
   Times are compared with the server's clock (Google), not the phone's: off = server time − phone time,
   measured on every check (half the round trip added) and kept with the last answer.
   admin.html does not load this file. */
(function () {
  var URL_ = 'https://script.google.com/macros/s/AKfycbyevEFI0NDS0zdTr5KpBCvfccALzKVlbqug-9PcFl_UM7hwG2Bsnow6FcVsK6RPQwEk/exec';
  var KEY = 'itict_maint', TEXT = 'THIS SITE IS UNDER MAINTENANCE';
  var masked = false, timer = 0, off = 0;
  function now() { return Date.now() + off; }   // internet time
  function read() {
    try {
      var x = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (x && x.maint) { off = Number(x.off) || 0; return x.maint; }
      return x;   // older format: the state alone
    } catch (e) { return null; }
  }
  function startOf(m) { return m && m.from ? Date.parse(m.from) || 0 : 0; }
  function isOn(m) { return !!(m && m.on === true && now() >= startOf(m)); }
  function mask() {
    if (masked) return;
    masked = true;
    try { if (window.stop) window.stop(); } catch (e) {}
    var html = document.documentElement;
    while (html.attributes.length) html.removeAttribute(html.attributes[0].name);
    html.innerHTML = '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Under maintenance</title></head><body>' + TEXT + '</body>';
  }
  function apply(m) {
    clearTimeout(timer);
    if (isOn(m)) { mask(); return; }
    if (masked) { location.reload(); return; }   // switched off: bring the page back
    var wait = m && m.on === true ? startOf(m) - now() : 0;
    if (wait > 0 && wait < 2147483647) timer = setTimeout(function () { apply(m); }, wait);
  }
  function check() {
    if (!window.fetch) return;
    var t0 = Date.now();
    fetch(URL_ + '?action=maint', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.maint) return;
        var t1 = Date.now();
        if (j.now) off = j.now + (t1 - t0) / 2 - t1;
        try { localStorage.setItem(KEY, JSON.stringify({ maint: j.maint, off: off })); } catch (e) {}
        apply(j.maint);
      })
      .catch(function () {});
  }
  apply(read());          // last known state, at once (works offline)
  check();
  setInterval(check, 60000);
})();

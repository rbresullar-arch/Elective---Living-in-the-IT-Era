/* Exam gate — Living in the IT Era (GEEL 1)
   The instructor opens and closes each examination from the master console (admin.html).
   The state lives in the Apps Script (Script Property EXAM_GATE) and is read with
   GET <CLOUD_URL>?action=examGate → { ok, gate: { <examId>: { open, from, until } }, now }.
   Missing exam, missing gate or no connection and nothing cached = CLOSED.

   index.html loads this file to label the Examination rows.
   Each exam page loads it with its id and storage prefix:
     <script src="exam_gate.js" data-exam="examPrelim" data-prefix="itict_prelim"></script>
   and is covered until the gate says the exam is open. A student who already submitted
   (a <prefix>_result record exists) can still open the page to see their QR. */
(function () {
  var CLOUD_URL = 'https://script.google.com/macros/s/AKfycbyevEFI0NDS0zdTr5KpBCvfccALzKVlbqug-9PcFl_UM7hwG2Bsnow6FcVsK6RPQwEk/exec';
  var KEY = 'itict_exam_gate';

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function entry(g, id) { return (g && g.gate && g.gate[id]) || null; }
  function isOpen(g, id, now) {
    var v = entry(g, id);
    if (!v || v.open !== true) return false;
    now = now || Date.now();
    if (v.from && now < Date.parse(v.from)) return false;
    if (v.until && now >= Date.parse(v.until)) return false;
    return true;
  }
  /* Fetch the gate (timeout ms). Resolves with the fresh record, or the cached one when offline. */
  function fetchGate(ms) {
    return new Promise(function (resolve) {
      var done = false, ctl = window.AbortController ? new AbortController() : null;
      var t = setTimeout(function () { if (ctl) ctl.abort(); finish(read()); }, ms || 8000);
      function finish(rec) { if (done) return; done = true; clearTimeout(t); resolve(rec); }
      fetch(CLOUD_URL + '?action=examGate', ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) return finish(read());
          var rec = { gate: j.gate || {}, at: Date.now() };   // older server without examGate → {} → all closed
          try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) {}
          finish(rec);
        })
        .catch(function () { finish(read()); });
    });
  }
  function fmt(iso) {
    try {
      return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso));
    } catch (e) { return iso; }
  }
  /* Short text for a closed exam: when it opens, or the general on-hold line. */
  function closedText(g, id) {
    var v = entry(g, id), now = Date.now();
    if (v && v.open === true && v.from && now < Date.parse(v.from)) return 'Opens ' + fmt(v.from);
    if (v && v.open === true && v.until && now >= Date.parse(v.until)) return 'Closed ' + fmt(v.until);
    return 'Closed · wait for further announcement';
  }

  window.ExamGate = { read: read, isOpen: isOpen, fetch: fetchGate, closedText: closedText, fmt: fmt };

  /* ---- exam page guard ---- */
  var me = document.currentScript;
  var id = me && me.getAttribute('data-exam');
  if (!id) return;
  var prefix = me.getAttribute('data-prefix') || '';
  function hasResult() {
    if (!prefix) return false;
    try { if (localStorage.getItem(prefix + '_result') || sessionStorage.getItem(prefix + '_result')) return true; } catch (e) {}
    return document.cookie.indexOf(prefix + '_result=') >= 0;
  }
  if (hasResult()) return;

  var cover = document.createElement('div');
  cover.setAttribute('role', 'alertdialog');
  cover.setAttribute('aria-live', 'assertive');
  cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;'
    + 'background:#F5F5F7;color:#1D1D1F;font:17px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;text-align:center';
  cover.innerHTML = '<div style="max-width:380px"><p id="egTitle" style="font-size:22px;font-weight:700;margin:0 0 8px">Checking the examination…</p>'
    + '<p id="egText" style="margin:0 0 18px;color:#6E6E73">One moment.</p>'
    + '<a href="index.html" style="display:inline-block;padding:12px 26px;border-radius:999px;background:#0071E3;color:#fff;text-decoration:none;font-weight:600">Back to home</a></div>';
  document.documentElement.appendChild(cover);

  function decide(rec) {
    if (isOpen(rec, id)) { cover.remove(); return; }
    cover.querySelector('#egTitle').textContent = 'This examination is closed';
    cover.querySelector('#egText').textContent = rec ? closedText(rec, id) + '.' : 'Connect to the internet so the page can check whether it is open.';
  }
  /* Open from cache at once only if the cache is fresh (5 min); always confirm online. */
  var cached = read();
  if (cached && Date.now() - (cached.at || 0) < 300000 && isOpen(cached, id)) cover.remove();
  fetchGate(8000).then(function (rec) {
    if (!document.documentElement.contains(cover)) {
      if (!isOpen(rec, id)) { document.documentElement.appendChild(cover); decide(rec); }
      return;
    }
    decide(rec);
  });
})();

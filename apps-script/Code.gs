/**
 * Living in the IT Era — student record backup (Google Apps Script web app)
 *
 * Standalone Apps Script project that writes to the "IT Era — Student Records" Google Sheet (SHEET_ID).
 * Deploy: Deploy → New deployment → Web app · Execute as: Me · Who has access: Anyone.
 * Live: owner tellmei.282@gmail.com · web app URL is CLOUD_URL in index.html and the activity pages.
 * After editing this file: Deploy → Manage deployments → edit → Version: New version (keeps the same URL).
 *
 * VERSION 2 — no student names online.
 *   Students are identified by a class code assigned here: <schedule>-<seq>, e.g. 12030-07.
 *   The sequence is the highest number already used for that schedule (Auth and Data tabs) + 1.
 *   Real names exist only in the student's Score QR, scanned by the instructor's offline tool.
 *   Any `name` field that reaches the server is removed before storage.
 *
 * Tabs (created automatically on first request):
 *   Scores    — one readable row per student (instructor view)
 *   Data      — full sync payload per student, JSON split across cells (used for restore)
 *   Auth      — code + salted PIN hash. Clear the PIN hash cell to reset a PIN: the student's
 *               next log in with that code sets a new PIN. 3 wrong PINs lock the code for 24 h
 *               ("Locked until"); clear that cell to unlock early.
 *   Reset     — instructor-only score resets: type a code and A1–A11 or ALL; applied on the next request.
 *               Faster: the master console (admin.html) resets at once — type the code, pick activities.
 *   Log       — one line per request (time, code, action, result)
 *   Schedules — valid class schedules: code (5 digits) + label. The site's schedule lists are read
 *               from here. Seeded on first run; edit freely.
 *
 * Requests: POST, Content-Type text/plain, body JSON. `pin` is always the client-side
 * SHA-256 of 'itict|' + PIN (6 digits); the PIN itself never leaves the device.
 *   { action: 'register', sched, pin, data }   → assigns a code; returns { ok, code, data }
 *   { action: 'save', id, pin, data }           → merges data, returns { ok, data }
 *   { action: 'restore', id, pin }              → returns { ok, data }
 *   { action: 'migrate', oldId, oldPin, pin, sched, data }
 *        converts a version-1 account (name + 4-digit PIN) to a code; the name is deleted.
 *        oldId = name normalized (upper case, single spaces); oldPin = SHA-256 of 'itict|' + oldId + '|' + oldPIN.
 *        Returns { ok, code, data } or error 'sched' when no schedule is known (send sched and retry).
 * Master console (admin.html). `pin` = SHA-256 of 'itict-admin|' + master password.
 *   The password is the Script Property ADMIN_PASSWORD (Project Settings → Script properties).
 *   5 wrong passwords lock the console for 15 minutes.
 *   { action: 'adminLogin', pin }               → { ok }
 *   { action: 'adminLookup', pin, id }          → { ok, id, activities: [{ n, pct, at }] }
 *   { action: 'adminReset', pin, id, list }     → resets activities in `list` (numbers) at once
 *   { action: 'adminExamGate', pin }            → { ok, gate, now }  (read)
 *   { action: 'adminExamGate', pin, gate }      → saves which examinations are open; returns { ok, gate, now }
 *        gate = { <exam id>: { open: true|false, from: ISO or '', until: ISO or '' } }
 *   { action: 'adminSpecial', pin }             → { ok, rows, bank, now }  Special Prefinal list (read)
 *   { action: 'adminSpecial', pin, assign: { codes, opens, closes, minutes } } → assigns codes (ISO times)
 *   { action: 'adminSpecial', pin, remove: [codes] } → removes assignments (the student may be assigned again)
 *   { action: 'adminSpecialBank', pin, bank }   → stores the question bank + key (never sent to phones)
 * Special Prefinal (students, same id + pin as save):
 *   { action: 'specialStatus', id, pin }        → { ok, assigned, state, opens, closes, minutes, ends, now }
 *   { action: 'specialStart', id, pin }         → { ok, set, ends, items: [{ q, c }], progress }
 *   { action: 'specialSave', id, pin, answers } → progress autosave
 *   { action: 'specialSubmit', id, pin, answers, flags } → { ok, done } (the score is never returned)
 * GET ?action=schedules → { ok, schedules: [{ code, label }] }
 * GET ?action=examGate  → { ok, gate, now }. Read by exam_gate.js on the site.
 *   Stored in the Script Property EXAM_GATE. No property (or an exam missing from it) = CLOSED.
 *
 * Instructor tools (run from the editor):
 *   setup()        — create tabs, seed Schedules, approve permissions. Run it again after editing the
 *                    Schedules tab to apply the change at once (otherwise within 10 minutes).
 * Speed: log in (restore) does not wait in the write queue; the header check runs once per version;
 *   the Reset tab is read at most once a minute; Schedules are cached 10 minutes.
 *   purgeLegacy()  — delete every remaining version-1 (name-keyed) row from Auth, Data, Scores and Log.
 *                    Run it when the conversion period ends.
 */

var SHEET_ID = '1n6qku2kUCGF51gi8BVrMqK-Gz8EajW1ubG0JxvSKiDU';
var SHEET = { scores: 'Scores', data: 'Data', auth: 'Auth', reset: 'Reset', log: 'Log', sched: 'Schedules' };
var MAX_FAILS = 3;
var LOCK_MS = 24 * 60 * 60 * 1000;
var LOG_KEEP = 4000;
var ACTIVITY_COUNT = 11;
var EXAMS = [{ id: 'examPrelim', label: 'Prelim' }, { id: 'exam1', label: 'Midterm' },
  { id: 'examPrefinal', label: 'Prefinal', paper: true }];   // paper: bubble-sheet exam → Set, Start, End, Flags columns
var CHUNK = 45000;          // chars per cell (cell limit is 50,000)
var MAX_BODY = 600000;      // reject anything larger
var CODE_RE = /^\d{5}-\d{2,3}$/;
var SCHED_RE = /^\d{5}$/;
var LEGACY_RE = /^[\p{L}0-9.,'\- ]{3,80}$/u;
var HASH_RE = /^[0-9a-f]{64}$/;
var SCHEDULE_SEED = [
  ['07008', 'TTh 09:00-10:30 AM'],
  ['25007', 'MWF 02:00-03:00 PM'],
  ['21508', 'MWF 11:00-12:00 PM'],
  ['12021', 'MWF 09:00-10:00 AM'],
  ['12030', 'F / Thu 03:00-05:00 PM / 08:00-09:00 AM'],
  ['02018', 'MWF 08:00-09:00 AM'],
  ['50021', 'MF / Wed 10:00-11:00 AM / 04:00-05:00 PM'],
  ['06095', 'Thu 01:00-04:00 PM'],
  ['06131', 'TTh / Wed 05:30-06:30 PM / 03:00-04:00 PM'],
  ['06143', 'M / Tue 03:00-05:00 PM / 01:00-02:00 PM'],
  ['06107', 'Thu / Tue 10:30-12:30 PM / 02:00-03:00 PM'],
  ['06119', 'Tue / Mon 10:30-12:30 PM / 05:00-06:30 PM'],
  ['22012', 'MWF 01:00-02:00 PM']
];

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'examGate') return json_({ ok: true, gate: gate_(), now: Date.now() });
  if (action === 'schedules') {
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      return json_({ ok: true, schedules: getSchedules_(ss) });
    } catch (err) {
      return json_({ ok: false, error: 'server' });
    }
  }
  return json_({ ok: true, service: 'itict-records', version: 2 });
}

function doPost(e) {
  var req;
  try {
    var body = (e && e.postData && e.postData.contents) || '';
    if (body.length > MAX_BODY) return json_({ ok: false, error: 'size' });
    req = JSON.parse(body);
  } catch (err) {
    return json_({ ok: false, error: 'bad' });
  }
  var action = String(req.action || '');
  var pin = String(req.pin || '');
  if (!HASH_RE.test(pin)) return json_({ ok: false, error: 'bad' });

  /* version-1 pages still sending a name as the id: tell them to convert, store nothing */
  if (action === 'save' || action === 'restore') {
    var rawId = String(req.id || '').trim();
    if (!CODE_RE.test(rawId)) return json_({ ok: false, error: LEGACY_RE.test(rawId.toUpperCase()) ? 'migrate' : 'bad' });
  }

  /* Master console */
  if (action.indexOf('admin') === 0) {
    var auth = adminCheck_(pin);
    if (!auth.ok) return json_(auth);
    try {
      var as = SpreadsheetApp.openById(SHEET_ID);
      ensureSheetsOnce_(as);
      if (action === 'adminLogin') return json_({ ok: true });
      if (action === 'adminLookup') return json_(adminLookup_(as, req));
      if (action === 'adminExamGate') {
        if (!req.gate) return json_({ ok: true, gate: gate_(), now: Date.now() });
        var g = setGate_(req.gate);
        log_(as, 'ADMIN', 'examGate', EXAMS.map(function (x) { return x.label + ':' + (g[x.id].open ? 'open' : 'closed'); }).join(' '));
        return json_({ ok: true, gate: g, now: Date.now() });
      }
      if (action === 'adminSpecial' || action === 'adminSpecialBank') {
        var sl = LockService.getScriptLock();
        try { sl.waitLock(28000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
        try { return json_(action === 'adminSpecial' ? adminSpecial_(as, req) : adminSpecialBank_(as, req)); } finally { sl.releaseLock(); }
      }
      if (action === 'adminReset') {
        var al = LockService.getScriptLock();
        try { al.waitLock(28000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
        try { return json_(adminReset_(as, req)); } finally { al.releaseLock(); }
      }
      return json_({ ok: false, error: 'bad' });
    } catch (err) {
      return json_({ ok: false, error: 'server', detail: String(err).slice(0, 200) });
    }
  }

  /* Special Prefinal: each student writes only its own row, so no queue */
  if (action.indexOf('special') === 0) {
    try {
      var sp = SpreadsheetApp.openById(SHEET_ID);
      ensureSheetsOnce_(sp);
      return json_(special_(sp, req, pin, action));
    } catch (err) {
      return json_({ ok: false, error: 'server', detail: String(err).slice(0, 200) });
    }
  }

  /* Log in (restore) only reads: it skips the queue so a class signing in together is not serialized. */
  if (action === 'restore') {
    try {
      var rs = SpreadsheetApp.openById(SHEET_ID);
      ensureSheetsOnce_(rs);
      return json_(saveRestore_(rs, req, pin, action));
    } catch (err) {
      return json_({ ok: false, error: 'server', detail: String(err).slice(0, 200) });
    }
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(28000); } catch (err) { return json_({ ok: false, error: 'busy' }); }   // writes queue here
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    ensureSheetsOnce_(ss);
    applyResetsSoon_(ss);
    if (action === 'register') return json_(register_(ss, req, pin));
    if (action === 'migrate') return json_(migrate_(ss, req, pin));
    if (action === 'save' || action === 'restore') return json_(saveRestore_(ss, req, pin, action));
    return json_({ ok: false, error: 'bad' });
  } catch (err) {
    return json_({ ok: false, error: 'server', detail: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- actions ---------------- */
function register_(ss, req, pin) {
  var sched = String(req.sched || '').trim();
  if (!schedOk_(ss, sched)) return { ok: false, error: 'sched' };
  var code = nextCode_(ss, sched);
  ss.getSheetByName(SHEET.auth).appendRow([code, hashFor_(code, pin), new Date(), 0, '']);
  var incoming = cleanIncoming_(req.data);
  incoming.sched = sched;
  var merged = merge_({}, incoming);
  writeDoc_(ss, code, merged);
  writeScores_(ss, code, merged);
  log_(ss, code, 'register', 'ok');
  return { ok: true, code: code, data: merged };
}

function saveRestore_(ss, req, pin, action) {
  var id = String(req.id || '').trim();
  var auth = checkPin_(ss, id, hashFor_(id, pin));
  if (auth === 'nouser') { log_(ss, id, action, 'nouser'); return { ok: false, error: 'nouser' }; }
  if (auth.locked) { log_(ss, id, action, 'locked'); return { ok: false, error: 'locked', until: auth.until }; }
  if (auth.bad) { log_(ss, id, action, 'pin (' + auth.left + ' left)'); return { ok: false, error: 'pin', left: auth.left }; }

  var stored = readDoc_(ss, id);
  if (stored) stored.sched = id.slice(0, 5);            // the code fixes the schedule
  if (action === 'restore') {
    log_(ss, id, 'restore', stored ? (auth.claimed ? 'ok · new PIN set' : 'ok') : 'empty');
    return { ok: true, data: stored || {}, pinSet: !!auth.claimed };
  }
  var incoming = cleanIncoming_(req.data);
  incoming.sched = id.slice(0, 5);
  var merged = merge_(stored || {}, incoming);
  writeDoc_(ss, id, merged);
  writeScores_(ss, id, merged);
  log_(ss, id, 'save', 'ok');
  return { ok: true, data: merged };
}

function migrate_(ss, req, pin) {
  var oldId = String(req.oldId || '').replace(/\s+/g, ' ').trim().toUpperCase();
  var oldPin = String(req.oldPin || '');
  if (!LEGACY_RE.test(oldId) || CODE_RE.test(oldId) || !HASH_RE.test(oldPin)) return { ok: false, error: 'bad' };
  var auth = checkPin_(ss, oldId, legacyHash_(oldPin));
  if (auth === 'nouser') { log_(ss, '(old account)', 'migrate', 'nouser'); return { ok: false, error: 'nouser' }; }
  if (auth.locked) { log_(ss, '(old account)', 'migrate', 'locked'); return { ok: false, error: 'locked', until: auth.until }; }
  if (auth.bad) { log_(ss, '(old account)', 'migrate', 'pin (' + auth.left + ' left)'); return { ok: false, error: 'pin', left: auth.left }; }

  var stored = readDoc_(ss, oldId) || {};
  var incoming = cleanIncoming_(req.data);
  var sched = String(stored.sched || '');
  var reqSched = String(req.sched || '').trim();
  if (!schedOk_(ss, sched)) sched = reqSched;
  if (!schedOk_(ss, sched)) return { ok: false, error: 'sched' };

  var code = nextCode_(ss, sched);
  incoming.sched = sched;
  var merged = merge_(scrub_(stored), incoming);

  /* Auth: the old row becomes the code row (keeps its registration date) */
  var ash = ss.getSheetByName(SHEET.auth);
  var arow = findRow_(ash, oldId);
  ash.getRange(arow, 1, 1, 5).setNumberFormat('@').setValues([[code, hashFor_(code, pin), ash.getRange(arow, 3).getValue() || new Date(), 0, '']]);
  ash.getRange(arow, 3).setNumberFormat('yyyy-mm-dd hh:mm');

  /* Data and Scores: write under the code, delete the name-keyed rows */
  deleteRowsFor_(ss.getSheetByName(SHEET.data), oldId);
  deleteRowsFor_(ss.getSheetByName(SHEET.scores), oldId);
  writeDoc_(ss, code, merged);
  writeScores_(ss, code, merged);

  /* Log: replace the name with the code in earlier lines */
  var lsh = ss.getSheetByName(SHEET.log);
  var ll = lsh.getLastRow();
  if (ll > 1) {
    var keys = lsh.getRange(2, 2, ll - 1, 1).getValues();
    var changed = false;
    keys.forEach(function (k) { if (String(k[0]).toUpperCase() === oldId) { k[0] = code; changed = true; } });
    if (changed) lsh.getRange(2, 2, ll - 1, 1).setValues(keys);
  }
  log_(ss, code, 'migrate', 'ok · name removed');
  return { ok: true, code: code, data: merged };
}

/* ---------------- codes and schedules ---------------- */
/* ---------------- speed: work skipped on most requests ----------------
   Header check: once per version of this file (HEAD_SIG), not on every request.
   Reset tab: read at most once a minute.  Schedules: cached 10 minutes.
   setup() clears all three. */
function headSig_() { return 'v3|' + ACTIVITY_COUNT + '|' + EXAMS.map(function (x) { return x.id; }).join(','); }
function ensureSheetsOnce_(ss) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('HEAD_SIG') === headSig_() && ss.getSheetByName(SHEET.sched)) return;
  ensureSheets_(ss);
  props.setProperty('HEAD_SIG', headSig_());
}
function applyResetsSoon_(ss) {
  var cache = CacheService.getScriptCache();
  if (cache.get('RESETS_CHECKED')) return;
  applyResets_(ss);
  cache.put('RESETS_CHECKED', '1', 60);
}

function getSchedules_(ss) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('SCHEDULES');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var list = readSchedules_(ss);
  if (list.length) cache.put('SCHEDULES', JSON.stringify(list), 600);
  return list;
}
function readSchedules_(ss) {
  var sh = ss.getSheetByName(SHEET.sched);
  if (!sh) { ensureSheets_(ss); sh = ss.getSheetByName(SHEET.sched); }
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getDisplayValues()
    .map(function (r) { return { code: String(r[0]).trim(), label: String(r[1]).trim() }; })
    .filter(function (s) { return SCHED_RE.test(s.code); });
}
function schedOk_(ss, sched) {
  if (!SCHED_RE.test(sched)) return false;
  return getSchedules_(ss).some(function (s) { return s.code === sched; });
}
/* next number for a schedule: highest seq in Auth or Data + 1 (a deleted Auth row never frees a number) */
function nextCode_(ss, sched) {
  var max = 0;
  [SHEET.auth, SHEET.data].forEach(function (name) {
    var sh = ss.getSheetByName(name), last = sh.getLastRow();
    if (last < 2) return;
    sh.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(function (r) {
      var k = String(r[0]).trim();
      if (CODE_RE.test(k) && k.slice(0, 5) === sched) max = Math.max(max, Number(k.slice(6)) || 0);
    });
  });
  var n = max + 1;
  return sched + '-' + (n < 10 ? '0' + n : String(n));
}

/* ---------------- names never stored ---------------- */
function scrub_(doc) {
  if (!doc || typeof doc !== 'object') return {};
  delete doc.name;
  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var r = doc['activity' + n];
    if (r && typeof r === 'object') delete r.name;
  }
  if (doc.exams && typeof doc.exams === 'object') {
    Object.keys(doc.exams).forEach(function (k) {
      var x = doc.exams[k];
      if (!x || typeof x !== 'object') return;
      if (x.result && typeof x.result === 'object') delete x.result.name;
      if (x.session && typeof x.session === 'object') delete x.session.name;
    });
  }
  return doc;
}
function cleanIncoming_(data) {
  var d = (data && typeof data === 'object') ? JSON.parse(JSON.stringify(data)) : {};
  return scrub_(d);
}

/* ---------------- merge rules ----------------
   activities : higher percentage wins; ties keep the stored (first) record.
   resets     : only the Reset tab creates them (applyResets_). Phones cannot clear a
                score; records finished before a reset are refused.
   exams      : per record, the newer `updated` wins; nothing is overwritten with empty.
   unlock     : the newest event wins — an unlock (`at`) or a relock (`unlockClearedAt`). */
function merge_(s, inc) {
  var out = JSON.parse(JSON.stringify(s));
  if (inc.sched && SCHED_RE.test(String(inc.sched))) out.sched = String(inc.sched);   // latest choice wins
  if (inc.createdDate && (!out.createdDate || inc.createdDate < out.createdDate)) out.createdDate = inc.createdDate;

  out.resets = out.resets || {};      // written only by applyResets_

  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var k = 'activity' + n, r = inc[k];
    if (!r || typeof r !== 'object') continue;
    var t = recTime_(r);
    if (out.resets[k] && t && t < out.resets[k]) continue;
    if (!out[k] || pct_(r) > pct_(out[k])) out[k] = r;
  }

  delete out.redoFlags; delete out.redoUsed;

  out.exams = out.exams || {};
  var ie = inc.exams || {};
  Object.keys(ie).forEach(function (eid) {
    var a = out.exams[eid] || {}, b = ie[eid] || {};
    out.exams[eid] = {
      prefix: b.prefix || a.prefix,
      result: newer_(a.result, b.result),
      session: newer_(a.session, b.session)
    };
  });

  var events = [];
  if (out.unlock) events.push({ t: out.unlock.at || '', u: out.unlock });
  if (out.unlockClearedAt) events.push({ t: out.unlockClearedAt, clear: true });
  if (inc.unlock) events.push({ t: inc.unlock.at || '', u: inc.unlock });
  if (inc.unlockClearedAt) events.push({ t: inc.unlockClearedAt, clear: true });
  if (events.length) {
    events.sort(function (x, y) { return x.t < y.t ? -1 : x.t > y.t ? 1 : 0; });
    var last = events[events.length - 1];
    if (last.clear) { out.unlock = null; out.unlockClearedAt = last.t; }
    else { out.unlock = last.u; }
  }

  out.updatedAt = new Date().toISOString();
  return scrub_(out);
}

function pct_(r) {
  if (!r) return -1;
  if (r.totalScore != null && r.totalMax) return Math.round(r.totalScore / r.totalMax * 100);
  if (r.percentage != null) return Number(r.percentage) || 0;
  return Math.round((r.score || 0) / (r.maxScore || 100) * 100);
}
function recTime_(r) {
  var t = r && (r.endTime || r.savedAt || r.at || (r.updated ? new Date(r.updated).toISOString() : ''));
  return t ? String(t) : '';
}
function newer_(a, b) {
  if (!b) return a || null;
  if (!a) return b;
  return (b.updated || 0) > (a.updated || 0) ? b : a;
}

/* ---------------- PIN ---------------- */
/* Auth row: Code | PIN hash | Registered | Wrong tries | Locked until
   An empty PIN hash cell (cleared by the instructor) is claimed by the next correct-format log in. */
function checkPin_(ss, id, hash) {
  var sh = ss.getSheetByName(SHEET.auth);
  var row = findRow_(sh, id);
  if (!row) return 'nouser';
  var v = sh.getRange(row, 1, 1, 5).getValues()[0];
  var until = v[4] instanceof Date ? v[4].getTime() : (v[4] ? new Date(v[4]).getTime() : 0);
  if (until && until > Date.now()) return { locked: true, until: new Date(until).toISOString() };
  if (!String(v[1]).trim()) {
    sh.getRange(row, 2, 1, 4).setValues([[hash, v[2] || new Date(), 0, '']]);
    return { state: 'ok', claimed: true };
  }
  if (v[1] === hash) {
    if (v[3] || v[4]) sh.getRange(row, 4, 1, 2).setValues([[0, '']]);
    return { state: 'ok' };
  }
  var fails = (until ? 0 : (Number(v[3]) || 0)) + 1;     // an expired lock starts a fresh count
  if (fails >= MAX_FAILS) {
    var lockUntil = new Date(Date.now() + LOCK_MS);
    sh.getRange(row, 4, 1, 2).setValues([[0, lockUntil]]);
    return { locked: true, until: lockUntil.toISOString() };
  }
  sh.getRange(row, 4, 1, 2).setValues([[fails, '']]);
  return { bad: true, left: MAX_FAILS - fails };
}
function salt_() {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('SALT');
  if (!salt) { salt = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('SALT', salt); }
  return salt;
}
function sha_(text) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return d.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
/* version 2: the code salts each student's hash, so equal PINs give different hashes */
function hashFor_(code, clientHash) { return sha_(salt_() + '|' + code + '|' + clientHash); }
/* version 1 (name accounts), used only to verify an old PIN during conversion */
function legacyHash_(clientHash) { return sha_(salt_() + '|' + clientHash); }

/* ---------------- storage ---------------- */
function ensureSheets_(ss) {
  var heads = {};
  heads[SHEET.scores] = ['Code', 'Schedule'];
  for (var n = 1; n <= ACTIVITY_COUNT; n++) heads[SHEET.scores].push('A' + n + ' %');
  EXAMS.forEach(function (x) {
    if (x.paper) heads[SHEET.scores].push(x.label + ' set', x.label + ' start', x.label + ' end', x.label + ' flags');
    else heads[SHEET.scores].push(x.label);
  });
  heads[SHEET.scores].push('Last sync', 'Flags (review)');
  heads[SHEET.data] = ['Code', 'Schedule', 'Updated', 'JSON (split across columns)'];
  heads[SHEET.auth] = ['Code', 'PIN hash (clear cell to reset PIN)', 'Registered', 'Wrong tries', 'Locked until (clear to unlock)'];
  heads[SHEET.reset] = ['Code (as in Scores)', 'Activity: A1–A11 or ALL', 'Applied (filled by script)'];
  heads[SHEET.log] = ['Time', 'Code', 'Action', 'Result'];
  heads[SHEET.sched] = ['Schedule code (5 digits)', 'Label'];
  var rebuild = false;
  Object.keys(heads).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name); sh.setFrozenRows(1);
      if (name === SHEET.sched) {
        sh.getRange(1, 1, 1, 2).setValues([heads[name]]).setFontWeight('bold');
        sh.getRange(2, 1, SCHEDULE_SEED.length, 2).setNumberFormat('@').setValues(SCHEDULE_SEED);
      }
    }
    var h = sh.getRange(1, 1, 1, heads[name].length);
    var cur = h.getValues()[0].join('|');
    if (cur !== heads[name].join('|')) {
      h.setValues([heads[name]]).setFontWeight('bold');
      if (name === SHEET.scores && sh.getLastRow() > 1) rebuild = true;   // columns moved
    }
  });
  if (rebuild) rebuildScores_(ss);
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
}
function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim().toUpperCase() === id) return i + 2;
  return 0;
}
function deleteRowsFor_(sh, id) {
  for (var row = findRow_(sh, id); row; row = findRow_(sh, id)) delRow_(sh, row);
}
/* a sheet cannot delete its last unfrozen row; blank it instead */
function delRow_(sh, row) {
  if (sh.getMaxRows() - sh.getFrozenRows() > 1) sh.deleteRow(row);
  else sh.getRange(row, 1, 1, Math.max(sh.getLastColumn(), 1)).clearContent();
}
function readDoc_(ss, id) {
  var sh = ss.getSheetByName(SHEET.data);
  var row = findRow_(sh, id);
  if (!row) return null;
  var width = sh.getLastColumn();
  var cells = sh.getRange(row, 4, 1, Math.max(1, width - 3)).getValues()[0];
  var text = cells.join('');
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}
function writeDoc_(ss, id, doc) {
  var sh = ss.getSheetByName(SHEET.data);
  var text = JSON.stringify(doc);
  var parts = [];
  for (var i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  var row = findRow_(sh, id) || sh.getLastRow() + 1;
  var oldWidth = Math.max(0, sh.getLastColumn() - 3);
  var values = [id, doc.sched || '', new Date()].concat(parts);
  while (values.length - 3 < oldWidth) values.push('');
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values]);
}
function writeScores_(ss, id, doc) {
  var sh = ss.getSheetByName(SHEET.scores);
  var row = findRow_(sh, id) || sh.getLastRow() + 1;
  var skipped = (doc.unlock && doc.unlock.skipped) || [];
  var vals = [id, doc.sched || ''];
  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var r = doc['activity' + n];
    vals.push(r ? pct_(r) : (skipped.indexOf(n) >= 0 ? 'Skipped' : ''));
  }
  EXAMS.forEach(function (x) {
    var e = doc.exams && doc.exams[x.id];
    var res = e && e.result;
    if (x.paper) {
      var ses = e && e.session;
      if (res) vals.push(res.set || '', tsText_(res.startAt), tsText_(res.endAt), res.flags != null ? Number(res.flags) : '');
      else vals.push(ses && ses.set ? ses.set : '', ses ? tsText_(ses.startAt) : '', ses ? 'In progress' : '', '');
      return;
    }
    vals.push(res && res.total ? res.score + '/' + res.total : (e && e.session && e.session.submitted ? 'Submitted' : (e && e.session ? 'In progress' : '')));
  });
  vals.push(new Date(), flags_(doc));
  sh.getRange(row, 1, 1, 2).setNumberFormat('@');
  sh.getRange(row, 1, 1, vals.length).setValues([vals]);
}
/* Epoch ms → "2026-10-15 13:52:07" in Philippine time (text, so Sheets does not reformat it). */
function tsText_(ms) {
  var n = Number(ms);
  return n > 0 ? Utilities.formatDate(new Date(n), 'Asia/Manila', 'yyyy-MM-dd HH:mm:ss') : '';
}

/* Rewrite every Scores row from Data (used when the column layout changes). */
function rebuildScores_(ss) {
  var sc = ss.getSheetByName(SHEET.scores), data = ss.getSheetByName(SHEET.data);
  var last = sc.getLastRow(), width = Math.max(sc.getLastColumn(), 1);
  if (last > 1) sc.getRange(2, 1, last - 1, width).clearContent();   // a sheet cannot delete all its unfrozen rows
  var dl = data.getLastRow();
  if (dl < 2) return;
  data.getRange(2, 1, dl - 1, 1).getDisplayValues().forEach(function (r) {
    var id = String(r[0] || '').trim().toUpperCase();
    if (!id) return;
    var doc = readDoc_(ss, id);
    if (doc) writeScores_(ss, id, doc);
  });
}

function log_(ss, id, action, result) {
  try {
    var sh = ss.getSheetByName(SHEET.log);
    sh.appendRow([new Date(), id, action, result]);
    if (sh.getLastRow() > LOG_KEEP + 500) sh.deleteRows(2, 500);   // keep the newest ~4000 lines
  } catch (e) {}
}

/* Reset tab: each row with a code and an activity (A1–A11 or ALL) and an empty
   "Applied" cell is applied once. The score is removed from Data/Scores and a
   reset time is stored, so phones delete their copy and older copies are refused. */
function applyResets_(ss) {
  var sh = ss.getSheetByName(SHEET.reset);
  var last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, 3).getDisplayValues();
  rows.forEach(function (r, i) {
    if (!r[0] || !r[1] || r[2]) return;
    var id = codeNorm_(r[0]) || String(r[0]).replace(/\s+/g, ' ').trim().toUpperCase();
    var what = String(r[1]).replace(/\s+/g, '').toUpperCase();
    var list = what === 'ALL' ? Array.apply(null, Array(ACTIVITY_COUNT)).map(function (_, j) { return j + 1; })
      : what.split(',').map(function (x) { return Number(x.replace(/^A(CTIVITY)?/, '')); })
          .filter(function (n) { return n >= 1 && n <= ACTIVITY_COUNT; });
    var note;
    var doc = readDoc_(ss, id);
    if (!doc) note = 'Not found: check the code';
    else if (!list.length) note = 'Not applied: use A1–A11 or ALL';
    else {
      resetDoc_(ss, id, doc, list, 'reset');
      note = new Date();
    }
    sh.getRange(i + 2, 3).setValue(note);
  });
}

/* Erase activities `list` (numbers) from a student's record; later uploads of older records are refused. */
function resetDoc_(ss, id, doc, list, how) {
  var now = new Date().toISOString();
  doc.resets = doc.resets || {};
  list.forEach(function (n) { doc.resets['activity' + n] = now; delete doc['activity' + n]; });
  doc.updatedAt = now;
  writeDoc_(ss, id, doc);
  writeScores_(ss, id, doc);
  log_(ss, id, how, list.map(function (n) { return 'A' + n; }).join(','));
  return now;
}

/* "12030-7", "12030 07", "1203007" -> "12030-07"; '' when not a code */
function codeNorm_(v) {
  var s = String(v || '').replace(/\s+/g, '').replace(/[\u2010-\u2015_.\/]/g, '-');
  var m = /^(\d{5})-?(\d{1,3})$/.exec(s);
  if (!m) return '';
  var n = Number(m[2]);
  return n ? m[1] + '-' + (n < 10 ? '0' + n : String(n)) : '';
}

/* ---------------- master console ---------------- */
var ADMIN_MAX_FAILS = 5;
var ADMIN_LOCK_S = 15 * 60;
function adminCheck_(hash) {
  var pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!pw) return { ok: false, error: 'noadmin' };
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('ADMIN_FAILS') || 0);
  if (fails >= ADMIN_MAX_FAILS) return { ok: false, error: 'locked' };
  if (sha_('itict-admin|' + pw) === hash) { cache.remove('ADMIN_FAILS'); return { ok: true }; }
  cache.put('ADMIN_FAILS', String(fails + 1), ADMIN_LOCK_S);
  try { log_(SpreadsheetApp.openById(SHEET_ID), 'ADMIN', 'admin', 'wrong password'); } catch (e) {}
  return { ok: false, error: fails + 1 >= ADMIN_MAX_FAILS ? 'locked' : 'auth' };
}
function adminLookup_(ss, req) {
  var id = codeNorm_(req.id);
  if (!id) return { ok: false, error: 'code' };
  var doc = readDoc_(ss, id);
  if (!doc) return { ok: false, error: 'notfound', id: id };
  var acts = [];
  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var r = doc['activity' + n];
    acts.push({ n: n, pct: r ? pct_(r) : null, at: r ? recTime_(r) : '', reset: (doc.resets || {})['activity' + n] || '' });
  }
  return { ok: true, id: id, activities: acts };
}
function adminReset_(ss, req) {
  var id = codeNorm_(req.id);
  if (!id) return { ok: false, error: 'code' };
  var list = (Array.isArray(req.list) ? req.list : []).map(Number)
    .filter(function (n, i, a) { return n >= 1 && n <= ACTIVITY_COUNT && a.indexOf(n) === i; });
  if (!list.length) return { ok: false, error: 'list' };
  var doc = readDoc_(ss, id);
  if (!doc) return { ok: false, error: 'notfound', id: id };
  resetDoc_(ss, id, doc, list, 'admin reset');
  return adminLookup_(ss, { id: id });
}

/* Flags for the instructor to review; nothing is blocked. */
function flags_(doc) {
  var f = [], now = Date.now();
  function secs(r) { var a = Date.parse(r.startTime), b = Date.parse(r.endTime); return a && b ? (b - a) / 1000 : null; }
  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var r = doc['activity' + n];
    if (!r) continue;
    var p = pct_(r);
    if (p < 0 || (n !== 4 && p > 100) || p > 300) f.push('A' + n + ' score ' + p + '%');
    var end = Date.parse(r.endTime || '');
    if (end && end > now + 10 * 60 * 1000) f.push('A' + n + ' time in future');
    var d = secs(r);
    if (n === 1 && d != null && d < 180) f.push('A1 done in ' + Math.round(d) + 's');
    if (n === 2 && d != null && d < 60) f.push('A2 done in ' + Math.round(d) + 's');
    if (n === 4 && r.avgSec != null && r.solved > 3 && r.avgSec < 1) f.push('A4 avg ' + r.avgSec + 's/answer');
  }
  return f.join('; ');
}
/* ---- Exam gate (master console → Examinations) ---- */
function gateIso_(v) {
  var t = Date.parse(String(v || ''));
  return isNaN(t) ? '' : new Date(t).toISOString();
}
function gate_() {
  var raw = {};
  try { raw = JSON.parse(PropertiesService.getScriptProperties().getProperty('EXAM_GATE') || '{}') || {}; } catch (e) { raw = {}; }
  var out = {};
  EXAMS.forEach(function (x) {
    var v = raw[x.id] || {};
    out[x.id] = { open: v.open === true, from: gateIso_(v.from), until: gateIso_(v.until) };
  });
  return out;
}
function setGate_(inc) {
  var cur = gate_();
  EXAMS.forEach(function (x) {
    var v = inc && inc[x.id];
    if (v) cur[x.id] = { open: v.open === true, from: gateIso_(v.from), until: gateIso_(v.until) };
  });
  PropertiesService.getScriptProperties().setProperty('EXAM_GATE', JSON.stringify(cur));
  return cur;
}

/* ================= Special Prefinal =================
   Online multiple-choice Prefinal for students the instructor assigns (master console → Special Prefinal).
   Tab "Special": one row per assigned class code. Opens/Closes = window to start; Minutes = timer.
   The timer ends at Started + Minutes, never after Closes. Scores are written here only; phones never see them.
   Tab "Special bank" (hidden): questions + answer key, uploaded from the master console. It is not in the site's code. */
var SP_TAB = 'Special', SP_BANK = 'Special bank';
var SP_HEAD = ['Code', 'Opens', 'Closes', 'Minutes', 'Set', 'Started', 'Ends', 'Submitted', 'Score', 'Total', 'Answered',
  'Flags', 'Status', 'Answers (item 1 → last)', 'Progress (JSON)'];
var SP_C = { code: 0, opens: 1, closes: 2, min: 3, set: 4, started: 5, ends: 6, sub: 7, score: 8, total: 9, answered: 10,
  flags: 11, status: 12, ans: 13, prog: 14 };
var SP_GRACE = 3 * 60 * 1000;          // upload allowance after the timer ends (slow or offline phones)
var LETTERS = ['A', 'B', 'C', 'D'];

function spSheet_(ss) {
  var sh = ss.getSheetByName(SP_TAB);
  if (!sh) {
    sh = ss.insertSheet(SP_TAB); sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SP_HEAD.length).setValues([SP_HEAD]).setFontWeight('bold');
  }
  return sh;
}
/* "2026-10-19 16:00:00" (Philippine time), a Date, or ISO → ms; 0 when empty */
function phMs_(v) {
  if (v instanceof Date) return v.getTime();
  var s = String(v || '').trim();
  if (!s) return 0;
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
  var t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}
function phText_(ms) { return ms > 0 ? Utilities.formatDate(new Date(ms), 'Asia/Manila', 'yyyy-MM-dd HH:mm:ss') : ''; }
function spRead_(sh, row) { return sh.getRange(row, 1, 1, SP_HEAD.length).getValues()[0]; }
function spWrite_(sh, row, v) { sh.getRange(row, 1, 1, SP_HEAD.length).setNumberFormat('@').setValues([v.map(function (x) { return x == null ? '' : String(x); })]); }
function spDone_(v) { return /^(Submitted|Auto-submitted)/.test(String(v[SP_C.status])); }

/* ---- bank ---- */
function spBank_(ss) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('SP_BANK');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var sh = ss.getSheetByName(SP_BANK);
  if (!sh || sh.getLastColumn() < 1 || sh.getLastRow() < 2) return null;
  var text = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0].join('');
  var bank = null;
  try { bank = JSON.parse(text); } catch (e) { return null; }
  if (text.length < 95000) cache.put('SP_BANK', text, 600);
  return bank;
}
/* Accepts { items: [{ q, c: [4], k: 0-3 }], sets: { A: [order], … } }. Missing sets → A in order, B–D shuffled. */
function spBankCheck_(b) {
  if (!b || !Array.isArray(b.items) || !b.items.length || b.items.length > 200) return null;
  var items = [];
  for (var i = 0; i < b.items.length; i++) {
    var it = b.items[i] || {};
    var k = Number(it.k);
    if (typeof it.q !== 'string' || !it.q.trim() || !Array.isArray(it.c) || it.c.length !== 4 || !(k >= 0 && k <= 3)) return null;
    items.push({ q: String(it.q), c: it.c.map(String), k: k });
  }
  var n = items.length, sets = {};
  var src = b.sets && typeof b.sets === 'object' ? b.sets : null;
  if (src) {
    Object.keys(src).forEach(function (L) {
      var o = src[L];
      if (!/^[A-Z]$/.test(L) || !Array.isArray(o) || o.length !== n) return;
      var seen = {};
      var ok = o.every(function (x) { x = Number(x); if (!(x >= 0 && x < n) || seen[x]) return false; seen[x] = 1; return true; });
      if (ok) sets[L] = o.map(Number);
    });
  }
  if (!Object.keys(sets).length) {
    LETTERS.forEach(function (L, j) {
      var o = []; for (var x = 0; x < n; x++) o.push(x);
      if (j) for (var y = n - 1; y > 0; y--) { var r = Math.floor(Math.random() * (y + 1)); var t = o[y]; o[y] = o[r]; o[r] = t; }
      sets[L] = o;
    });
  }
  return { title: String(b.title || 'Special Prefinal Examination'), items: items, sets: sets };
}
function adminSpecialBank_(ss, req) {
  var bank = spBankCheck_(req.bank);
  if (!bank) return { ok: false, error: 'bank' };
  var sh = ss.getSheetByName(SP_BANK) || ss.insertSheet(SP_BANK);
  sh.clear();
  var text = JSON.stringify(bank), parts = [];
  for (var i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  sh.getRange(1, 1, 1, 2).setValues([['Uploaded', phText_(Date.now())]]);
  sh.getRange(2, 1, 1, parts.length).setNumberFormat('@').setValues([parts]);
  try { sh.hideSheet(); } catch (e) {}
  CacheService.getScriptCache().remove('SP_BANK');
  log_(ss, 'ADMIN', 'specialBank', bank.items.length + ' items · sets ' + Object.keys(bank.sets).join(''));
  return { ok: true, bank: { n: bank.items.length, sets: Object.keys(bank.sets), at: phText_(Date.now()) } };
}

/* ---- scoring ---- */
function spAnswers_(raw, n) {
  if (!Array.isArray(raw) || raw.length !== n) return null;
  var out = [];
  for (var i = 0; i < n; i++) { var a = raw[i] == null ? -1 : Number(raw[i]); if (!(a >= -1 && a <= 3) || a !== Math.floor(a)) return null; out.push(a); }
  return out;
}
/* answers are in the student's set order; returns score and the answers in item order (letters, '-' = blank) */
function spScore_(bank, set, answers) {
  var order = bank.sets[set], n = bank.items.length, byItem = [], score = 0, answered = 0;
  for (var x = 0; x < n; x++) byItem.push('-');
  for (var i = 0; i < n; i++) {
    var item = order[i], a = answers[i];
    if (a >= 0) { answered++; byItem[item] = LETTERS[a]; if (a === bank.items[item].k) score++; }
  }
  return { score: score, total: n, answered: answered, byItem: byItem.join('') };
}
function spFinish_(sh, row, v, bank, answers, status, at, flags) {
  var r = spScore_(bank, v[SP_C.set], answers);
  v[SP_C.sub] = phText_(at); v[SP_C.score] = r.score; v[SP_C.total] = r.total; v[SP_C.answered] = r.answered;
  if (flags != null) v[SP_C.flags] = flags;
  v[SP_C.status] = status; v[SP_C.ans] = r.byItem; v[SP_C.prog] = JSON.stringify(answers);
  spWrite_(sh, row, v);
}
/* A started exam whose time (plus the upload allowance) is over is scored from its last autosave. */
function spOverdue_(sh, row, v, bank, now) {
  if (!bank || spDone_(v) || !v[SP_C.set]) return v;
  var ends = phMs_(v[SP_C.ends]);
  if (!ends || now <= ends + SP_GRACE) return v;
  var prog = null; try { prog = JSON.parse(String(v[SP_C.prog] || 'null')); } catch (e) {}
  prog = spAnswers_(prog, bank.items.length) || bank.items.map(function () { return -1; });
  spFinish_(sh, row, v, bank, prog, 'Auto-submitted (time over)', ends, null);
  return v;
}
function spState_(v, now) {
  if (spDone_(v)) return 'done';
  if (v[SP_C.set]) return now < phMs_(v[SP_C.ends]) + SP_GRACE ? 'started' : 'done';
  var o = phMs_(v[SP_C.opens]), c = phMs_(v[SP_C.closes]);
  if (o && now < o) return 'notyet';
  if (c && now >= c) return 'closed';
  return 'open';
}

/* ---- student actions ---- */
function special_(ss, req, pin, action) {
  var id = String(req.id || '').trim();
  if (!CODE_RE.test(id)) return { ok: false, error: 'bad' };
  var auth = checkPin_(ss, id, hashFor_(id, pin));
  if (auth === 'nouser') return { ok: false, error: 'nouser' };
  if (auth.locked) return { ok: false, error: 'locked', until: auth.until };
  if (auth.bad) return { ok: false, error: 'pin', left: auth.left };

  var sh = spSheet_(ss), row = findRow_(sh, id), now = Date.now();
  if (!row) return { ok: true, assigned: false, now: now };
  var bank = spBank_(ss);
  var v = spOverdue_(sh, row, spRead_(sh, row), bank, now);
  var state = spState_(v, now);
  var info = { ok: true, assigned: true, state: state, now: now, opens: phMs_(v[SP_C.opens]), closes: phMs_(v[SP_C.closes]),
    minutes: Number(v[SP_C.min]) || 0, ends: phMs_(v[SP_C.ends]), set: String(v[SP_C.set] || '') };
  if (action === 'specialStatus') return info;
  if (!bank) return { ok: false, error: 'nobank' };
  var n = bank.items.length;

  if (action === 'specialStart') {
    if (state === 'done') return { ok: false, error: 'done' };
    if (state === 'notyet') return { ok: false, error: 'notyet', opens: info.opens };
    if (state === 'closed') return { ok: false, error: 'closed' };
    if (state === 'open') {
      var letters = Object.keys(bank.sets).sort();
      v[SP_C.set] = letters[Math.floor(Math.random() * letters.length)];
      var mins = Number(v[SP_C.min]) || 60, close = phMs_(v[SP_C.closes]);
      var ends = now + mins * 60000;
      if (close && close < ends) ends = close;
      v[SP_C.started] = phText_(now); v[SP_C.ends] = phText_(ends); v[SP_C.status] = 'In progress';
      spWrite_(sh, row, v);
      log_(ss, id, 'specialStart', 'set ' + v[SP_C.set]);
    }
    var set = String(v[SP_C.set]);
    var prog = null; try { prog = JSON.parse(String(v[SP_C.prog] || 'null')); } catch (e) {}
    return { ok: true, set: set, ends: phMs_(v[SP_C.ends]), now: now, title: bank.title,
      items: bank.sets[set].map(function (x) { return { q: bank.items[x].q, c: bank.items[x].c }; }),
      progress: spAnswers_(prog, n) };
  }

  var answers = spAnswers_(req.answers, n);
  if (!answers) return { ok: false, error: 'bad' };
  if (!v[SP_C.set]) return { ok: false, error: 'notstarted' };
  var flags = Math.max(0, Math.min(9999, Math.floor(Number(req.flags) || 0)));

  if (action === 'specialSave') {
    if (spDone_(v)) return { ok: true, done: true };
    v[SP_C.prog] = JSON.stringify(answers);
    v[SP_C.answered] = answers.filter(function (a) { return a >= 0; }).length;
    v[SP_C.flags] = flags;
    spWrite_(sh, row, v);
    return { ok: true, ends: phMs_(v[SP_C.ends]), now: now };
  }
  if (action === 'specialSubmit') {
    var st = String(v[SP_C.status]);
    if (/^Submitted/.test(st)) return { ok: true, done: true };
    var late = now > phMs_(v[SP_C.ends]) + SP_GRACE;
    if (/^Auto-submitted/.test(st)) {
      /* the phone's own answers arrive after the time-over scoring: keep them if they hold at least as many answers */
      var had = Number(v[SP_C.answered]) || 0;
      if (answers.filter(function (a) { return a >= 0; }).length < had) return { ok: true, done: true };
      late = true;
    }
    spFinish_(sh, row, v, bank, answers, late ? 'Submitted (uploaded late)' : 'Submitted', now, flags);
    log_(ss, id, 'specialSubmit', late ? 'late' : 'ok');
    return { ok: true, done: true };
  }
  return { ok: false, error: 'bad' };
}

/* ---- master console ---- */
function adminSpecial_(ss, req) {
  var sh = spSheet_(ss), now = Date.now(), msg = {};
  if (req.assign) {
    var a = req.assign;
    var opens = Date.parse(String(a.opens || '')), closes = Date.parse(String(a.closes || ''));
    var mins = Math.floor(Number(a.minutes) || 0);
    if (isNaN(opens) || isNaN(closes) || closes <= opens || !(mins >= 1 && mins <= 600)) return { ok: false, error: 'window' };
    var codes = (Array.isArray(a.codes) ? a.codes : []).map(codeNorm_).filter(function (c, i, arr) { return c && arr.indexOf(c) === i; });
    if (!codes.length) return { ok: false, error: 'code' };
    var auth = ss.getSheetByName(SHEET.auth);
    var added = [], updated = [], missing = [];
    codes.forEach(function (c) {
      if (!findRow_(auth, c)) { missing.push(c); return; }
      var row = findRow_(sh, c), v;
      if (row) { v = spRead_(sh, row); updated.push(c); }
      else { row = sh.getLastRow() + 1; v = SP_HEAD.map(function () { return ''; }); v[SP_C.code] = c; added.push(c); }
      v[SP_C.opens] = phText_(opens); v[SP_C.closes] = phText_(closes); v[SP_C.min] = mins;
      spWrite_(sh, row, v);
    });
    log_(ss, 'ADMIN', 'specialAssign', added.length + ' added · ' + updated.length + ' updated · ' + missing.length + ' not found');
    msg = { added: added, updated: updated, missing: missing };
  }
  if (Array.isArray(req.remove)) {
    var gone = [];
    req.remove.map(codeNorm_).forEach(function (c) { if (c && findRow_(sh, c)) { deleteRowsFor_(sh, c); gone.push(c); } });
    log_(ss, 'ADMIN', 'specialRemove', gone.join(','));
    msg.removed = gone;
  }
  var bank = spBank_(ss), rows = [], last = sh.getLastRow();
  for (var r = 2; r <= last; r++) {
    var v = spRead_(sh, r);
    if (!CODE_RE.test(String(v[SP_C.code]).trim())) continue;
    v = spOverdue_(sh, r, v, bank, now);
    rows.push({ code: String(v[SP_C.code]), opens: phMs_(v[SP_C.opens]), closes: phMs_(v[SP_C.closes]), minutes: Number(v[SP_C.min]) || 0,
      set: String(v[SP_C.set] || ''), started: phMs_(v[SP_C.started]), ends: phMs_(v[SP_C.ends]), submitted: phMs_(v[SP_C.sub]),
      score: v[SP_C.score] === '' ? null : Number(v[SP_C.score]), total: Number(v[SP_C.total]) || 0, answered: Number(v[SP_C.answered]) || 0,
      flags: Number(v[SP_C.flags]) || 0, status: String(v[SP_C.status] || ''), state: spState_(v, now) });
  }
  var bsh = ss.getSheetByName(SP_BANK);
  return { ok: true, rows: rows, now: now, msg: msg,
    bank: bank ? { n: bank.items.length, sets: Object.keys(bank.sets), at: bsh ? String(bsh.getRange(1, 2).getDisplayValue()) : '' } : null };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor (▶ setup) to create the tabs and approve permissions. */
function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  ss.rename('IT Era — Student Records');
  ensureSheets_(ss);
  salt_();
  PropertiesService.getScriptProperties().setProperty('HEAD_SIG', headSig_());
  CacheService.getScriptCache().removeAll(['SCHEDULES', 'RESETS_CHECKED']);
}

/* Run from the editor when the conversion period ends: removes every name-keyed (version 1)
   row from Auth, Data, Scores and Log. Students who never converted lose their online copy;
   their devices keep their scores and can register again. */
function purgeLegacy() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var lock = LockService.getScriptLock();
  lock.waitLock(28000);
  try {
    var removed = 0;
    [SHEET.auth, SHEET.data, SHEET.scores, SHEET.log].forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      var col = name === SHEET.log ? 2 : 1;
      var last = sh.getLastRow();
      if (last < 2) return;
      var keys = sh.getRange(2, col, last - 1, 1).getDisplayValues();
      for (var i = keys.length - 1; i >= 0; i--) {
        var k = String(keys[i][0]).trim();
        var keep = CODE_RE.test(k) || (name === SHEET.log && (k === '' || k === '(old account)'));
        if (!keep) { delRow_(sh, i + 2); removed++; }
      }
    });
    Logger.log('purgeLegacy: removed ' + removed + ' rows');
  } finally {
    lock.releaseLock();
  }
}

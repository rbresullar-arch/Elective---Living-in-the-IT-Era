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
 *   { action: 'adminScores', pin }              → { ok, head, rows } the Scores tab as shown (read only);
 *                                                 used by the instructor's offline grading system
 *   { action: 'adminReset', pin, id, list }     → resets activities in `list` (numbers) at once
 *   { action: 'adminExamGate', pin }            → { ok, gate, now }  (read)
 *   { action: 'adminExamGate', pin, gate }      → saves which examinations are open; returns { ok, gate, now }
 *        gate = { <exam id>: { open: true|false, from: ISO or '', until: ISO or '' } }
 *   { action: 'adminSpecial', pin }             → { ok, rows, banks, closes, minutes, now }  Special Exams list (read)
 *   { action: 'adminSpecial', pin, remove: [{ code, exam }] } → deletes those attempts (the student may take it again)
 *   { action: 'adminSpecialBank', pin, bank }   → bank = { exams: { prelim|midterm|prefinals: { title, parts } } };
 *        stores questions + key in the hidden "Special Exams bank" tab (never sent to phones with the key)
 * Special Exams (students, same id + pin as save). Open to every class code; one attempt per exam.
 *   Window ends SPX_CLOSES (Philippine time); timer SPX_MINUTES. exam = 'prelim' | 'midterm' | 'prefinals'.
 *   { action: 'specialStatus', id, pin }        → { ok, closes, minutes, exams: { <exam>: { state, ends } }, now }
 *   { action: 'specialStart', id, pin, exam, reason } → { ok, ends, parts: [{ title, text, pts, items: [{ q, c }] }], progress }
 *   { action: 'specialSave', id, pin, exam, answers, blocked, flags, pos } → progress autosave
 *   { action: 'specialSubmit', id, pin, exam, answers, blocked, flags } → { ok, done } (the score is never returned)
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
var ACTIVITY_COUNT = 13;
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
      if (action === 'adminScores') return json_(adminScores_(as));
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
      if (action === 'adminEdit') {
        var el = LockService.getScriptLock();
        try { el.waitLock(28000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
        try { return json_(adminEdit_(as, req)); } finally { el.releaseLock(); }
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

  /* Special Exams: each student writes only its own rows, so no queue */
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
    if (action === 'changeSched') return json_(changeSched_(ss, req, pin));
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

/* Profile → change schedule. The first 5 digits of a class code are the schedule, so the
   account moves to the next free code of the new schedule: Auth, Data, Scores, Special Exams
   and Log rows are renamed; scores and PIN stay. */
function changeSched_(ss, req, pin) {
  var id = String(req.id || '').trim();
  if (!CODE_RE.test(id)) return { ok: false, error: 'bad' };
  var sched = String(req.sched || '').trim();
  if (!schedOk_(ss, sched)) return { ok: false, error: 'sched' };
  if (sched === id.slice(0, 5)) return { ok: false, error: 'same' };
  var auth = checkPin_(ss, id, hashFor_(id, pin));
  if (auth === 'nouser') { log_(ss, id, 'change schedule', 'nouser'); return { ok: false, error: 'nouser' }; }
  if (auth.locked) return { ok: false, error: 'locked', until: auth.until };
  if (auth.bad) { log_(ss, id, 'change schedule', 'pin (' + auth.left + ' left)'); return { ok: false, error: 'pin', left: auth.left }; }

  var code = nextCode_(ss, sched);
  var stored = readDoc_(ss, id) || {};
  var incoming = cleanIncoming_(req.data);
  delete incoming.sched;
  var merged = merge_(stored, incoming);
  merged.sched = sched;
  merged.movedFrom = (merged.movedFrom ? merged.movedFrom + ', ' : '') + id;

  var ash = ss.getSheetByName(SHEET.auth);
  var arow = findRow_(ash, id);
  ash.getRange(arow, 1, 1, 2).setNumberFormat('@').setValues([[code, hashFor_(code, pin)]]);

  deleteRowsFor_(ss.getSheetByName(SHEET.data), id);
  deleteRowsFor_(ss.getSheetByName(SHEET.scores), id);
  writeDoc_(ss, code, merged);
  writeScores_(ss, code, merged);

  [SPX_TAB, SHEET.log].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var col = name === SHEET.log ? 2 : 1;
    var rng = sh.getRange(2, col, sh.getLastRow() - 1, 1), v = rng.getDisplayValues(), hit = false;
    v.forEach(function (r) { if (String(r[0]).trim().toUpperCase() === id) { r[0] = code; hit = true; } });
    if (hit) rng.setNumberFormat('@').setValues(v);
  });
  log_(ss, code, 'change schedule', id + ' → ' + code);
  return { ok: true, code: code, data: merged };
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
function headSig_() { return 'v4-nametag|' + ACTIVITY_COUNT + '|' + EXAMS.map(function (x) { return x.id; }).join(','); }
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
  /* only the short name tag is kept: 2 letters of the first name + 1st + last 2 letters of the last name */
  if (doc.nameTag != null) {
    var tg = String(doc.nameTag).toUpperCase().replace(/[^A-Z]/g, '');
    if (tg && tg.length <= 5) doc.nameTag = tg; else delete doc.nameTag;
  }
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
  if (inc.nameTag) out.nameTag = inc.nameTag;                     // latest tag wins (already validated)

  out.resets = out.resets || {};      // written only by applyResets_

  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var k = 'activity' + n, r = inc[k];
    if (!r || typeof r !== 'object') continue;
    var t = recTime_(r);
    if (out.resets[k] && t && t < out.resets[k]) continue;
    if (out[k] && out[k].adminEdit && !(t && t > out[k].adminEdit)) continue;   // instructor's edit wins over older copies
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
  if (r.adminEdit && r.percentage != null) return Number(r.percentage) || 0;
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
  heads[SHEET.scores] = ['Code', 'Schedule', 'Name tag'];
  for (var n = 1; n <= ACTIVITY_COUNT; n++) heads[SHEET.scores].push('A' + n + ' %');
  EXAMS.forEach(function (x) {
    if (x.paper) heads[SHEET.scores].push(x.label + ' set', x.label + ' start', x.label + ' end', x.label + ' flags');
    else heads[SHEET.scores].push(x.label);
  });
  heads[SHEET.scores].push('Last sync', 'Flags (review)');
  heads[SHEET.data] = ['Code', 'Schedule', 'Updated', 'JSON (split across columns)'];
  heads[SHEET.auth] = ['Code', 'PIN hash (clear cell to reset PIN)', 'Registered', 'Wrong tries', 'Locked until (clear to unlock)'];
  heads[SHEET.reset] = ['Code (as in Scores)', 'Activity: A1–A13 or ALL', 'Applied (filled by script)'];
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
  var vals = [id, doc.sched || '', doc.nameTag || ''];
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
  sh.getRange(row, 1, 1, 3).setNumberFormat('@');
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
    acts.push({ n: n, pct: r ? pct_(r) : null, at: r ? recTime_(r) : '', reset: (doc.resets || {})['activity' + n] || '', edited: !!(r && r.adminEdit) });
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

/* The Scores tab exactly as displayed (header + rows), for the instructor's offline grading system.
   Read only: nothing in the Sheet changes. Each export is written to the Log tab. */
function adminScores_(ss) {
  var sh = ss.getSheetByName(SHEET.scores);
  var last = sh.getLastRow(), width = sh.getLastColumn();
  if (last < 1 || width < 1) return { ok: true, head: [], rows: [] };
  var vals = sh.getRange(1, 1, last, width).getDisplayValues();
  var rows = vals.slice(1).filter(function (r) { return String(r[0] || '').trim(); });
  log_(ss, 'ADMIN', 'scores export', rows.length + ' rows');
  return { ok: true, head: vals[0], rows: rows, now: Date.now() };
}

/* Set one activity's score (percent). The record is rescaled so the hub and the Sheet agree;
   adminEdit (time) makes merge_ refuse older copies still on the student's phone. */
function adminEdit_(ss, req) {
  var id = codeNorm_(req.id);
  if (!id) return { ok: false, error: 'code' };
  var n = Number(req.n), pct = Math.round(Number(req.pct));
  if (!(n >= 1 && n <= ACTIVITY_COUNT)) return { ok: false, error: 'act' };
  if (!isFinite(pct) || pct < 0 || pct > (n === 4 ? 300 : 100)) return { ok: false, error: 'pct' };
  var doc = readDoc_(ss, id);
  if (!doc) return { ok: false, error: 'notfound', id: id };
  var k = 'activity' + n, now = new Date().toISOString();
  var old = doc[k], r = old ? JSON.parse(JSON.stringify(old)) : { score: 0, maxScore: 100, endTime: now };
  var before = old ? pct_(old) : null;
  if (r.totalMax) r.totalScore = Math.round(pct * r.totalMax / 100);
  if (r.maxScore || r.score != null) r.score = Math.round(pct * (r.maxScore || 100) / 100);
  r.percentage = pct;
  r.adminEdit = now;
  r.adminFrom = before;
  doc[k] = r;
  doc.updatedAt = now;
  writeDoc_(ss, id, doc);
  writeScores_(ss, id, doc);
  log_(ss, id, 'admin edit', 'A' + n + ' ' + (before == null ? 'none' : before + '%') + ' → ' + pct + '%');
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
    if (n === 12 && r.flags) {   // Prefinals Summative: copy/capture blocks a part; leaving the page is only counted
      if ((r.blockedParts || []).length) f.push('A12 blocked part ' + r.blockedParts.join(',') + ' (copy ' + (r.flags.copy || 0) + ', capture ' + (r.flags.capture || 0) + ')');
      if (r.flags.leave) f.push('A12 left page ' + r.flags.leave + 'x');
    }
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

/* ================= Special Examinations =================
   Online special examinations (Prelim, Midterm, Prefinals) for students who missed the regular one.
   Open to every student with a class code + PIN: no assignment. One attempt per student per exam.
   Window: from the bank upload until SPX_CLOSES (Philippine time). Timer: SPX_MINUTES, never past SPX_CLOSES.
   Tab "Special Exams": one row per class code + exam. The score is written here only; phones never see it.
   Tab "Special Exams bank" (hidden): questions + answer key per exam, uploaded from the master console.
   The key is never in the site's code (the repository is public). */
var SPX_TAB = 'Special Exams', SPX_BANK = 'Special Exams bank';
var SPX_CLOSES = '2026-11-17 23:59';   // Philippine time
var SPX_MINUTES = 45;
var SPX_EXAMS = [{ id: 'prelim', label: 'Prelim' }, { id: 'midterm', label: 'Midterm' }, { id: 'prefinals', label: 'Prefinals' }];
var SPX_HEAD = ['Code', 'Exam', 'Reason', 'Started', 'Ends', 'Submitted', 'Remember', 'Analysis', 'Score', 'Max',
  'Answered', 'Flags', 'Blocked parts', 'Status', 'Answers (item 1 → last)', 'Progress (JSON)'];
var SPX_C = { code: 0, exam: 1, reason: 2, started: 3, ends: 4, sub: 5, rem: 6, ana: 7, score: 8, max: 9,
  answered: 10, flags: 11, blocked: 12, status: 13, ans: 14, prog: 15 };
var SPX_GRACE = 3 * 60 * 1000;         // upload allowance after the timer ends (slow or offline phones)
var LETTERS = ['A', 'B', 'C', 'D'];

function spxExam_(v) {
  var e = String(v || '').toLowerCase();
  return SPX_EXAMS.some(function (x) { return x.id === e; }) ? e : '';
}
function spxLabel_(e) { for (var i = 0; i < SPX_EXAMS.length; i++) if (SPX_EXAMS[i].id === e) return SPX_EXAMS[i].label; return e; }
function spxSheet_(ss) {
  var sh = ss.getSheetByName(SPX_TAB);
  if (!sh) {
    sh = ss.insertSheet(SPX_TAB); sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SPX_HEAD.length).setValues([SPX_HEAD]).setFontWeight('bold');
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
function spxRead_(sh, row) { return sh.getRange(row, 1, 1, SPX_HEAD.length).getValues()[0]; }
function spxWrite_(sh, row, v) { sh.getRange(row, 1, 1, SPX_HEAD.length).setNumberFormat('@').setValues([v.map(function (x) { return x == null ? '' : String(x); })]); }
function spxDone_(v) { return /^(Submitted|Auto-submitted)/.test(String(v[SPX_C.status])); }
function spxFind_(sh, code, exam) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 2).getDisplayValues();
  for (var i = 0; i < vals.length; i++)
    if (String(vals[i][0]).trim().toUpperCase() === code && String(vals[i][1]).trim().toLowerCase() === exam) return i + 2;
  return 0;
}
/* plain one-line text, at most 100 characters */
function spxReason_(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/* ---- bank ---- */
function spxBankAll_(ss) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('SPX_BANK');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var sh = ss.getSheetByName(SPX_BANK);
  if (!sh || sh.getLastColumn() < 1 || sh.getLastRow() < 2) return {};
  var text = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0].join('');
  var all = {};
  try { all = JSON.parse(text) || {}; } catch (e) { return {}; }
  if (text.length < 95000) cache.put('SPX_BANK', text, 600);
  return all;
}
/* One exam: { title, parts: [{ title, text, pts, items: [{ q, c: [4], k: 0-3 }] }] } */
function spxBankCheck_(b) {
  if (!b || !Array.isArray(b.parts) || !b.parts.length || b.parts.length > 30) return null;
  var parts = [], n = 0;
  for (var p = 0; p < b.parts.length; p++) {
    var src = b.parts[p] || {}, pts = Number(src.pts);
    if (!(pts >= 1 && pts <= 100) || !Array.isArray(src.items) || !src.items.length) return null;
    var items = [];
    for (var i = 0; i < src.items.length; i++) {
      var it = src.items[i] || {}, k = Number(it.k);
      if (typeof it.q !== 'string' || !it.q.trim() || !Array.isArray(it.c) || it.c.length !== 4 || !(k >= 0 && k <= 3) || k !== Math.floor(k)) return null;
      items.push({ q: String(it.q), c: it.c.map(String), k: k });
    }
    n += items.length;
    parts.push({ title: String(src.title || ''), text: String(src.text || ''), pts: pts, items: items });
  }
  if (n > 200) return null;
  return { title: String(b.title || 'Special Examination'), parts: parts };
}
function spxCount_(bank) { return bank.parts.reduce(function (s, p) { return s + p.items.length; }, 0); }
function spxMax_(bank) { return bank.parts.reduce(function (s, p) { return s + p.pts * p.items.length; }, 0); }
/* bank = { exams: { prelim: {…}, midterm: {…}, prefinals: {…} } } — any subset; the others stay as they are */
function adminSpecialBank_(ss, req) {
  var src = req.bank && req.bank.exams;
  if (!src || typeof src !== 'object') return { ok: false, error: 'bank' };
  var all = spxBankAll_(ss), saved = [];
  for (var key in src) {
    var e = spxExam_(key);
    if (!e) return { ok: false, error: 'bank' };
    var b = spxBankCheck_(src[key]);
    if (!b) return { ok: false, error: 'bank', exam: e };
    b.at = phText_(Date.now());
    all[e] = b; saved.push(e);
  }
  if (!saved.length) return { ok: false, error: 'bank' };
  var sh = ss.getSheetByName(SPX_BANK) || ss.insertSheet(SPX_BANK);
  sh.clear();
  var text = JSON.stringify(all), parts = [];
  for (var i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  sh.getRange(1, 1, 1, 2).setValues([['Uploaded', phText_(Date.now())]]);
  sh.getRange(2, 1, 1, parts.length).setNumberFormat('@').setValues([parts]);
  try { sh.hideSheet(); } catch (e) {}
  CacheService.getScriptCache().remove('SPX_BANK');
  log_(ss, 'ADMIN', 'specialBank', saved.map(function (x) { return spxLabel_(x) + ' ' + spxCount_(all[x]) + ' items'; }).join(' · '));
  return { ok: true, banks: spxBankInfo_(all) };
}
function spxBankInfo_(all) {
  var out = {};
  SPX_EXAMS.forEach(function (x) { var b = all[x.id]; out[x.id] = b ? { n: spxCount_(b), max: spxMax_(b), at: b.at || '' } : null; });
  return out;
}

/* ---- scoring ---- */
function spxAnswers_(raw, n) {
  if (!Array.isArray(raw) || raw.length !== n) return null;
  var out = [];
  for (var i = 0; i < n; i++) { var a = raw[i] == null ? -1 : Number(raw[i]); if (!(a >= -1 && a <= 3) || a !== Math.floor(a)) return null; out.push(a); }
  return out;
}
function spxBlocked_(raw, nParts) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  raw.forEach(function (x) { x = Number(x); if (x >= 0 && x < nParts && x === Math.floor(x) && out.indexOf(x) < 0) out.push(x); });
  return out.sort(function (a, b) { return a - b; });
}
/* answers hold the original choice index (0–3, -1 blank) in item order. Blocked parts score 0.
   Remember = parts worth 1 point per item; Analysis = parts worth more. */
function spxScore_(bank, answers, blocked) {
  var rem = 0, ana = 0, answered = 0, letters = [], i = 0;
  bank.parts.forEach(function (p, pi) {
    p.items.forEach(function (it) {
      var a = answers[i++];
      letters.push(a >= 0 ? LETTERS[a] : '-');
      if (a >= 0) answered++;
      if (a === it.k && blocked.indexOf(pi) < 0) { if (p.pts > 1) ana += p.pts; else rem += p.pts; }
    });
  });
  return { rem: rem, ana: ana, score: rem + ana, max: spxMax_(bank), answered: answered, letters: letters.join('') };
}
function spxFinish_(sh, row, v, bank, prog, status, at) {
  var r = spxScore_(bank, prog.answers, prog.blocked);
  v[SPX_C.sub] = phText_(at); v[SPX_C.rem] = r.rem; v[SPX_C.ana] = r.ana; v[SPX_C.score] = r.score; v[SPX_C.max] = r.max;
  v[SPX_C.answered] = r.answered; v[SPX_C.flags] = prog.flags || 0;
  v[SPX_C.blocked] = prog.blocked.map(function (x) { return x + 1; }).join(',');
  v[SPX_C.status] = status; v[SPX_C.ans] = r.letters; v[SPX_C.prog] = JSON.stringify(prog);
  spxWrite_(sh, row, v);
}
function spxProg_(v, bank) {
  var n = spxCount_(bank), p = null;
  try { p = JSON.parse(String(v[SPX_C.prog] || 'null')); } catch (e) {}
  p = p || {};
  return { answers: spxAnswers_(p.answers, n) || bank.parts.reduce(function (a, x) { return a.concat(x.items.map(function () { return -1; })); }, []),
    blocked: spxBlocked_(p.blocked, bank.parts.length), flags: Math.max(0, Math.floor(Number(p.flags) || 0)),
    pos: p.pos && typeof p.pos === 'object' ? { part: Math.floor(Number(p.pos.part) || 0), q: Math.floor(Number(p.pos.q) || 0) } : { part: 0, q: 0 } };
}
/* A started exam whose time (plus the upload allowance) is over is scored from its last autosave. */
function spxOverdue_(sh, row, v, bank, now) {
  if (!bank || spxDone_(v) || !v[SPX_C.started]) return v;
  var ends = phMs_(v[SPX_C.ends]);
  if (!ends || now <= ends + SPX_GRACE) return v;
  spxFinish_(sh, row, v, bank, spxProg_(v, bank), 'Auto-submitted (time over)', ends);
  return v;
}
function spxState_(v, bank, now) {
  if (v && spxDone_(v)) return 'done';
  if (v && v[SPX_C.started]) return now < phMs_(v[SPX_C.ends]) + SPX_GRACE ? 'started' : 'done';
  if (now >= phMs_(SPX_CLOSES)) return 'closed';
  if (!bank) return 'notready';
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

  var sh = spxSheet_(ss), now = Date.now(), all = spxBankAll_(ss);
  var closes = phMs_(SPX_CLOSES);

  if (action === 'specialStatus') {
    var exams = {};
    SPX_EXAMS.forEach(function (x) {
      var b = all[x.id] || null, row = spxFind_(sh, id, x.id), v = null;
      if (row) v = spxOverdue_(sh, row, spxRead_(sh, row), b, now);
      exams[x.id] = { state: spxState_(v, b, now), ends: v ? phMs_(v[SPX_C.ends]) : 0 };
    });
    return { ok: true, now: now, closes: closes, minutes: SPX_MINUTES, exams: exams };
  }

  var exam = spxExam_(req.exam);
  if (!exam) return { ok: false, error: 'bad' };
  var bank = all[exam] || null;
  var row = spxFind_(sh, id, exam);
  var v = row ? spxOverdue_(sh, row, spxRead_(sh, row), bank, now) : null;
  var state = spxState_(v, bank, now);

  if (action === 'specialStart') {
    if (state === 'done') return { ok: false, error: 'done' };
    if (state === 'closed') return { ok: false, error: 'closed' };
    if (state === 'notready' || !bank) return { ok: false, error: 'nobank' };
    if (state === 'open') {
      var reason = spxReason_(req.reason);
      if (!reason) return { ok: false, error: 'reason' };
      var ends = Math.min(now + SPX_MINUTES * 60000, closes);
      v = SPX_HEAD.map(function () { return ''; });
      v[SPX_C.code] = id; v[SPX_C.exam] = exam; v[SPX_C.reason] = reason;
      v[SPX_C.started] = phText_(now); v[SPX_C.ends] = phText_(ends); v[SPX_C.status] = 'In progress';
      v[SPX_C.max] = spxMax_(bank);
      if (!row) row = sh.getLastRow() + 1;
      spxWrite_(sh, row, v);
      log_(ss, id, 'specialStart', spxLabel_(exam));
    }
    var prog = spxProg_(v, bank);
    return { ok: true, exam: exam, ends: phMs_(v[SPX_C.ends]), now: now, title: bank.title, max: spxMax_(bank),
      parts: bank.parts.map(function (p) { return { title: p.title, text: p.text, pts: p.pts, items: p.items.map(function (it) { return { q: it.q, c: it.c }; }) }; }),
      progress: prog };
  }

  if (!v || !v[SPX_C.started]) return { ok: false, error: 'notstarted' };
  if (!bank) return { ok: false, error: 'nobank' };
  var answers = spxAnswers_(req.answers, spxCount_(bank));
  if (!answers) return { ok: false, error: 'bad' };
  var next = { answers: answers, blocked: spxBlocked_(req.blocked, bank.parts.length),
    flags: Math.max(0, Math.min(9999, Math.floor(Number(req.flags) || 0))),
    pos: req.pos && typeof req.pos === 'object' ? { part: Math.floor(Number(req.pos.part) || 0), q: Math.floor(Number(req.pos.q) || 0) } : { part: 0, q: 0 } };

  if (action === 'specialSave') {
    if (spxDone_(v)) return { ok: true, done: true };
    v[SPX_C.prog] = JSON.stringify(next);
    v[SPX_C.answered] = answers.filter(function (a) { return a >= 0; }).length;
    v[SPX_C.flags] = next.flags;
    spxWrite_(sh, row, v);
    return { ok: true, ends: phMs_(v[SPX_C.ends]), now: now };
  }
  if (action === 'specialSubmit') {
    var st = String(v[SPX_C.status]);
    if (/^Submitted/.test(st)) return { ok: true, done: true };
    var late = now > phMs_(v[SPX_C.ends]) + SPX_GRACE;
    if (/^Auto-submitted/.test(st)) {
      /* the phone's own answers arrive after the time-over scoring: keep them if they hold at least as many answers */
      var had = Number(v[SPX_C.answered]) || 0;
      if (answers.filter(function (a) { return a >= 0; }).length < had) return { ok: true, done: true };
      late = true;
    }
    spxFinish_(sh, row, v, bank, next, late ? 'Submitted (uploaded late)' : 'Submitted', now);
    log_(ss, id, 'specialSubmit', spxLabel_(exam) + (late ? ' late' : ''));
    return { ok: true, done: true };
  }
  return { ok: false, error: 'bad' };
}

/* ---- master console ---- */
/* { remove: [{ code, exam }] } deletes those attempts (the student may take that exam again). */
function adminSpecial_(ss, req) {
  var sh = spxSheet_(ss), now = Date.now(), all = spxBankAll_(ss), msg = {};
  if (Array.isArray(req.remove)) {
    var gone = [];
    req.remove.forEach(function (x) {
      var c = codeNorm_(x && x.code), e = spxExam_(x && x.exam);
      if (!c || !e) return;
      for (var r = spxFind_(sh, c, e); r; r = spxFind_(sh, c, e)) delRow_(sh, r);
      gone.push(c + ' ' + spxLabel_(e));
    });
    log_(ss, 'ADMIN', 'specialRemove', gone.join(','));
    msg.removed = gone;
  }
  var rows = [], last = sh.getLastRow();
  for (var r = 2; r <= last; r++) {
    var v = spxRead_(sh, r), e = spxExam_(v[SPX_C.exam]);
    if (!CODE_RE.test(String(v[SPX_C.code]).trim()) || !e) continue;
    v = spxOverdue_(sh, r, v, all[e] || null, now);
    rows.push({ code: String(v[SPX_C.code]), exam: e, reason: String(v[SPX_C.reason] || ''),
      started: phMs_(v[SPX_C.started]), ends: phMs_(v[SPX_C.ends]), submitted: phMs_(v[SPX_C.sub]),
      rem: v[SPX_C.rem] === '' ? null : Number(v[SPX_C.rem]), ana: v[SPX_C.ana] === '' ? null : Number(v[SPX_C.ana]),
      score: v[SPX_C.score] === '' ? null : Number(v[SPX_C.score]), max: Number(v[SPX_C.max]) || 0,
      answered: Number(v[SPX_C.answered]) || 0, flags: Number(v[SPX_C.flags]) || 0, blocked: String(v[SPX_C.blocked] || ''),
      status: String(v[SPX_C.status] || ''), state: spxState_(v, all[e] || null, now) });
  }
  return { ok: true, rows: rows, now: now, msg: msg, closes: phMs_(SPX_CLOSES), minutes: SPX_MINUTES,
    exams: SPX_EXAMS, banks: spxBankInfo_(all) };
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

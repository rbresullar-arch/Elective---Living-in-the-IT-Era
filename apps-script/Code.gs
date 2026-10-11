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
 *   Reset     — instructor-only score resets: type a code and A1–A9 or ALL; applied on the next request.
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
 * GET ?action=schedules → { ok, schedules: [{ code, label }] }
 *
 * Instructor tools (run from the editor):
 *   setup()        — create tabs, seed Schedules, approve permissions.
 *   purgeLegacy()  — delete every remaining version-1 (name-keyed) row from Auth, Data, Scores and Log.
 *                    Run it when the conversion period ends.
 */

var SHEET_ID = '1n6qku2kUCGF51gi8BVrMqK-Gz8EajW1ubG0JxvSKiDU';
var SHEET = { scores: 'Scores', data: 'Data', auth: 'Auth', reset: 'Reset', log: 'Log', sched: 'Schedules' };
var MAX_FAILS = 3;
var LOCK_MS = 24 * 60 * 60 * 1000;
var LOG_KEEP = 4000;
var ACTIVITY_COUNT = 9;
var EXAMS = [{ id: 'examPrelim', label: 'Prelim' }, { id: 'exam1', label: 'Midterm' }];
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

  var lock = LockService.getScriptLock();
  try { lock.waitLock(28000); } catch (err) { return json_({ ok: false, error: 'busy' }); }   // requests queue here
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    ensureSheets_(ss);
    applyResets_(ss);
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
function getSchedules_(ss) {
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
  EXAMS.forEach(function (x) { heads[SHEET.scores].push(x.label); });
  heads[SHEET.scores].push('Last sync', 'Flags (review)');
  heads[SHEET.data] = ['Code', 'Schedule', 'Updated', 'JSON (split across columns)'];
  heads[SHEET.auth] = ['Code', 'PIN hash (clear cell to reset PIN)', 'Registered', 'Wrong tries', 'Locked until (clear to unlock)'];
  heads[SHEET.reset] = ['Code (as in Scores)', 'Activity: A1–A9 or ALL', 'Applied (filled by script)'];
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
    vals.push(res && res.total ? res.score + '/' + res.total : (e && e.session && e.session.submitted ? 'Submitted' : (e && e.session ? 'In progress' : '')));
  });
  vals.push(new Date(), flags_(doc));
  sh.getRange(row, 1, 1, 2).setNumberFormat('@');
  sh.getRange(row, 1, 1, vals.length).setValues([vals]);
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

/* Reset tab: each row with a code and an activity (A1–A9 or ALL) and an empty
   "Applied" cell is applied once. The score is removed from Data/Scores and a
   reset time is stored, so phones delete their copy and older copies are refused. */
function applyResets_(ss) {
  var sh = ss.getSheetByName(SHEET.reset);
  var last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, 3).getDisplayValues();
  rows.forEach(function (r, i) {
    if (!r[0] || !r[1] || r[2]) return;
    var id = String(r[0]).replace(/\s+/g, ' ').trim().toUpperCase();
    var what = String(r[1]).replace(/\s+/g, '').toUpperCase();
    var list = what === 'ALL' ? Array.apply(null, Array(ACTIVITY_COUNT)).map(function (_, j) { return j + 1; })
      : what.split(',').map(function (x) { return Number(x.replace(/^A(CTIVITY)?/, '')); })
          .filter(function (n) { return n >= 1 && n <= ACTIVITY_COUNT; });
    var note;
    var doc = readDoc_(ss, id);
    if (!doc) note = 'Not found: check the code';
    else if (!list.length) note = 'Not applied: use A1–A9 or ALL';
    else {
      var now = new Date().toISOString();
      doc.resets = doc.resets || {};
      list.forEach(function (n) { doc.resets['activity' + n] = now; delete doc['activity' + n]; });
      doc.updatedAt = now;
      writeDoc_(ss, id, doc);
      writeScores_(ss, id, doc);
      log_(ss, id, 'reset', list.map(function (n) { return 'A' + n; }).join(','));
      note = new Date();
    }
    sh.getRange(i + 2, 3).setValue(note);
  });
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
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor (▶ setup) to create the tabs and approve permissions. */
function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  ss.rename('IT Era — Student Records');
  ensureSheets_(ss);
  salt_();
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

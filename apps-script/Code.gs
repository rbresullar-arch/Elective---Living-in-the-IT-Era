/**
 * Living in the IT Era — student record backup (Google Apps Script web app)
 *
 * Standalone Apps Script project that writes to the "IT Era — Student Records" Google Sheet (SHEET_ID).
 * Deploy: Deploy → New deployment → Web app · Execute as: Me · Who has access: Anyone.
 * Live: owner tellmei.282@gmail.com · web app URL is CLOUD_URL in index.html and the activity pages.
 * After editing this file: Deploy → Manage deployments → edit → Version: New version (keeps the same URL).
 *
 * Tabs (created automatically on first request):
 *   Scores — one readable row per student (instructor view)
 *   Data   — full sync payload per student, JSON split across cells (used for restore)
 *   Auth   — student key (normalized name) + salted PIN hash. Delete a row to reset that PIN.
 *            3 wrong PINs lock the name for 24 h ("Locked until"); clear that cell to unlock early.
 *   Reset  — instructor-only score resets: type a name and A1–A9 or ALL; applied on the next request.
 *            Phones cannot clear scores; only this tab can.
 *   Log    — one line per request (time, ID, action, result)
 *
 * Requests: POST, Content-Type text/plain, body JSON:
 *   { action: 'save', id, pin, name, data, create } → merges data, returns { ok, data }
 *     (an unknown id is registered only when create is true; otherwise error 'nouser')
 *   { action: 'restore', id, pin }                    → returns { ok, data }
 * `id` is the student's name normalized: upper case, single spaces.
 * `pin` is the client-side SHA-256 of 'itict|' + id + '|' + PIN; the 4-digit PIN never leaves the device.
 */

var SHEET_ID = '1n6qku2kUCGF51gi8BVrMqK-Gz8EajW1ubG0JxvSKiDU';
var SHEET = { scores: 'Scores', data: 'Data', auth: 'Auth', reset: 'Reset', log: 'Log' };
var MAX_FAILS = 3;
var LOCK_MS = 24 * 60 * 60 * 1000;
var LOG_KEEP = 4000;
var ACTIVITY_COUNT = 9;
var EXAMS = [{ id: 'examPrelim', label: 'Prelim' }, { id: 'exam1', label: 'Midterm' }];
var CHUNK = 45000;          // chars per cell (cell limit is 50,000)
var MAX_BODY = 600000;      // reject anything larger
var ID_RE = /^[\p{L}0-9.,'\- ]{3,80}$/u;

function doGet() {
  return json_({ ok: true, service: 'itict-records', version: 1 });
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
  var id = String(req.id || '').replace(/\s+/g, ' ').trim().toUpperCase();
  var pin = String(req.pin || '');
  if (!ID_RE.test(id) || !/^[0-9a-f]{64}$/.test(pin)) return json_({ ok: false, error: 'bad' });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(28000); } catch (err) { return json_({ ok: false, error: 'busy' }); }   // requests queue here
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    ensureSheets_(ss);
    applyResets_(ss);
    var auth = checkPin_(ss, id, pin, req.action === 'save' && req.create === true);
    if (auth === 'nouser') { log_(ss, id, req.action, 'nouser'); return json_({ ok: false, error: 'nouser' }); }
    if (auth.locked) { log_(ss, id, req.action, 'locked'); return json_({ ok: false, error: 'locked', until: auth.until }); }
    if (auth.bad) { log_(ss, id, req.action, 'pin (' + auth.left + ' left)'); return json_({ ok: false, error: 'pin', left: auth.left }); }
    auth = auth.state;

    var stored = readDoc_(ss, id);
    if (req.action === 'restore') {
      log_(ss, id, 'restore', stored ? 'ok' : 'empty');
      return json_({ ok: true, data: stored || {}, isNew: auth === 'new' });
    }
    if (req.action !== 'save') return json_({ ok: false, error: 'bad' });

    var incoming = (req.data && typeof req.data === 'object') ? req.data : {};
    if (req.name && !incoming.name) incoming.name = String(req.name).slice(0, 80);
    var merged = merge_(stored || {}, incoming);
    writeDoc_(ss, id, merged);
    writeScores_(ss, id, merged);
    log_(ss, id, 'save', auth === 'new' ? 'registered' : 'ok');
    return json_({ ok: true, data: merged, isNew: auth === 'new' });
  } catch (err) {
    return json_({ ok: false, error: 'server', detail: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- merge rules ----------------
   activities : higher percentage wins; ties keep the stored (first) record.
   resets     : only the Reset tab creates them (applyResets_). Phones cannot clear a
                score; records finished before a reset are refused.
   exams      : per record, the newer `updated` wins; nothing is overwritten with empty.
   unlock     : the newest event wins — an unlock (`at`) or a relock (`unlockClearedAt`). */
function merge_(s, inc) {
  var out = JSON.parse(JSON.stringify(s));
  if (inc.name) out.name = inc.name;
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
  return out;
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
/* Auth row: Key | PIN hash | Registered | Wrong tries | Locked until */
function checkPin_(ss, id, pin, mayRegister) {
  var sh = ss.getSheetByName(SHEET.auth);
  var row = findRow_(sh, id);
  var hash = serverHash_(pin);
  if (!row) {
    if (!mayRegister) return 'nouser';
    sh.appendRow([id, hash, new Date(), 0, '']);
    return { state: 'new' };
  }
  var v = sh.getRange(row, 1, 1, 5).getValues()[0];
  var until = v[4] instanceof Date ? v[4].getTime() : (v[4] ? new Date(v[4]).getTime() : 0);
  if (until && until > Date.now()) return { locked: true, until: new Date(until).toISOString() };
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
function serverHash_(clientHash) {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('SALT');
  if (!salt) { salt = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('SALT', salt); }
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + clientHash, Utilities.Charset.UTF_8);
  return d.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ---------------- storage ---------------- */
function ensureSheets_(ss) {
  var heads = {};
  heads[SHEET.scores] = ['Key', 'Name'];
  for (var n = 1; n <= ACTIVITY_COUNT; n++) heads[SHEET.scores].push('A' + n + ' %');
  EXAMS.forEach(function (x) { heads[SHEET.scores].push(x.label); });
  heads[SHEET.scores].push('Last sync', 'Flags (review)');
  heads[SHEET.data] = ['Key', 'Name', 'Updated', 'JSON (split across columns)'];
  heads[SHEET.auth] = ['Key (name)', 'PIN hash (delete row to reset PIN)', 'Registered', 'Wrong tries', 'Locked until (clear to unlock)'];
  heads[SHEET.reset] = ['Name (as in Scores)', 'Activity: A1–A9 or ALL', 'Applied (filled by script)'];
  heads[SHEET.log] = ['Time', 'Key', 'Action', 'Result'];
  Object.keys(heads).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.setFrozenRows(1); }
    var h = sh.getRange(1, 1, 1, heads[name].length);
    var cur = h.getValues()[0].join('|');
    if (cur !== heads[name].join('|')) h.setValues([heads[name]]).setFontWeight('bold');
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
}
function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).toUpperCase() === id) return i + 2;
  return 0;
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
  var values = [id, doc.name || '', new Date()].concat(parts);
  while (values.length - 3 < oldWidth) values.push('');
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values]);
}
function writeScores_(ss, id, doc) {
  var sh = ss.getSheetByName(SHEET.scores);
  var row = findRow_(sh, id) || sh.getLastRow() + 1;
  var skipped = (doc.unlock && doc.unlock.skipped) || [];
  var vals = [id, doc.name || ''];
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
function log_(ss, id, action, result) {
  try {
    var sh = ss.getSheetByName(SHEET.log);
    sh.appendRow([new Date(), id, action, result]);
    if (sh.getLastRow() > LOG_KEEP + 500) sh.deleteRows(2, 500);   // keep the newest ~4000 lines
  } catch (e) {}
}

/* Reset tab: each row with a name and an activity (A1–A9 or ALL) and an empty
   "Applied" cell is applied once. The score is removed from Data/Scores and a
   reset time is stored, so phones delete their copy and older copies are refused. */
function applyResets_(ss) {
  var sh = ss.getSheetByName(SHEET.reset);
  var last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, 3).getValues();
  rows.forEach(function (r, i) {
    if (!r[0] || !r[1] || r[2]) return;
    var id = String(r[0]).replace(/\s+/g, ' ').trim().toUpperCase();
    var what = String(r[1]).replace(/\s+/g, '').toUpperCase();
    var list = what === 'ALL' ? Array.apply(null, Array(ACTIVITY_COUNT)).map(function (_, j) { return j + 1; })
      : what.split(',').map(function (x) { return Number(x.replace(/^A(CTIVITY)?/, '')); })
          .filter(function (n) { return n >= 1 && n <= ACTIVITY_COUNT; });
    var note;
    var doc = readDoc_(ss, id);
    if (!doc) note = 'Not found: check the name';
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
  serverHash_('init');
}

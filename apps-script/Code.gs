/**
 * Living in the IT Era — student record backup (Google Apps Script web app)
 *
 * Standalone Apps Script project that writes to the "IT Era — Student Records" Google Sheet (SHEET_ID).
 * Deploy: Deploy → New deployment → Web app · Execute as: Me · Who has access: Anyone.
 *
 * Tabs (created automatically on first request):
 *   Scores — one readable row per student (instructor view)
 *   Data   — full sync payload per student, JSON split across cells (used for restore)
 *   Auth   — student key (normalized name) + salted PIN hash. Delete a row here to reset that PIN.
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
var SHEET = { scores: 'Scores', data: 'Data', auth: 'Auth', log: 'Log' };
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
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    ensureSheets_(ss);
    var auth = checkPin_(ss, id, pin, req.action === 'save' && req.create === true);
    if (auth === 'nouser') { log_(ss, id, req.action, 'nouser'); return json_({ ok: false, error: 'nouser' }); }
    if (auth !== 'ok' && auth !== 'new') { log_(ss, id, req.action, 'pin'); return json_({ ok: false, error: 'pin' }); }

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
   resets     : an instructor Reset or a Redo is an event with a time. A newer reset
                drops the stored record; records finished before the reset are refused.
   exams      : per record, the newer `updated` wins; nothing is overwritten with empty.
   unlock     : the newest event wins — an unlock (`at`) or a relock (`unlockClearedAt`).
   redoFlags  : OR, except a newer reset hands the redo back (takes the device's value). */
function merge_(s, inc) {
  var out = JSON.parse(JSON.stringify(s));
  if (inc.name) out.name = inc.name;
  if (inc.createdDate && (!out.createdDate || inc.createdDate < out.createdDate)) out.createdDate = inc.createdDate;

  out.resets = out.resets || {};
  var freshReset = {};
  var ir = inc.resets || {};
  Object.keys(ir).forEach(function (k) {
    if (!/^activity\d+$/.test(k) || !ir[k]) return;
    if (!out.resets[k] || ir[k] > out.resets[k]) {
      out.resets[k] = ir[k];
      freshReset[k] = true;
      if (out[k] && !(recTime_(out[k]) > ir[k])) delete out[k];
    }
  });

  for (var n = 1; n <= ACTIVITY_COUNT; n++) {
    var k = 'activity' + n, r = inc[k];
    if (!r || typeof r !== 'object') continue;
    var t = recTime_(r);
    if (out.resets[k] && t && t < out.resets[k]) continue;
    if (!out[k] || pct_(r) > pct_(out[k])) out[k] = r;
  }

  out.redoFlags = out.redoFlags || {};
  var irf = inc.redoFlags || {};
  Object.keys(irf).forEach(function (k) {
    out.redoFlags[k] = freshReset[k] ? !!irf[k] : (!!out.redoFlags[k] || !!irf[k]);
  });
  Object.keys(freshReset).forEach(function (k) { if (!(k in irf)) out.redoFlags[k] = false; });
  out.redoUsed = Object.keys(out.redoFlags).some(function (k) { return out.redoFlags[k]; });

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
function checkPin_(ss, id, pin, mayRegister) {
  var sh = ss.getSheetByName(SHEET.auth);
  var row = findRow_(sh, id);
  var hash = serverHash_(pin);
  if (!row) {
    if (!mayRegister) return 'nouser';
    sh.appendRow([id, hash, new Date()]);
    return 'new';
  }
  return sh.getRange(row, 2).getValue() === hash ? 'ok' : 'bad';
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
  heads[SHEET.scores].push('Last sync');
  heads[SHEET.data] = ['Key', 'Name', 'Updated', 'JSON (split across columns)'];
  heads[SHEET.auth] = ['Key (name)', 'PIN hash (delete row to reset PIN)', 'Registered'];
  heads[SHEET.log] = ['Time', 'Key', 'Action', 'Result'];
  Object.keys(heads).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, heads[name].length).setValues([heads[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);
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
  vals.push(new Date());
  sh.getRange(row, 1, 1, 2).setNumberFormat('@');
  sh.getRange(row, 1, 1, vals.length).setValues([vals]);
}
function log_(ss, id, action, result) {
  try { ss.getSheetByName(SHEET.log).appendRow([new Date(), id, action, result]); } catch (e) {}
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor (▶ setup) to create the tabs and approve permissions. */
function setup() {
  ensureSheets_(SpreadsheetApp.openById(SHEET_ID));
  serverHash_('init');
}

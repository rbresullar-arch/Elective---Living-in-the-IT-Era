"""One-time Apple restyle of index.html (markup + JS view code).
Re-running only refreshes the <style> block from tools/index_apple.css."""
import re, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
p = ROOT / 'index.html'
s = p.read_text(encoding='utf-8')
css = (ROOT / 'tools' / 'index_apple.css').read_text(encoding='utf-8')

def rep(old, new, count=1):
    global s
    if old not in s:
        sys.exit('NOT FOUND: ' + old[:80])
    s = s.replace(old, new, count)

# style block
m = re.search(r'<style>(.*?)</style>', s, re.S)
s = s[:m.start(1)] + '\n' + css + s[m.end(1):]

if 'id="homeProg"' in s:
    p.write_text(s, encoding='utf-8'); print('css refreshed'); sys.exit()

# fonts
s = re.sub(r'<link[^>]+fonts\.googleapis\.com/css2[^>]*>',
           '<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&display=swap" rel="stylesheet">', s, count=1)

SHAPES = '<canvas class="fx" aria-hidden="true"></canvas><span class="shape s1"></span><span class="shape s2"></span><span class="shape s3"></span><span class="shape s4"></span>'
RING = ('<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="rtrack" cx="18" cy="18" r="14" fill="none" stroke-width="6"/>'
        '<circle class="rfill" cx="18" cy="18" r="14" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 88"/></svg>')
CHEV = '<svg class="chev" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg>'
BACK = '<svg viewBox="0 0 11 18" aria-hidden="true"><path d="M9.5 1.5 2 9l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

# login hero
rep('''    <div class="box title">Living in the IT Era</div>
    <div class="auth-tabs"''', f'''    <div class="stage">{SHAPES}
      <div class="hero"><span class="mark">IT</span><h1>Living in the IT Era.</h1><p>GEEL 1 · Activities, examinations and reads</p></div>
    </div>
    <div class="auth-tabs"''')

# home hero + menu
rep('''    <div class="box title">Living in the IT Era</div>
    <p class="greeting" id="greeting"></p>''', f'''    <div class="stage">{SHAPES}
      <div class="hero"><h1>Living in the IT Era.</h1><p class="greeting" id="greeting"></p>
        <span class="chipbar" id="homeProg">{RING}<span class="ptext">Activities</span></span></div>
    </div>''')
rep('''    <button type="button" class="box menu-btn yellow" data-go="activities">Activities</button>
    <button type="button" class="box menu-btn coral" data-go="exam">Examination</button>
    <button type="button" class="box menu-btn cream" data-go="reads">Reads</button>''', f'''    <div class="group menu">
      <button type="button" class="cell" data-go="activities"><span class="tile" style="--c:#0A84FF"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg></span><span class="ctext"><b>Activities</b><small id="menuActSub">Games and exercises</small></span>{CHEV}</button>
      <button type="button" class="cell" data-go="exam"><span class="tile" style="--c:#FF375F"><svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13l2 2 4-4"/></svg></span><span class="ctext"><b>Examination</b><small>Prelim, Midterm and more</small></span>{CHEV}</button>
      <button type="button" class="cell" data-go="reads"><span class="tile" style="--c:#FF9F0A"><svg viewBox="0 0 24 24"><path d="M3 5.5C5.5 4 8.5 4 12 6c3.5-2 6.5-2 9-.5V19c-2.5-1.5-5.5-1.5-9 .5-3.5-2-6.5-2-9-.5z"/><path d="M12 6v13.5"/></svg></span><span class="ctext"><b>Reads</b><small>Long reads per exam period</small></span>{CHEV}</button>
    </div>''')

# sub-screen headers
for name in ('Activities', 'Examination', 'Reads'):
    rep(f'<button type="button" class="box title" data-go="home"><span class="chev" aria-hidden="true">‹</span>{name}</button>',
        f'<div class="navbar"><button type="button" class="back" data-go="home">{BACK}Home</button></div>\n    <h1 class="large">{name}</h1>')

rep('''    <div class="caption">Score</div>
    <div id="activityList"></div>''', f'''    <div class="sumbar" id="actSummary">{RING}<div><b id="actSumNum">0 of 0</b><small>activities completed</small></div></div>
    <div class="group" id="activityList"></div>''')
rep('''    <div class="caption-row"><div class="caption">Status</div><div class="caption">QR</div><div class="caption">Download</div></div>
    <div id="examList"></div>''', '''    <div class="group" id="examList"></div>''')
rep('<div id="readList"></div>', '<div class="group" id="readList"></div>')
rep('<button type="button" class="box qr-open" id="qrOpenBtn">My Score QR</button>', '<button type="button" class="qr-open" id="qrOpenBtn">QR</button>')

# crest -> simple mark
s = re.sub(r'(<button type="button" class="crest" id="crestBtn" aria-label="Living in the IT Era">)\s*<svg.*?</svg>',
           r'''\1
      <svg viewBox="0 0 44 44" aria-hidden="true"><defs><linearGradient id="crg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5E5CE6"/><stop offset=".55" stop-color="#BF5AF2"/><stop offset="1" stop-color="#FF375F"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="11" fill="url(#crg)"/><text x="22" y="28" text-anchor="middle" font-family="-apple-system,Inter,Helvetica,Arial,sans-serif" font-weight="700" font-size="15" fill="#fff">IT</text></svg>''', s, count=1, flags=re.S)

# ===== JS view code =====
rep("const ACTIVITIES = [", '''/* Tile colour and display name per activity (presentation only). */
const TILE_COLORS = ['#0A84FF', '#FF9F0A', '#5E5CE6', '#30B0C7', '#34C759', '#FF375F', '#BF5AF2', '#FF453A', '#FFCC00'];
const ACT_NAMES = ['IT & ICT in Our Lives', 'Abacus Addition', 'The Pascaline', 'Binary Decoder', 'Packet Route', 'Packet Auto-Route', 'Qrispy Queen', 'Phish or Legit', 'Netiquette Desk'];
const EXAM_COLORS = ['#FF9F0A', '#FF375F', '#BF5AF2', '#5E5CE6'];
const READ_COLORS = ['#FF9F0A', '#FF375F', '#BF5AF2', '#5E5CE6'];
const BOOK_ICON = '<svg viewBox="0 0 24 24"><path d="M3 5.5C5.5 4 8.5 4 12 6c3.5-2 6.5-2 9-.5V19c-2.5-1.5-5.5-1.5-9 .5-3.5-2-6.5-2-9-.5z"/><path d="M12 6v13.5"/></svg>';
const CHEV_SVG = '<svg class="chev" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg>';
function makeTile(color, content, isSvg) {
  const t = el('span', 'tile' + (color === '#FFCC00' ? ' dark' : ''));
  t.style.setProperty('--c', color);
  if (isSvg) t.innerHTML = content; else t.textContent = content;
  return t;
}

const ACTIVITIES = [''')

old_build = s[s.index('function buildRow(item, scoreText) {'):s.index("const DL_ICON")]
rep(old_build, '''function buildRow(item, scoreText, tile, title) {
  const wrap = el('div', 'row');
  const btn = el('a', 'box pill');
  btn.id = item.id + 'Btn';
  btn.href = item.href;
  const txt = el('span', 'pill-text');
  const label = el('span', 'pill-label', title || item.label);
  label.id = item.id + 'Label';
  const note = el('span', 'note', 'Checking...');
  note.id = item.id + 'Note';
  if (title) txt.append(el('span', 'pill-sub', item.label));
  txt.append(label, note);
  const score = el('span', 'score', scoreText || '—');
  score.id = item.id + 'Score';
  const end = el('span', 'pill-end', '›');
  end.id = item.id + 'End';
  btn.append(tile || makeTile('#8E8E93', ''), txt, score, end);
  wrap.append(btn);
  return wrap;
}

''')
rep('''function buildExamRow(e) {
  const wrap = buildRow(e);''', '''function buildExamRow(e, i) {
  const wrap = buildRow(e, null, makeTile(EXAM_COLORS[i % EXAM_COLORS.length], e.label[0]), e.label);''')
rep("wrap.querySelector('.row').append(dl);", "wrap.append(dl);")

old_redo = s[s.index('function buildRedoRow(a) {'):s.index('function buildLists() {')]
rep(old_redo, '''function buildRedoRow(a) {
  const wrap = el('div', 'row');
  wrap.id = a.id + 'RedoRow';
  wrap.style.display = 'none';
  const btn = el('button', 'box pill');
  btn.type = 'button';
  btn.id = a.id + 'RedoBtn';
  const txt = el('span', 'pill-text');
  const note = el('span', 'note');
  note.id = a.id + 'RedoNote';
  txt.append(el('span', 'pill-label', a.redo.label), note);
  const end = el('span', 'pill-end', '1');
  end.id = a.id + 'RedoEnd';
  btn.append(makeTile('#8E8E93', '↺'), txt, end);
  btn.addEventListener('click', () => doRedo(a));
  wrap.append(btn);
  return wrap;
}

''')
rep('''    actList.append(buildRow(a));''', '''    actList.append(buildRow(a, null, makeTile(TILE_COLORS[(a.n - 1) % TILE_COLORS.length], String(a.n)), ACT_NAMES[a.n - 1] || a.label));''')
rep("EXAMS.forEach(e => examList.append(buildExamRow(e)));", "EXAMS.forEach((e, i) => examList.append(buildExamRow(e, i)));")
rep('''  READS.forEach(r => {
    const a = el('a', 'box pill');
    a.href = r.href;
    a.append(el('span', 'pill-label', r.label));
    readList.append(a);
  });''', '''  READS.forEach((r, i) => {
    const row = el('div', 'row');
    const a = el('a', 'box pill');
    a.href = r.href;
    const txt = el('span', 'pill-text');
    txt.append(el('span', 'pill-label', r.label), el('span', 'note', 'Long read'));
    a.append(makeTile(READ_COLORS[i % READ_COLORS.length], BOOK_ICON, true), txt);
    a.insertAdjacentHTML('beforeend', CHEV_SVG);
    row.append(a);
    readList.append(row);
  });''')

# screens: no full-page colour change
rep('''  const bg = getComputedStyle(document.documentElement).getPropertyValue('--' + color);
  document.documentElement.style.background = bg;
  document.body.style.background = bg;
''', '')

# progress summary
rep('''    if (a.redo) refreshRedo(a, recs[i]);
  });
}''', '''    if (a.redo) refreshRedo(a, recs[i]);
  });
  updateProgress(recs);
}

/* Progress ring on Home and Activities (presentation only). */
function updateProgress(recs) {
  const done = recs.filter(Boolean).length, total = ACTIVITIES.length;
  const dash = total ? (done / total * 88).toFixed(1) + ' 88' : '0 88';
  document.querySelectorAll('#homeProg .rfill, #actSummary .rfill').forEach(c => c.setAttribute('stroke-dasharray', dash));
  const t = `${done} of ${total}`;
  const hp = document.querySelector('#homeProg .ptext'); if (hp) hp.textContent = `${t} activities done`;
  const an = document.getElementById('actSumNum'); if (an) an.textContent = t;
  const ms = document.getElementById('menuActSub'); if (ms) ms.textContent = `${t} completed`;
}''')

# shader for hero stages
FX = (ROOT / 'tools' / 'index_fx.js').read_text(encoding='utf-8')
rep('</body>', '<script id="apple-fx">\n' + FX + '\n</script>\n</body>')

p.write_text(s, encoding='utf-8')
print('index restyled')

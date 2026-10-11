#!/usr/bin/env python3
"""
GEEL 1 — Class code -> name mapper (offline, instructor only)

Reads the students' "My Score QR" (index.html) and keeps the only code -> name
record on this computer, in code_map.db (SQLite) next to this script.
Nothing here goes online.

QR payload: Base64( JSON XOR "2026" )
  { v:1, t:"act", n:<full name>, k:<class code e.g. 12030-07>, c:<schedule>, a:"1:80,2:S", at:<unix> }

Install:  pip install opencv-python
Usage:
  python code_map_scanner.py                    scan with webcam 0 (q = quit)
  python code_map_scanner.py scan --cam 1       another camera
  python code_map_scanner.py image a.png b.jpg  read saved QR images
  python code_map_scanner.py list [--sched 12030]
  python code_map_scanner.py conflicts          codes scanned with a different name / names on two codes
  python code_map_scanner.py fix 12030-07 "Juan Dela Cruz"   set or correct a name by hand
  python code_map_scanner.py remove 12030-07
  python code_map_scanner.py export map.csv
  python code_map_scanner.py join Scores.csv gradebook.csv
        Scores.csv = the Sheet's Scores tab (File > Download > CSV). Adds a Name column after Code.
"""
import argparse
import base64
import csv
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime

XOR_KEY = b"2026"
CODE_RE = re.compile(r"^\d{5}-\d{2,3}$")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "code_map.db")


# ---------------- payload ----------------
def decode_payload(text):
    """Return the payload dict, or None when the text is not a GEEL 1 activity QR."""
    try:
        raw = base64.b64decode(text.strip(), validate=False)
        plain = bytes(b ^ XOR_KEY[i % len(XOR_KEY)] for i, b in enumerate(raw))
        obj = json.loads(plain.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(obj, dict) or obj.get("t") != "act":
        return None
    return obj


def norm_name(n):
    return re.sub(r"\s+", " ", str(n or "")).strip()


def name_key(n):
    return norm_name(n).upper()


# ---------------- database ----------------
def db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS students(
        code TEXT PRIMARY KEY, name TEXT NOT NULL, sched TEXT,
        first_seen TEXT, last_seen TEXT, scans INTEGER DEFAULT 0)""")
    con.execute("""CREATE TABLE IF NOT EXISTS conflicts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, code TEXT,
        stored_name TEXT, scanned_name TEXT, kind TEXT)""")
    return con


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def record(con, payload):
    """Store one scan. Returns (status, message). status: new | same | conflict | dupname | bad."""
    code = str(payload.get("k") or "").strip()
    name = norm_name(payload.get("n"))
    sched = str(payload.get("c") or "").strip()
    if not CODE_RE.match(code):
        return "bad", "QR has no class code (old QR or no account yet)"
    if len(name) < 3:
        return "bad", f"{code}: no name in QR"
    t = now()
    row = con.execute("SELECT name FROM students WHERE code=?", (code,)).fetchone()
    if row:
        if name_key(row[0]) != name_key(name):
            con.execute("INSERT INTO conflicts(at,code,stored_name,scanned_name,kind) VALUES(?,?,?,?,?)",
                        (t, code, row[0], name, "code-name"))
            con.commit()
            return "conflict", f"CONFLICT {code}: stored '{row[0]}', scanned '{name}' (kept stored; use fix)"
        con.execute("UPDATE students SET last_seen=?, scans=scans+1, sched=? WHERE code=?", (t, sched or code[:5], code))
        con.commit()
        return "same", f"{code} {row[0]} (already mapped)"
    other = con.execute("SELECT code FROM students WHERE upper(name)=? AND code<>?", (name_key(name), code)).fetchone()
    con.execute("INSERT INTO students(code,name,sched,first_seen,last_seen,scans) VALUES(?,?,?,?,?,1)",
                (code, name, sched or code[:5], t, t))
    if other:
        con.execute("INSERT INTO conflicts(at,code,stored_name,scanned_name,kind) VALUES(?,?,?,?,?)",
                    (t, code, f"also on {other[0]}", name, "name-two-codes"))
        con.commit()
        return "dupname", f"SAVED {code} {name} — WARNING: same name already on {other[0]} (duplicate account?)"
    con.commit()
    return "new", f"SAVED {code} {name}"


# ---------------- scanning ----------------
def decode_frame(cv2, detector, frame):
    texts = []
    try:
        ok, decoded, _, _ = detector.detectAndDecodeMulti(frame)
        if ok:
            texts = [d for d in decoded if d]
    except Exception:
        pass
    if not texts:
        try:
            d, _, _ = detector.detectAndDecode(frame)
            if d:
                texts = [d]
        except Exception:
            pass
    return texts


def cmd_scan(args):
    import cv2
    con = db()
    cap = cv2.VideoCapture(args.cam)
    if not cap.isOpened():
        sys.exit(f"Camera {args.cam} not available.")
    det = cv2.QRCodeDetector()
    seen = {}
    banner, color, until = "Show a Score QR", (255, 255, 255), 0
    colors = {"new": (0, 200, 0), "same": (255, 200, 0), "conflict": (0, 0, 255), "dupname": (0, 165, 255), "bad": (0, 0, 255)}
    print(f"Scanning (camera {args.cam}) -> {DB_PATH}   q = quit")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        for text in decode_frame(cv2, det, frame):
            if time.time() - seen.get(text, 0) < 4:
                continue
            seen[text] = time.time()
            p = decode_payload(text)
            if not p:
                status, msg = "bad", "Not a GEEL 1 Score QR"
            else:
                status, msg = record(con, p)
            print(msg + ("\a" if status in ("conflict", "dupname") else ""))
            banner, color, until = msg[:70], colors[status], time.time() + 3
        if time.time() > until:
            banner, color = "Show a Score QR", (255, 255, 255)
        cv2.rectangle(frame, (0, 0), (frame.shape[1], 40), (0, 0, 0), -1)
        cv2.putText(frame, banner, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        cv2.imshow("GEEL 1 code map", frame)
        if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
            break
    cap.release()
    cv2.destroyAllWindows()


def cmd_image(args):
    import cv2
    con = db()
    det = cv2.QRCodeDetector()
    for path in args.files:
        img = cv2.imread(path)
        if img is None:
            print(f"{path}: cannot open")
            continue
        texts = decode_frame(cv2, det, img)
        if not texts:  # small or soft images: try enlarged
            texts = decode_frame(cv2, det, cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
        if not texts:
            print(f"{path}: no QR found")
            continue
        for t in texts:
            p = decode_payload(t)
            print(f"{path}: " + (record(con, p)[1] if p else "not a GEEL 1 Score QR"))


# ---------------- records ----------------
def cmd_list(args):
    con = db()
    q, prm = "SELECT code,name,sched,last_seen,scans FROM students", ()
    if args.sched:
        q, prm = q + " WHERE sched=?", (args.sched,)
    rows = con.execute(q + " ORDER BY code", prm).fetchall()
    for r in rows:
        print(f"{r[0]:<10} {r[1]:<40} last {r[3]}  scans {r[4]}")
    print(f"{len(rows)} student(s)")


def cmd_conflicts(args):
    rows = db().execute("SELECT at,kind,code,stored_name,scanned_name FROM conflicts ORDER BY id").fetchall()
    for r in rows:
        print(f"{r[0]}  {r[1]:<15} {r[2]:<10} stored: {r[3]}  scanned: {r[4]}")
    print(f"{len(rows)} conflict(s)")


def cmd_fix(args):
    code = args.code.strip()
    if not CODE_RE.match(code):
        sys.exit("Code must look like 12030-07.")
    con, t = db(), now()
    con.execute("""INSERT INTO students(code,name,sched,first_seen,last_seen,scans) VALUES(?,?,?,?,?,0)
                   ON CONFLICT(code) DO UPDATE SET name=excluded.name, last_seen=excluded.last_seen""",
                (code, norm_name(args.name), code[:5], t, t))
    con.commit()
    print(f"SET {code} {norm_name(args.name)}")


def cmd_remove(args):
    con = db()
    n = con.execute("DELETE FROM students WHERE code=?", (args.code.strip(),)).rowcount
    con.commit()
    print("Removed" if n else "Not found")


def cmd_export(args):
    rows = db().execute("SELECT code,name,sched,first_seen,last_seen,scans FROM students ORDER BY code").fetchall()
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Code", "Name", "Schedule", "First scan", "Last scan", "Scans"])
        w.writerows(rows)
    print(f"{len(rows)} row(s) -> {args.out}")


def cmd_join(args):
    names = dict(db().execute("SELECT code,name FROM students").fetchall())
    with open(args.scores, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows or rows[0][0].strip().lower() != "code":
        sys.exit("First column of the Scores CSV must be 'Code'.")
    out, missing = [rows[0][:1] + ["Name"] + rows[0][1:]], []
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        code = r[0].strip()
        nm = names.get(code, "")
        if not nm:
            missing.append(code)
        out.append(r[:1] + [nm] + r[1:])
    out = [out[0]] + sorted(out[1:], key=lambda r: (r[1] == "", r[0]))
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        csv.writer(f).writerows(out)
    print(f"{len(out) - 1} row(s) -> {args.out}")
    if missing:
        print(f"No name yet for {len(missing)} code(s): {', '.join(missing)}")


def main():
    ap = argparse.ArgumentParser(description="GEEL 1 offline class code -> name mapper")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("scan"); s.add_argument("--cam", type=int, default=0); s.set_defaults(fn=cmd_scan)
    s = sub.add_parser("image"); s.add_argument("files", nargs="+"); s.set_defaults(fn=cmd_image)
    s = sub.add_parser("list"); s.add_argument("--sched"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("conflicts"); s.set_defaults(fn=cmd_conflicts)
    s = sub.add_parser("fix"); s.add_argument("code"); s.add_argument("name"); s.set_defaults(fn=cmd_fix)
    s = sub.add_parser("remove"); s.add_argument("code"); s.set_defaults(fn=cmd_remove)
    s = sub.add_parser("export"); s.add_argument("out"); s.set_defaults(fn=cmd_export)
    s = sub.add_parser("join"); s.add_argument("scores"); s.add_argument("out"); s.set_defaults(fn=cmd_join)
    args = ap.parse_args()
    if not args.cmd:
        args = ap.parse_args(["scan"])
    args.fn(args)


if __name__ == "__main__":
    main()

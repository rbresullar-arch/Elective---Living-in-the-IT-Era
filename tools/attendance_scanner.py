#!/usr/bin/env python3
"""
GEEL 1 — Attendance QR scanner (offline, instructor only)

Reads the students' "Attendance QR" (index.html → ATTENDANCE QR) and logs one
attendance row per student per class schedule per day in attendance.db (SQLite)
next to this script. Nothing here goes online.

QR payload: Base64( JSON XOR "2026" )   (same encoding as the Score QR)
  { v:1, t:"att", n:<full name>, c:<schedule e.g. 12030>, k:<class code or "">, at:<unix seconds> }

Checks
  - the QR must be made TODAY (this computer's date); an old screenshot is refused
  - a QR made more than 10 minutes in the future is refused (phone clock wrong)
  - the same name + schedule is logged once per day (later scans say "already present")
  - --sched 12030 accepts only that schedule (scan one class at a time)

Install:  pip install opencv-python
Sounds:   1 high beep = logged · 2 beeps = already present / other schedule · low buzz = refused
Usage:
  python attendance_scanner.py                       webcam scan (same as "scan")
  python attendance_scanner.py scan [--cam 1] [--sched 12030]
  python attendance_scanner.py image a.png b.jpg [--sched 12030]
  python attendance_scanner.py list [--date 2026-10-19] [--sched 12030]
  python attendance_scanner.py export out.csv [--date 2026-10-19] [--sched 12030]
  python attendance_scanner.py remove 2026-10-19 12030 "Juan Dela Cruz"
"""
import argparse
import base64
import csv
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import date, datetime

XOR_KEY = b"2026"
SCHED_RE = re.compile(r"^\d{5}$")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "attendance.db")
FUTURE_SLACK_S = 10 * 60


# ---------------- payload ----------------
def decode_payload(text):
    """Return the payload dict, or None when the text is not a GEEL 1 attendance QR."""
    try:
        raw = base64.b64decode(text.strip(), validate=False)
        plain = bytes(b ^ XOR_KEY[i % len(XOR_KEY)] for i, b in enumerate(raw))
        obj = json.loads(plain.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(obj, dict) or obj.get("t") != "att":
        return None
    return obj


def norm_name(n):
    return re.sub(r"\s+", " ", str(n or "")).strip()


def name_key(n):
    return norm_name(n).upper()


# ---------------- database ----------------
def db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS attendance(
        day TEXT NOT NULL, sched TEXT NOT NULL, name_key TEXT NOT NULL,
        name TEXT NOT NULL, code TEXT, made_at TEXT, scanned_at TEXT,
        PRIMARY KEY(day, sched, name_key))""")
    return con


def record(con, payload, only_sched=None):
    """Store one scan. Returns (status, message). status: new | same | other | bad."""
    name = norm_name(payload.get("n"))
    sched = str(payload.get("c") or "").strip()
    code = str(payload.get("k") or "").strip()
    try:
        made = datetime.fromtimestamp(int(payload.get("at")))
    except Exception:
        return "bad", "QR has no time"
    if len(name) < 3:
        return "bad", "QR has no name"
    if not SCHED_RE.match(sched):
        return "bad", f"{name}: no class schedule in QR"
    now = datetime.now()
    if made.date() != now.date():
        return "bad", f"REFUSED {name}: QR made {made:%b %d %H:%M}, not today. Make a new one."
    if (made - now).total_seconds() > FUTURE_SLACK_S:
        return "bad", f"REFUSED {name}: QR time {made:%H:%M} is ahead of this computer (phone clock wrong)"
    if only_sched and sched != only_sched:
        return "other", f"{name} is schedule {sched}, not {only_sched} (not logged)"
    day = now.strftime("%Y-%m-%d")
    row = con.execute("SELECT scanned_at FROM attendance WHERE day=? AND sched=? AND name_key=?",
                      (day, sched, name_key(name))).fetchone()
    if row:
        return "same", f"{name} · {sched} already present ({row[0][11:16]})"
    con.execute("INSERT INTO attendance(day,sched,name_key,name,code,made_at,scanned_at) VALUES(?,?,?,?,?,?,?)",
                (day, sched, name_key(name), name, code, made.strftime("%Y-%m-%d %H:%M:%S"),
                 now.strftime("%Y-%m-%d %H:%M:%S")))
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM attendance WHERE day=? AND sched=?", (day, sched)).fetchone()[0]
    return "new", f"PRESENT {name} · {sched}  ({n} today)"


# ---------------- sound ----------------
SOUND_FOR = {"new": "ok", "same": "warn", "other": "warn", "bad": "bad"}


def play(kind):
    """Confirmation sound without blocking the camera. kind: ok | warn | bad."""
    def run():
        try:
            import winsound
            if kind == "ok":
                winsound.Beep(1760, 120)
            elif kind == "warn":
                winsound.Beep(880, 140); winsound.Beep(880, 140)
            else:
                winsound.Beep(330, 380)
            return
        except Exception:
            pass
        if sys.platform == "darwin":
            snd = {"ok": "Glass", "warn": "Sosumi", "bad": "Basso"}[kind]
            try:
                subprocess.Popen(["afplay", f"/System/Library/Sounds/{snd}.aiff"])
                return
            except Exception:
                pass
        sys.stdout.write("\a" * {"ok": 1, "warn": 2, "bad": 3}[kind])
        sys.stdout.flush()
    threading.Thread(target=run, daemon=True).start()


# ---------------- scanning ----------------
COOLDOWN_S = 2.0   # same QR text is ignored for this long
CV_WIN = "GEEL 1 attendance"


def open_camera(cv2, idx):
    cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(idx)
    if not cap.isOpened():
        cap.release()
        return None
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    return cap


def decode_live(det, frame):
    try:
        text, pts, _ = det.detectAndDecode(frame)
    except Exception:
        return "", None
    return text or "", pts


def decode_image(cv2, det, img):
    """Thorough path for saved images: plain, enlarged, blurred, contrast-boosted, thresholded."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    soft = cv2.GaussianBlur(gray, (0, 0), 1.2)
    for v in (img,
              cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC),
              soft,
              cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(gray),
              cv2.adaptiveThreshold(soft, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 7)):
        try:
            ok, decoded, _, _ = det.detectAndDecodeMulti(v)
            if ok and any(decoded):
                return [d for d in decoded if d]
        except Exception:
            pass
        t, _ = decode_live(det, v)
        if t:
            return [t]
    return []


def handle(con, text, only_sched):
    p = decode_payload(text)
    return record(con, p, only_sched) if p else ("bad", "Not a GEEL 1 Attendance QR")


def cmd_scan(args):
    import cv2
    con = db()
    cap = open_camera(cv2, args.cam)
    if cap is None:
        sys.exit(f"Camera {args.cam} not available.")
    det = cv2.QRCodeDetector()
    idle = "Show an Attendance QR" + (f"  · schedule {args.sched}" if args.sched else "") + "   (q = quit)"
    last_t, last_text = 0.0, None
    banner, color, until = idle, (255, 255, 255), 0
    colors = {"new": (0, 200, 0), "same": (0, 200, 255), "other": (0, 165, 255), "bad": (0, 0, 255)}
    print(f"Scanning (camera {args.cam}) -> {DB_PATH}   q = quit")
    cv2.namedWindow(CV_WIN, cv2.WINDOW_NORMAL)
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = time.time()
        text, pts = decode_live(det, frame)
        if text and t - last_t >= COOLDOWN_S and text != last_text:
            last_t, last_text = t, text
            status, msg = handle(con, text, args.sched)
            print(msg)
            play(SOUND_FOR[status])
            banner, color, until = msg[:70], colors[status], t + 3
        if not text and t - last_t >= COOLDOWN_S:
            last_text = None
        if t > until:
            banner, color = idle, (255, 255, 255)
        if pts is not None and len(pts):
            cv2.polylines(frame, [pts.astype(int).reshape(-1, 1, 2)], True, (0, 165, 255), 3)
        cv2.rectangle(frame, (0, 0), (frame.shape[1], 44), (30, 30, 30), -1)
        cv2.putText(frame, banner, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2, cv2.LINE_AA)
        cv2.imshow(CV_WIN, frame)
        if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q"), 27):
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
        texts = decode_image(cv2, det, img)
        if not texts:
            print(f"{path}: no QR found")
            play("bad")
            continue
        for t in texts:
            st, msg = handle(con, t, args.sched)
            print(f"{path}: {msg}")
            play(SOUND_FOR[st])


def rows_for(con, day, sched):
    q, a = "SELECT day, sched, name, code, scanned_at FROM attendance WHERE 1=1", []
    if day:
        q += " AND day=?"; a.append(day)
    if sched:
        q += " AND sched=?"; a.append(sched)
    return con.execute(q + " ORDER BY day, sched, name_key", a).fetchall()


def cmd_list(args):
    rows = rows_for(db(), args.date, args.sched)
    for r in rows:
        print(f"{r[0]}  {r[1]}  {r[4][11:16]}  {r[2]}" + (f"  ({r[3]})" if r[3] else ""))
    print(f"{len(rows)} present")


def cmd_export(args):
    rows = rows_for(db(), args.date, args.sched)
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Schedule", "Name", "Class code", "Scanned at"])
        w.writerows(rows)
    print(f"{len(rows)} rows -> {args.out}")


def cmd_remove(args):
    con = db()
    n = con.execute("DELETE FROM attendance WHERE day=? AND sched=? AND name_key=?",
                    (args.day, args.sched, name_key(args.name))).rowcount
    con.commit()
    print("Removed." if n else "No such row.")


def main():
    ap = argparse.ArgumentParser(description="GEEL 1 offline attendance scanner")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("scan"); s.add_argument("--cam", type=int, default=0); s.add_argument("--sched"); s.set_defaults(fn=cmd_scan)
    s = sub.add_parser("image"); s.add_argument("files", nargs="+"); s.add_argument("--sched"); s.set_defaults(fn=cmd_image)
    s = sub.add_parser("list"); s.add_argument("--date", default=date.today().isoformat()); s.add_argument("--sched"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("export"); s.add_argument("out"); s.add_argument("--date"); s.add_argument("--sched"); s.set_defaults(fn=cmd_export)
    s = sub.add_parser("remove"); s.add_argument("day"); s.add_argument("sched"); s.add_argument("name"); s.set_defaults(fn=cmd_remove)
    args = ap.parse_args()
    if not args.cmd:
        args = ap.parse_args(["scan"])
    if getattr(args, "sched", None) and not SCHED_RE.match(args.sched):
        sys.exit("--sched must be 5 digits, e.g. 12030")
    args.fn(args)


if __name__ == "__main__":
    main()

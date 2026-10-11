#!/usr/bin/env python3
"""
GEEL 1 — Class code -> name mapper (offline, instructor only)

Reads the students' "My Score QR" (index.html) and keeps the only code -> name
record on this computer, in code_map.db (SQLite) next to this script.
Nothing here goes online.

QR payload: Base64( JSON XOR "2026" )
  { v:1, t:"act", n:<full name>, k:<class code e.g. 12030-07>, c:<schedule>, a:"1:80,2:S", at:<unix> }

Install:  pip install opencv-python pillow      (tkinter ships with Python on Windows/macOS)
Usage:
  python code_map_scanner.py                    open the window (GUI):
        Scores    paste rows copied from the Sheet's Scores tab -> names are added automatically;
                  Copy result / Save CSV; red rows = code without a name (double-click to set it)
        Scan QR   webcam or saved QR images -> code -> name map
        Students  edit, add, remove, export the map
        Conflicts same code with two names / same name on two codes
Command line (no window):
  python code_map_scanner.py scan [--cam 1]     webcam scan in an OpenCV window (q = quit)
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


# ---------------- pasted Scores -> names ----------------
SCORES_HEAD = ["Code", "Schedule"] + [f"A{n} %" for n in range(1, 11)] + ["Prelim", "Midterm", "Last sync", "Flags (review)"]


def parse_scores(text, names):
    """Rows copied from the Sheet (tab-separated, header row optional).
    Returns (header, rows, missing_codes) with a Name column inserted after Code,
    sorted by schedule, then name; codes without a name come last in each schedule.
    Raises ValueError when no class code column is found."""
    lines = [ln for ln in text.replace("\r", "").split("\n") if ln.strip()]
    rows = [[c.strip() for c in ln.split("\t")] for ln in lines]
    if not rows:
        raise ValueError("Nothing pasted.")
    first = [c.lower() for c in rows[0]]
    if "code" in first:
        head, body = rows[0], rows[1:]
        code_col = first.index("code")
    else:
        body = rows
        counts = {}
        for r in body:
            for i, c in enumerate(r):
                if CODE_RE.match(c):
                    counts[i] = counts.get(i, 0) + 1
        if not counts:
            raise ValueError("No class code column found. Copy the rows including the Code column.")
        code_col = max(counts, key=counts.get)
        width = max(len(r) for r in body)
        if code_col == 0 and width <= len(SCORES_HEAD):
            head = SCORES_HEAD[:width]
        else:
            head = [f"Col {i + 1}" for i in range(width)]
            head[code_col] = "Code"
    width = max([len(head)] + [len(r) for r in body])
    head = head + [f"Col {i + 1}" for i in range(len(head), width)]
    out, missing = [], []
    for r in body:
        r = r + [""] * (width - len(r))
        code = r[code_col]
        if not CODE_RE.match(code):
            continue
        name = names.get(code, "")
        if not name:
            missing.append(code)
        out.append([code, name] + r[:code_col] + r[code_col + 1:])
    out.sort(key=lambda x: (x[0][:5], x[1] == "", x[1].upper(), x[0]))
    out_head = ["Code", "Name"] + head[:code_col] + head[code_col + 1:]
    return out_head, out, missing


def rows_to_tsv(head, rows):
    return "\n".join("\t".join(r) for r in [head] + rows)


# ---------------- GUI ----------------
def run_gui():
    import tkinter as tk
    from tkinter import ttk, messagebox, simpledialog, filedialog

    try:
        from PIL import Image, ImageTk
    except Exception:
        Image = ImageTk = None

    con = db()

    def names_map():
        return dict(con.execute("SELECT code,name FROM students").fetchall())

    root = tk.Tk()
    root.title("GEEL 1 — Code Map & Scores")
    root.geometry("1100x700")
    root.minsize(860, 560)
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure("Treeview", rowheight=24)
    style.configure("Big.TButton", padding=(12, 6))

    status = tk.StringVar(value=f"Database: {DB_PATH}")
    nb = ttk.Notebook(root)
    nb.pack(fill="both", expand=True, padx=8, pady=(8, 0))
    ttk.Label(root, textvariable=status, anchor="w").pack(fill="x", padx=10, pady=4)

    def make_tree(parent, cols, widths=None):
        frame = ttk.Frame(parent)
        tree = ttk.Treeview(frame, columns=cols, show="headings", selectmode="extended")
        ys = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        xs = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
        tree.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
        tree.grid(row=0, column=0, sticky="nsew")
        ys.grid(row=0, column=1, sticky="ns")
        xs.grid(row=1, column=0, sticky="ew")
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        set_columns(tree, cols, widths)
        return frame, tree

    def set_columns(tree, cols, widths=None):
        tree.configure(columns=cols)
        for i, c in enumerate(cols):
            w = (widths or {}).get(c) or (220 if c == "Name" else 90 if i < 2 else 72)
            tree.heading(c, text=c)
            tree.column(c, width=w, minwidth=50, stretch=(c == "Name"), anchor="w" if c in ("Name", "Flags (review)") else "center")

    # ===== Tab 1: Scores =====
    t1 = ttk.Frame(nb, padding=8)
    nb.add(t1, text="  Scores  ")
    ttk.Label(t1, text="Copy rows from the Sheet's Scores tab (include the Code column; the header row is optional) "
                       "and paste below with Ctrl+V. Names are added automatically.").pack(anchor="w")
    paste = tk.Text(t1, height=7, wrap="none", font=("Consolas", 10), undo=True)
    paste.pack(fill="x", pady=6)
    bar1 = ttk.Frame(t1)
    bar1.pack(fill="x")
    sched_var = tk.StringVar(value="All schedules")
    result = {"head": [], "rows": [], "missing": []}

    out_frame, out_tree = make_tree(t1, ["Code", "Name"])
    out_tree.tag_configure("missing", background="#ffe3e0")
    out_tree.tag_configure("odd", background="#f6f6f6")
    out_frame.pack(fill="both", expand=True, pady=6)
    bar1b = ttk.Frame(t1)
    bar1b.pack(fill="x")

    def visible_rows():
        s = sched_var.get()
        return [r for r in result["rows"] if s == "All schedules" or r[0][:5] == s]

    def render_scores():
        out_tree.delete(*out_tree.get_children())
        if not result["head"]:
            return
        set_columns(out_tree, result["head"])
        rows = visible_rows()
        for i, r in enumerate(rows):
            tags = ("missing",) if not r[1] else (("odd",) if i % 2 else ())
            out_tree.insert("", "end", values=r, tags=tags)
        miss = [r[0] for r in rows if not r[1]]
        status.set(f"{len(rows)} student(s) shown · {len(rows) - len(miss)} named · "
                   f"{len(miss)} without a name" + (f" (red rows; double-click to name): {', '.join(miss[:12])}"
                                                    + (" …" if len(miss) > 12 else "") if miss else ""))

    def map_scores(*_):
        text = paste.get("1.0", "end")
        if not text.strip():
            return
        try:
            head, rows, missing = parse_scores(text, names_map())
        except ValueError as e:
            status.set(str(e))
            return
        result.update(head=head, rows=rows, missing=missing)
        scheds = sorted({r[0][:5] for r in rows})
        sched_box["values"] = ["All schedules"] + scheds
        if sched_var.get() not in sched_box["values"]:
            sched_var.set("All schedules")
        render_scores()

    def copy_result():
        if not result["rows"]:
            status.set("Nothing to copy. Paste Scores first.")
            return
        root.clipboard_clear()
        root.clipboard_append(rows_to_tsv(result["head"], visible_rows()))
        status.set(f"Copied {len(visible_rows())} row(s) with names. Paste into Sheets or Excel.")

    def save_result():
        if not result["rows"]:
            status.set("Nothing to save. Paste Scores first.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")],
                                            initialfile="GEEL1_scores_named.csv")
        if not path:
            return
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            csv.writer(f).writerows([result["head"]] + visible_rows())
        status.set(f"Saved {len(visible_rows())} row(s) → {path}")

    def name_from_scores(_e=None):
        sel = out_tree.selection()
        if not sel:
            return
        code = out_tree.item(sel[0], "values")[0]
        cur = names_map().get(code, "")
        nm = simpledialog.askstring("Set name", f"Full name for {code}:", initialvalue=cur, parent=root)
        if nm and len(norm_name(nm)) >= 3:
            set_name(code, nm)
            map_scores()

    def clear_paste():
        paste.delete("1.0", "end")
        result.update(head=[], rows=[], missing=[])
        out_tree.delete(*out_tree.get_children())
        status.set("Cleared.")

    pending = {"id": None}

    def on_modified(_e=None):
        # any change (Ctrl+V, right-click paste, typing) re-maps shortly after
        if not paste.edit_modified():
            return
        paste.edit_modified(False)
        if pending["id"]:
            root.after_cancel(pending["id"])
        pending["id"] = root.after(250, map_scores)

    paste.bind("<<Modified>>", on_modified)
    paste.bind("<Control-Return>", lambda e: (map_scores(), "break")[1])
    out_tree.bind("<Double-1>", name_from_scores)
    ttk.Button(bar1, text="Map names", style="Big.TButton", command=map_scores).pack(side="left")
    ttk.Button(bar1, text="Clear", command=clear_paste).pack(side="left", padx=6)
    ttk.Label(bar1, text="Show:").pack(side="left", padx=(18, 4))
    sched_box = ttk.Combobox(bar1, textvariable=sched_var, state="readonly", width=16, values=["All schedules"])
    sched_box.pack(side="left")
    sched_box.bind("<<ComboboxSelected>>", lambda e: render_scores())
    ttk.Button(bar1b, text="Copy result (with names)", style="Big.TButton", command=copy_result).pack(side="left")
    ttk.Button(bar1b, text="Save CSV…", command=save_result).pack(side="left", padx=6)

    # ===== Tab 2: Scan QR =====
    t2 = ttk.Frame(nb, padding=8)
    nb.add(t2, text="  Scan QR  ")
    left = ttk.Frame(t2)
    left.pack(side="left", fill="both", expand=True)
    right = ttk.Frame(t2, width=380)
    right.pack(side="left", fill="both", padx=(10, 0))
    bar2 = ttk.Frame(left)
    bar2.pack(fill="x")
    cam_var = tk.IntVar(value=0)
    ttk.Label(bar2, text="Camera").pack(side="left")
    ttk.Spinbox(bar2, from_=0, to=9, width=4, textvariable=cam_var).pack(side="left", padx=4)
    preview = ttk.Label(left, text="Camera off", anchor="center", relief="sunken")
    preview.pack(fill="both", expand=True, pady=6)
    banner = tk.Label(left, text="Show a Score QR", font=("Segoe UI", 13, "bold"), anchor="w")
    banner.pack(fill="x")
    ttk.Label(right, text="Scan log").pack(anchor="w")
    log = tk.Listbox(right, font=("Consolas", 10), activestyle="none")
    log.pack(fill="both", expand=True)
    COLORS = {"new": "#1b7f2a", "same": "#7a5b00", "conflict": "#c62828", "dupname": "#e65100", "bad": "#c62828"}
    cam = {"cap": None, "det": None, "n": 0, "seen": {}, "img": None}

    def handle_text(text, source=""):
        p = decode_payload(text)
        if not p:
            st, msg = "bad", "Not a GEEL 1 Score QR"
        else:
            st, msg = record(con, p)
        line = time.strftime("%H:%M:%S ") + (source + ": " if source else "") + msg
        log.insert(0, line)
        log.itemconfig(0, foreground=COLORS[st])
        banner.configure(text=msg, fg=COLORS[st])
        if st in ("conflict", "dupname", "bad"):
            root.bell()
        refresh_students()
        refresh_conflicts()
        if result["rows"]:
            map_scores()

    def cam_tick():
        cap = cam["cap"]
        if not cap:
            return
        import cv2
        ok, frame = cap.read()
        if ok:
            cam["n"] += 1
            if cam["n"] % 3 == 0:
                for t in decode_frame(cv2, cam["det"], frame):
                    if time.time() - cam["seen"].get(t, 0) > 4:
                        cam["seen"][t] = time.time()
                        handle_text(t)
            if Image is not None:
                w = max(preview.winfo_width(), 320)
                h = max(preview.winfo_height(), 240)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                im = Image.fromarray(rgb)
                im.thumbnail((w, h))
                cam["img"] = ImageTk.PhotoImage(im)
                preview.configure(image=cam["img"], text="")
        root.after(30, cam_tick)

    def cam_start():
        if cam["cap"]:
            return
        try:
            import cv2
        except ImportError:
            messagebox.showerror("OpenCV missing", "Install it first:\n\npip install opencv-python")
            return
        idx = cam_var.get()
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(idx)
        if not cap.isOpened():
            messagebox.showerror("Camera", f"Camera {idx} is not available.")
            return
        cam.update(cap=cap, det=cv2.QRCodeDetector(), n=0)
        if Image is None:
            preview.configure(text="Scanning (install Pillow for a live preview: pip install pillow)")
        cam_tick()

    def cam_stop():
        if cam["cap"]:
            cam["cap"].release()
        cam["cap"] = None
        cam["img"] = None
        preview.configure(image="", text="Camera off")

    def load_images():
        paths = filedialog.askopenfilenames(filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp *.webp"), ("All", "*.*")])
        if not paths:
            return
        try:
            import cv2
        except ImportError:
            messagebox.showerror("OpenCV missing", "Install it first:\n\npip install opencv-python")
            return
        det = cv2.QRCodeDetector()
        for path in paths:
            name = os.path.basename(path)
            img = cv2.imread(path)
            if img is None:
                log.insert(0, f"{name}: cannot open")
                continue
            texts = decode_frame(cv2, det, img) or decode_frame(cv2, det, cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
            if not texts:
                log.insert(0, f"{name}: no QR found")
                log.itemconfig(0, foreground=COLORS["bad"])
            for t in texts:
                handle_text(t, name)

    ttk.Button(bar2, text="Start camera", style="Big.TButton", command=cam_start).pack(side="left", padx=(10, 4))
    ttk.Button(bar2, text="Stop", command=cam_stop).pack(side="left")
    ttk.Button(bar2, text="Load QR images…", command=load_images).pack(side="left", padx=10)

    # ===== Tab 3: Students =====
    t3 = ttk.Frame(nb, padding=8)
    nb.add(t3, text="  Students  ")
    bar3 = ttk.Frame(t3)
    bar3.pack(fill="x")
    find_var = tk.StringVar()
    ttk.Label(bar3, text="Find").pack(side="left")
    ttk.Entry(bar3, textvariable=find_var, width=28).pack(side="left", padx=4)
    st_frame, st_tree = make_tree(t3, ["Code", "Name", "Schedule", "Last scan", "Scans"],
                                  {"Code": 100, "Schedule": 90, "Last scan": 150, "Scans": 60})
    st_frame.pack(fill="both", expand=True, pady=6)
    bar3b = ttk.Frame(t3)
    bar3b.pack(fill="x")

    def refresh_students(*_):
        q = find_var.get().strip().upper()
        st_tree.delete(*st_tree.get_children())
        rows = con.execute("SELECT code,name,sched,last_seen,scans FROM students ORDER BY sched, upper(name)").fetchall()
        n = 0
        for r in rows:
            if q and q not in r[0].upper() and q not in r[1].upper():
                continue
            st_tree.insert("", "end", values=r)
            n += 1
        nb.tab(t3, text=f"  Students ({len(rows)})  ")

    def set_name(code, nm):
        t = now()
        con.execute("""INSERT INTO students(code,name,sched,first_seen,last_seen,scans) VALUES(?,?,?,?,?,0)
                       ON CONFLICT(code) DO UPDATE SET name=excluded.name""", (code, norm_name(nm), code[:5], t, t))
        con.commit()
        refresh_students()
        status.set(f"Set {code} → {norm_name(nm)}")

    def edit_student(_e=None):
        sel = st_tree.selection()
        if not sel:
            return
        code, cur = st_tree.item(sel[0], "values")[:2]
        nm = simpledialog.askstring("Edit name", f"Full name for {code}:", initialvalue=cur, parent=root)
        if nm and len(norm_name(nm)) >= 3:
            set_name(code, nm)
            if result["rows"]:
                map_scores()

    def add_student():
        code = simpledialog.askstring("Add", "Class code (e.g. 12030-07):", parent=root)
        if not code:
            return
        code = code.strip()
        if not CODE_RE.match(code):
            messagebox.showerror("Add", "Code must look like 12030-07.")
            return
        nm = simpledialog.askstring("Add", f"Full name for {code}:", parent=root)
        if nm and len(norm_name(nm)) >= 3:
            set_name(code, nm)

    def remove_student():
        sel = st_tree.selection()
        if not sel:
            return
        codes = [st_tree.item(s, "values")[0] for s in sel]
        if not messagebox.askyesno("Remove", f"Remove {len(codes)} student(s) from the map?\n" + ", ".join(codes)):
            return
        con.executemany("DELETE FROM students WHERE code=?", [(c,) for c in codes])
        con.commit()
        refresh_students()

    def export_students():
        path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")], initialfile="GEEL1_code_map.csv")
        if not path:
            return
        rows = con.execute("SELECT code,name,sched,first_seen,last_seen,scans FROM students ORDER BY sched, upper(name)").fetchall()
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["Code", "Name", "Schedule", "First scan", "Last scan", "Scans"])
            w.writerows(rows)
        status.set(f"Exported {len(rows)} → {path}")

    find_var.trace_add("write", refresh_students)
    st_tree.bind("<Double-1>", edit_student)
    ttk.Button(bar3b, text="Edit name", command=edit_student).pack(side="left")
    ttk.Button(bar3b, text="Add…", command=add_student).pack(side="left", padx=6)
    ttk.Button(bar3b, text="Remove", command=remove_student).pack(side="left")
    ttk.Button(bar3b, text="Export CSV…", command=export_students).pack(side="left", padx=6)

    # ===== Tab 4: Conflicts =====
    t4 = ttk.Frame(nb, padding=8)
    nb.add(t4, text="  Conflicts  ")
    ttk.Label(t4, text="code-name: a code was scanned with a different name (stored name kept).   "
                       "name-two-codes: the same name holds two codes (duplicate account?).").pack(anchor="w")
    cf_frame, cf_tree = make_tree(t4, ["Time", "Kind", "Code", "Stored", "Scanned"],
                                  {"Time": 150, "Kind": 120, "Code": 100, "Stored": 220, "Scanned": 220})
    cf_frame.pack(fill="both", expand=True, pady=6)

    def refresh_conflicts():
        cf_tree.delete(*cf_tree.get_children())
        rows = con.execute("SELECT id,at,kind,code,stored_name,scanned_name FROM conflicts ORDER BY id DESC").fetchall()
        for r in rows:
            cf_tree.insert("", "end", iid=str(r[0]), values=r[1:])
        nb.tab(t4, text=f"  Conflicts ({len(rows)})  ")

    def dismiss_conflicts():
        sel = cf_tree.selection()
        if not sel:
            return
        con.executemany("DELETE FROM conflicts WHERE id=?", [(int(s),) for s in sel])
        con.commit()
        refresh_conflicts()

    def use_scanned():
        sel = cf_tree.selection()
        for s in sel:
            at, kind, code, stored, scanned = cf_tree.item(s, "values")
            if kind == "code-name":
                set_name(code, scanned)
        dismiss_conflicts()

    bar4 = ttk.Frame(t4)
    bar4.pack(fill="x")
    ttk.Button(bar4, text="Use scanned name", command=use_scanned).pack(side="left")
    ttk.Button(bar4, text="Dismiss", command=dismiss_conflicts).pack(side="left", padx=6)

    refresh_students()
    refresh_conflicts()
    paste.focus_set()

    def on_close():
        cam_stop()
        con.close()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()


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
    s = sub.add_parser("gui"); s.set_defaults(fn=lambda a: run_gui())
    args = ap.parse_args()
    if not args.cmd:
        run_gui()
        return
    args.fn(args)


if __name__ == "__main__":
    main()

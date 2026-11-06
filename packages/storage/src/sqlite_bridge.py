#!/usr/bin/env python3
import sys
import os
import json
import shutil
import hashlib
import sqlite3

def run_ops(conn, ops):
    results = []
    with conn:
        for op in ops:
            kind = op.get("kind", "all")
            sql = op["sql"]
            params = op.get("params", [])
            if kind == "exec":
                conn.executescript(sql)
                results.append({"changes": 0})
            elif kind == "run":
                cur = conn.execute(sql, params)
                results.append({"changes": cur.rowcount, "lastInsertRowid": cur.lastrowid})
            elif kind == "get":
                cur = conn.execute(sql, params)
                row = cur.fetchone()
                results.append(dict(row) if row is not None else None)
            else:
                cur = conn.execute(sql, params)
                rows = [dict(r) for r in cur.fetchall()]
                results.append(rows)
    return results

def check_valid_sqlite_header(path):
    if not os.path.exists(path):
        return True
    size = os.path.getsize(path)
    if size == 0:
        return True
    if size < 100:
        return False
    with open(path, "rb") as f:
        header = f.read(16)
    return header == b"SQLite format 3\x00"

def main():
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stdout.write(json.dumps({"ok": True, "results": []}))
        return
    payload = json.loads(raw)
    db_path = os.path.abspath(payload["dbPath"])
    ops = payload.get("ops", [])

    if not check_valid_sqlite_header(db_path):
        sys.stdout.write(json.dumps({"ok": False, "error": "file is not a database", "errorType": "DatabaseError"}))
        return

    try:
        conn = sqlite3.connect(db_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        results = run_ops(conn, ops)
        conn.close()
        sys.stdout.write(json.dumps({"ok": True, "results": results}))
        return
    except sqlite3.OperationalError as e:
        if "disk i/o error" not in str(e).lower() and "locking" not in str(e).lower():
            sys.stdout.write(json.dumps({"ok": False, "error": str(e), "errorType": "OperationalError"}))
            return

    try:
        key_hash = hashlib.sha256(db_path.encode("utf-8")).hexdigest()[:16]
        shadow_path = os.path.join("/tmp", f"projectmind_shadow_{key_hash}.db")
        if os.path.exists(db_path) and os.path.getsize(db_path) > 0:
            shutil.copyfile(db_path, shadow_path)
        elif os.path.exists(shadow_path):
            os.remove(shadow_path)

        conn = sqlite3.connect(shadow_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = DELETE;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        results = run_ops(conn, ops)
        conn.close()

        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        shutil.copyfile(shadow_path, db_path)
        sys.stdout.write(json.dumps({"ok": True, "results": results}))
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(e), "errorType": type(e).__name__}))

if __name__ == "__main__":
    main()

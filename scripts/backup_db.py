"""Backs up the app's database (the same one the live app uses) into
supabase-db-backup/<YYYY-MM-DD_HHMM>/.

    python scripts/backup_db.py

Reads DATABASE_URL from the environment or the repo's .env, exactly as the app
does. With pg_dump installed it saves a full dump (backup.dump); without it,
every table in the public schema is saved as <table>.json plus schema.json
(tables, columns, keys, sequence values), so it works on a plain Windows laptop.
It only ever reads the database. The 10 newest backups are kept; older ones are
deleted. supabase-db-backup/ is git-ignored: backups contain customer data and
must never be committed. Restore steps: supabase-db-backup/RESTORE.md.

Only the database is backed up — not the photos and renders stored on the
server's disk (/media).
"""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from sqlalchemy import create_engine, text

REPO = Path(__file__).resolve().parent.parent
BACKUP_ROOT = REPO / "supabase-db-backup"
KEEP = 10
FOLDER_FORMAT = "%Y-%m-%d_%H%M"

RESTORE_MD = """\
# Restoring the database from a backup

Each folder here (`YYYY-MM-DD_HHMM`) is one backup made by `python scripts/backup_db.py`.
`manifest.json` in it says how it was made (`"method"`), when, and how many rows each table had.
Only the database is in a backup — not the photos and renders on the server's disk.

A restore overwrites the live data that Reflection Lifestyle uses. Do it only at a quiet time,
and only when you are sure.

## Before any restore
1. Stop the app: in Render, open the service and choose **Suspend** (so nothing writes while you restore).
2. Take a fresh backup of the current state first: `python scripts/backup_db.py`
   (so the restore itself can be undone).
3. Pick the backup folder to restore from and open its `manifest.json` to check the date and row counts.

## A. Backup made with pg_dump (`"method": "pg_dump"`, a `backup.dump` file)
1. Install the PostgreSQL client tools (they include `pg_restore`), the same major version as the
   Supabase server or newer.
2. Run, with the connection string from `.env` (`DATABASE_URL`, without any `+psycopg2` part):

       pg_restore --clean --if-exists --no-owner --no-privileges --dbname "<DATABASE_URL>" backup.dump

3. Check the row counts in Supabase (Table Editor) against `manifest.json`.

## B. Backup made without pg_dump (`"method": "json"`, one `<table>.json` per table)
These are plain copies of every row. `schema.json` lists each table's columns, primary key,
foreign keys and the value of each id counter, and `manifest.json` gives `restore_order`:
the order to load tables so that every row's foreign keys already exist.

To put back ONE row or a few (the usual case — something was deleted or edited by mistake):
1. Open that table's `.json` file and find the row(s) by id.
2. In Supabase → SQL Editor, `INSERT` (or `UPDATE`) those rows with the values from the file.

To put back WHOLE tables:
1. In Supabase → SQL Editor, for each table to restore, in the REVERSE of `restore_order`:
   `TRUNCATE TABLE <table> RESTART IDENTITY CASCADE;`
   (CASCADE also empties tables that point at it — restore those too.)
2. Load each table's rows in `restore_order`: Supabase → Table Editor → the table → Insert →
   Import data from CSV (convert the `.json` to CSV first), or ask Claude to write the INSERTs
   from the `.json` files.
3. Set every id counter back to the value in `schema.json` → `sequences`:
   `SELECT setval('<sequence>', <last_value>);`
4. Check the row counts against `manifest.json`.

## After any restore
1. In Render, **Resume** the service. On start-up the app re-applies its own table changes
   (ALTER TABLE …), so a backup from before a deploy still works with the newer code.
2. Open the app and check a customer, a room and a render.
"""


def database_url() -> str:
    load_dotenv(REPO / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set (in the environment or in .env).")
    return url


def jsonable(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"base64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    raise TypeError(f"can't save {type(value).__name__}")


def new_folder() -> Path:
    BACKUP_ROOT.mkdir(exist_ok=True)
    stamp = dt.datetime.now().strftime(FOLDER_FORMAT)
    folder = BACKUP_ROOT / stamp
    n = 2
    while folder.exists():  # two backups in the same minute
        folder = BACKUP_ROOT / f"{stamp}_{n}"
        n += 1
    folder.mkdir()
    return folder


def try_pg_dump(url: str, folder: Path) -> bool:
    pg_dump = shutil.which("pg_dump")
    if not pg_dump:
        print("pg_dump not found: saving each table as JSON instead.")
        return False
    plain_url = url.replace("postgresql+psycopg2://", "postgresql://").replace("postgres+psycopg2://", "postgres://")
    result = subprocess.run(
        [pg_dump, "--format=custom", "--no-owner", "--no-privileges", "--file", str(folder / "backup.dump"), "--dbname", plain_url],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("pg_dump failed, saving each table as JSON instead:", (result.stderr or "").strip()[:500])
        (folder / "backup.dump").unlink(missing_ok=True)
        return False
    return True


def restore_order(tables: list[str], foreign_keys: list[dict]) -> list[str]:
    """Tables ordered so every table comes after the tables it points at."""
    needs = {t: {fk["references_table"] for fk in foreign_keys if fk["table"] == t and fk["references_table"] != t} for t in tables}
    order, done = [], set()
    while len(order) < len(tables):
        ready = sorted(t for t in tables if t not in done and needs[t] <= done)
        if not ready:  # a cycle: add the rest as they are
            ready = sorted(t for t in tables if t not in done)
        for t in ready:
            order.append(t)
            done.add(t)
    return order


def main() -> None:
    url = database_url()
    engine = create_engine(url, pool_pre_ping=True)
    folder = new_folder()
    method = "pg_dump" if try_pg_dump(url, folder) else "json"

    counts: dict[str, int] = {}
    # one read-only snapshot, so every table is copied as of the same moment
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as conn:
        conn.execute(text("SET TRANSACTION READ ONLY"))
        tables = [
            r[0]
            for r in conn.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
                )
            )
        ]
        columns = conn.execute(
            text(
                "SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position "
                "FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"
            )
        ).mappings().all()
        keys = conn.execute(
            text(
                """
                SELECT tc.table_name, tc.constraint_type, kcu.column_name,
                       ccu.table_name AS references_table, ccu.column_name AS references_column
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                LEFT JOIN information_schema.constraint_column_usage ccu
                  ON tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = ccu.constraint_name
                WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
                ORDER BY tc.table_name, kcu.ordinal_position
                """
            )
        ).mappings().all()
        sequences = []
        for col in columns:
            if col["column_default"] and str(col["column_default"]).startswith("nextval("):
                seq = conn.execute(
                    text("SELECT pg_get_serial_sequence(:t, :c)"), {"t": f'public."{col["table_name"]}"', "c": col["column_name"]}
                ).scalar()
                if seq:
                    last = conn.execute(text(f"SELECT last_value FROM {seq}")).scalar()
                    sequences.append({"table": col["table_name"], "column": col["column_name"], "sequence": seq, "last_value": last})

        for table in tables:
            if method == "json":
                result = conn.execute(text(f'SELECT * FROM public."{table}"'))
                rows = [dict(row) for row in result.mappings()]
                with open(folder / f"{table}.json", "w", encoding="utf-8") as f:
                    json.dump(rows, f, default=jsonable, ensure_ascii=False)
                counts[table] = len(rows)
            else:
                counts[table] = conn.execute(text(f'SELECT count(*) FROM public."{table}"')).scalar()

    foreign_keys = [
        {"table": k["table_name"], "column": k["column_name"], "references_table": k["references_table"], "references_column": k["references_column"]}
        for k in keys
        if k["constraint_type"] == "FOREIGN KEY"
    ]
    schema = {
        "tables": {
            t: {
                "columns": [
                    {k: c[k] for k in ("column_name", "data_type", "is_nullable", "column_default")} for c in columns if c["table_name"] == t
                ],
                "primary_key": [k["column_name"] for k in keys if k["table_name"] == t and k["constraint_type"] == "PRIMARY KEY"],
            }
            for t in tables
        },
        "foreign_keys": foreign_keys,
        "sequences": sequences,
    }
    with open(folder / "schema.json", "w", encoding="utf-8") as f:
        json.dump(schema, f, default=jsonable, ensure_ascii=False, indent=1)
    parts = urlsplit(url)
    manifest = {
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "method": method,
        "database": {"host": parts.hostname, "port": parts.port, "name": parts.path.lstrip("/")},  # never the password
        "row_counts": counts,
        "restore_order": restore_order(tables, foreign_keys),
        "note": "Database only: photos and renders on the server's disk are not included. See ../RESTORE.md.",
    }
    with open(folder / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    (BACKUP_ROOT / "RESTORE.md").write_text(RESTORE_MD, encoding="utf-8")

    size_mb = sum(p.stat().st_size for p in folder.iterdir()) / 1_000_000
    print(f"\nBackup saved ({method}, {size_mb:.1f} MB): {folder}")
    width = max(len(t) for t in counts) if counts else 0
    for table in tables:
        print(f"  {table:<{width}}  {counts[table]:>8} rows")
    print(f"  {'total':<{width}}  {sum(counts.values()):>8} rows")

    backups = sorted(p for p in BACKUP_ROOT.iterdir() if p.is_dir())
    for old in backups[:-KEEP]:
        shutil.rmtree(old)
        print(f"Deleted old backup: {old.name}")
    print(f"Backups kept: {min(len(backups), KEEP)} (the {KEEP} newest). Restore steps: {BACKUP_ROOT / 'RESTORE.md'}")


if __name__ == "__main__":
    main()

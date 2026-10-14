"""One-time back-fill of items.short_description (used by "Draw on photo").

    python scripts/backfill_descriptions.py          # shows what it would do, changes nothing
    python scripts/backfill_descriptions.py --run    # describes them (one vision call per distinct photo)

Uses the same database and vision model as the app (.env). Pieces that share a
photo with an already described piece copy its description instead of making
a call. Photos are read from the app's data folder (DATA_DIR), so on a laptop
without the server's photos the calls are skipped and logged.

Writes to the database: take a backup first (python scripts/backup_db.py).
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
logging.basicConfig(level=logging.INFO, format="%(message)s")

import main  # noqa: E402


def run(apply: bool) -> None:
    db = main.SessionLocal()
    try:
        items = (
            db.query(main.Item)
            .filter((main.Item.short_description.is_(None)) | (main.Item.short_description == ""))
            .order_by(main.Item.id)
            .all()
        )
        photos = list(dict.fromkeys(i.photo_path for i in items))
        on_disk = [p for p in photos if (main.DATA_ROOT / p).is_file()]
        print(f"{len(items)} pieces without a description, {len(photos)} distinct photos ({len(on_disk)} found on this machine)")
        if not apply:
            print("Nothing changed. Run with --run to describe them.")
            return
        calls = main.fill_missing_descriptions(db, items)
        left = sum(1 for i in items if not (i.short_description or "").strip())
        print(f"done: {calls} vision call(s); {len(items) - left} pieces described, {left} still without one")
    finally:
        db.close()


if __name__ == "__main__":
    run("--run" in sys.argv)

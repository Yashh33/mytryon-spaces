import asyncio
import base64
import calendar
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import bcrypt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from openai import BadRequestError, OpenAI, RateLimitError
from PIL import Image, ImageOps
from pydantic import BaseModel
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    create_engine,
    func,
    inspect,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker
import pillow_heif

load_dotenv()
# iPhone photos are HEIC/HEIF by default; Pillow can't decode them without this.
pillow_heif.register_heif_opener()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("mytryon")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"

# Disk root for uploaded photos and renders: /data on Render (mounted disk),
# ./data for local dev. Override with DATA_DIR if needed.
DATA_ROOT = Path(os.environ.get("DATA_DIR") or ("/data" if Path("/data").is_dir() else BASE_DIR / "data"))
ROOMS_DIR = DATA_ROOT / "rooms"
ITEMS_DIR = DATA_ROOT / "items"
RENDERS_DIR = DATA_ROOT / "renders"
PLANS_DIR = DATA_ROOT / "plans"  # floor-plan PNGs exported by the client, for the placement writer only
for d in (ROOMS_DIR, ITEMS_DIR, RENDERS_DIR):
    d.mkdir(parents=True, exist_ok=True)

MODEL_NAME = "gpt-image-2"

# ---------------------------------------------------------------------------
# GENERATION PROMPT — the live prompt lives in the `settings` table (key
# "generation_prompt") and is editable from /admin/prompt with no redeploy.
# This constant is only the seed value on first run and the "reset to
# default" target. It is loaded fresh from the DB on every generation, never
# cached at startup. {{ROOM_TYPE}} and {{PIECES}} are substituted in before
# the prompt is sent to the model, alongside the room photo and each product
# reference photo in order — see PROMPT_PLACEHOLDERS below.
# ---------------------------------------------------------------------------
DEFAULT_GENERATION_PROMPT = """\
{{IMAGE_MANIFEST}}

Add the furniture into the room photograph (Image 1).

CAMERA — this requirement overrides every other instruction
The output must be the same photograph as Image 1, taken from the
identical camera position, height, angle, tilt, rotation and focal
length. Do not re-frame, re-crop, zoom, pan, straighten or centre the
view. Every wall, edge, corner and ceiling line must appear at exactly
the same angle and in exactly the same place in the frame as in Image 1.
If a wall is seen obliquely in Image 1, it must still be seen obliquely
at the same angle. The result must look like Image 1 with furniture added
to it, never like a new photograph of the same room.

Any description below of where the camera stands is given only to help
you work out where the furniture goes. It must never change the camera
position, angle or framing of your output. Match Image 1 exactly.

ROOM LAYOUT, as seen in Image 1
{{ROOM_LAYOUT}}

PLACEMENT
Read these as strict requirements.

{{PLACEMENT}}

Keep everything else exactly the same. Preserve the walls, doorways,
windows, floor, ceiling and room proportions precisely as they appear.
Change nothing except adding the furniture.

Remove any people from the photograph.

Each piece takes its fabric, colour, texture, arm, leg and cushion style
from ITS OWN reference photograph. The NUMBER of seats and cushions is
never taken from the photograph — it comes only from the configuration
stated above. Where a photograph shows fewer or more seats than the
stated configuration, rebuild that piece longer or shorter in the same
design, adding or removing matching seat and back cushions. Do not apply
one piece's material or colour to another.

{{CONFIG_NOTES}}

Clear away people, tools, ladders, cement bags, rubble and loose building
material, and finish all bare surfaces — plaster becomes painted wall,
screed becomes finished flooring.

Surfaces are often covered with newspaper, plastic sheeting, masking tape
or protective film during painting and finishing work. Remove the
covering, but never remove what lies underneath it. Where the covering
follows the outline of panelling, moulding, recesses, niches, a built-in
unit, cladding or similar permanent joinery, render that feature complete
and finished — as it will look once the work is done. A wall with five
recessed panels must still have five recessed panels. Never replace a
covered feature with a flat blank wall.

{{ROOM_TREATMENT}}

Add no decorative objects of any kind. No plants, no artwork, no vases,
no books, no trays, no lamps, no ornaments. A plain rug and a simple
coffee table are permitted, nothing else. The room must otherwise contain
only the furniture pieces listed below.

{{LIGHTING}}

The furniture being placed must be the visual focal point of the image.
Compose, light and stage the room so the eye goes to it first. Anything
else added to the space must stay secondary and must never compete with
it for attention.

Room: {{ROOM_TYPE}}
Furniture:
{{PIECES}}"""

PROMPT_SETTING_KEY = "generation_prompt"
PROMPT_PLACEHOLDERS = [
    {
        "token": "{{ROOM_TYPE}}",
        "description": 'The room type chosen for this visualization — "Living room", "Bedroom", "Dining", or "Balcony".',
    },
    {
        "token": "{{PIECES}}",
        "description": 'One line per added piece, in the same order the product photos are sent to the model, formatted as "- Sofa (L-shape), 7 ft wide".',
    },
    {
        "token": "{{IMAGE_MANIFEST}}",
        "description": 'One line per image, in the exact order sent to the model: "Image 1 is a room." then one line per product photo, in the order pieces were added, e.g. "Image 2 is a showroom photograph of a sofa...".',
    },
    {
        "token": "{{PLACEMENT}}",
        "description": "Plain-English placement instructions generated from where the salesman positioned each piece's block on the layout, e.g. \"It stands against the far wall, back flat against that wall, in the centre of that wall. Its seats face toward the camera.\" Numbered per piece, bound to that piece's Image number, with neighbour and feature notes where relevant. Falls back to a single generic line when placement was skipped or nothing was placed.",
    },
    {
        "token": "{{ROOM_LAYOUT}}",
        "description": 'A short, confident summary of the vision-generated room layout — depth, and what stands on the far/left/right walls — for placement context only, e.g. "The room is deeper than wide. Far wall: with a medium window at the centre. ..." Falls back to a single camera-position line when no layout is available yet.',
    },
    {
        "token": "{{CONFIG_NOTES}}",
        "description": 'Definitions for only the piece configurations actually selected in this request — e.g. what "3+3" or "L-shape" means — one line per matching type. Empty when nothing selected has a definition; works unwrapped or inside {{#CONFIG_NOTES}}…{{/CONFIG_NOTES}}.',
    },
    {
        "token": "{{#CONFIG_NOTES}} … {{/CONFIG_NOTES}}",
        "description": "Optional wrapper for a configuration-notes section. Only appears in the prompt sent to the model when at least one selected piece has a matching definition — removed entirely otherwise, so it's safe to reword or move but keep both tags.",
    },
    {
        "token": "{{ROOM_TREATMENT}}",
        "description": 'The salesman\'s "How should the room look?" choice from the finishing step — expands to the full luxury or minimal styling instruction, e.g. "...present the space with refined luxury interior styling and premium finishing."',
    },
    {
        "token": "{{LIGHTING}}",
        "description": 'The salesman\'s lighting choice from the finishing step — warm, daylight, or studio — expands to the full lighting instruction, e.g. "Light the room with bright natural daylight entering from the existing windows..."',
    },
]

IMAGE_QUALITY = "medium"

# ---------------------------------------------------------------------------
# VISION LAYOUT — a salesman input aid only. The room photo is sent to a
# vision-capable text model on upload to produce a rough top-down
# floor-plan description; the salesman positions furniture blocks against
# it. This JSON is NEVER sent to the image generation model — testing
# showed doing so makes the render worse. The live prompt and model both
# live in the `settings` table (keys "vision_prompt" and "vision_model"),
# editable from /admin/prompt with no redeploy; these constants are only
# the seed values on first run.
#
# Model chosen by checking a live client.models.list() call rather than
# guessing, confirmed vision-capable via its own docs page ("Input
# modalities: text, image").
# ---------------------------------------------------------------------------
DEFAULT_VISION_MODEL = "gpt-6-luna"
VISION_MODEL_SETTING_KEY = "vision_model"
VISION_PROMPT_SETTING_KEY = "vision_prompt"
DEFAULT_VISION_PROMPT = """\
You are analysing a photograph of a room. Your output will be used to
draw a simple top-down floor plan, which a furniture salesman will then
use to position furniture in this room. Accuracy about walls, openings
and obstructions matters more than detail — a missed doorway or pillar
leads to furniture being placed where it cannot physically go.

Describe the room's layout from the camera's point of view. Be precise
and conservative: never guess or invent features.

Conventions:
- "far wall" is the wall directly facing the camera.
- "left wall" and "right wall" are as seen from the camera.
- Positions along the far wall: "left third", "centre", "right third".
- Positions along a side wall: "far third" (near the far wall),
  "middle third", "near third" (near the camera).

For each wall use one of three confidence states:
  "clear"       — you can see the wall well and are confident about it
  "partial"     — you can see part of it, or something is on it that you
                  cannot identify
  "not_visible"

Never return an empty features list for a wall marked "clear" unless you
are confident the wall is genuinely blank. If you see something on a wall
but cannot identify it, list it with type "unknown" and describe what you
see.

Pay particular attention to:
- Tall rectangular shapes on side walls — usually doorways, sometimes
  covered with plastic sheeting during construction.
- Any opening at the edge of the frame.
- Structural obstructions that limit where furniture can stand:
  projecting pillars, columns, beams coming down to the floor, wall
  recesses or alcoves, and steps or level changes.
- Wall planes at different depths. A wall surface in the foreground that
  is closer to the camera than the wall behind it is a projecting pillar
  or a wall return, not a flat wall. The giveaway is a vertical edge
  running floor to ceiling with a visible corner, and a recessed area
  behind it. Report the projecting mass as an obstruction of type
  "pillar" or "column", and set room_shape to "irregular" with a note.

Feature types: window, door, doorway, opening, balcony door, pillar,
column, recess, step, unknown. If you see something that limits furniture
placement and none of these types fit, use "other" and describe it
plainly in notes.

Return only JSON in exactly this shape:

{
  "camera_position": "near end, left | centre | right of the room",
  "room_shape": "rectangular | L-shaped | irregular",
  "shape_notes": "if not a plain rectangle, describe what makes it so",
  "depth_vs_width": "deeper than wide | about square | wider than deep",
  "far_wall": {
    "confidence": "clear | partial | not_visible",
    "features": [
      { "type": "...", "position": "...",
        "size": "small | medium | large", "notes": "..." }
    ]
  },
  "left_wall":  { "confidence": "...", "features": [] },
  "right_wall": { "confidence": "...", "features": [] },
  "near_wall":  { "confidence": "...", "features": [] },
  "floor_state": "finished | unfinished",
  "obstructions": [
    { "type": "...", "location": "describe where it stands",
      "notes": "..." }
  ],
  "clutter": ["short list of loose items on the floor"],
  "uncertain": ["anything you were not sure about, and why"]
}
"""

# ---------------------------------------------------------------------------

CREDITS_PER_GENERATION = 30

# Published gpt-image-2 rates, dollars per 1M tokens.
IMAGE_INPUT_RATE_PER_M = 8.0
TEXT_INPUT_RATE_PER_M = 5.0
IMAGE_OUTPUT_RATE_PER_M = 30.0

# ---------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_IMAGE_DIMENSION = 1536
MAX_ITEMS_PER_ATTEMPT = 4
GENERATION_RETRIES = 2  # in addition to the first attempt
RETRY_BACKOFF_SECONDS = 2.0

SESSION_COOKIE_NAME = "mt_session"
SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

ROOM_TYPES = ["Living room", "Bedroom", "Dining", "Balcony"]
ITEM_TYPES = {
    # "3+2"/"3+3" are kept at the end only so older attempts keep working;
    # the furniture screen no longer offers them.
    "Sofa": ["1-seater", "2-seater", "3-seater", "4-seater", "5-seater", "L-shape", "Corner", "Curved", "3+2", "3+3"],
    "Dining table": ["4 seater", "6 seater", "8 seater"],
    "Chair": ["Single", "Pair"],
    "Bed": ["Single", "Queen", "King"],
}
SHAPE_FOR_TYPE = {"L-shape": "L", "Curved": "curved", "Corner": "corner"}
ROUND_CAPABLE_CATEGORIES = {"Dining table", "Ottoman"}
# 'L', 'curved' and 'corner' share one geometry: {long, short, corner} (see validate_placement).
ARM_SHAPES = {"L", "curved", "corner"}


def derive_item_shape(category: str, type_: str) -> str:
    if type_ in SHAPE_FOR_TYPE:
        return SHAPE_FOR_TYPE[type_]
    if category in ROUND_CAPABLE_CATEGORIES and "round" in type_.lower():
        return "round"
    return "rect"

DEFAULT_ROOM_TREATMENT = "luxury"
ROOM_TREATMENT_CHOICES = ["luxury", "minimal"]
ROOM_TREATMENT_TEXT = {
    "luxury": (
        "Clear away any people, tools, ladders, cement bags, rubble or building "
        "material, and finish all bare surfaces. Keep the walls, windows, doors, "
        "flooring, ceiling and room proportions exactly as photographed. Within "
        "those unchanged boundaries, present the space with refined luxury "
        "interior styling and premium finishing."
    ),
    "minimal": (
        "Clear away any people, tools, ladders, cement bags, rubble or building "
        "material, and finish all bare surfaces. Keep the walls, windows, doors, "
        "flooring, ceiling and room proportions exactly as photographed. Within "
        "those unchanged boundaries, present the space with calm, uncluttered "
        "minimal styling."
    ),
}

DEFAULT_LIGHTING = "warm"
LIGHTING_CHOICES = ["warm", "daylight", "studio"]
LIGHTING_TEXT = {
    "warm": (
        "Keep the time of day exactly as it appears in the room photograph — "
        "if the windows show daylight, they must still show daylight; if they "
        "show night, they must still show night. Do not change what is visible "
        "outside the windows. Within that, give the interior a warm, inviting "
        "atmosphere with soft golden tones and gentle shadows, so the room "
        "feels like a comfortable finished home."
    ),
    "daylight": (
        "Keep the time of day exactly as it appears in the room photograph. Do "
        "not change what is visible outside the windows. Light the interior "
        "brightly and naturally, consistent with the existing windows and the "
        "light already present in the photograph."
    ),
    "studio": (
        "Keep the time of day exactly as it appears in the room photograph. Do "
        "not change what is visible outside the windows. Light the interior "
        "evenly and diffusely with soft shadows, as in a professional interior "
        "photograph."
    ),
}

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
serializer = URLSafeTimedSerializer(os.environ["SESSION_SECRET"], salt="mytryon-session")


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_db_url = os.environ["DATABASE_URL"]
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

engine = create_engine(_db_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


class Shop(Base):
    __tablename__ = "shops"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    monthly_credits = Column(Integer, nullable=False, default=15000, server_default="15000")
    cycle_start_day = Column(Integer, nullable=False, default=1, server_default="1")
    active = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    shop_id = Column(Integer, ForeignKey("shops.id"), nullable=True)  # null only for superadmin
    name = Column(String, nullable=False)
    mobile = Column(String, nullable=True, unique=True)  # null only for superadmin (no login identifier)
    password_hash = Column(String, nullable=False)
    role = Column(String, nullable=False, default="salesman")  # 'superadmin' | 'owner' | 'salesman'
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Customer(Base):
    __tablename__ = "customers"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    rooms = relationship("Room", backref="customer", cascade="all, delete-orphan", order_by="Room.id")


class Room(Base):
    __tablename__ = "rooms"
    id = Column(Integer, primary_key=True)
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=False)
    room_type = Column(String, nullable=False)
    photo_path = Column(String, nullable=False)
    # vision-generated top-down layout description — a salesman input aid
    # only, never sent to the image model (testing showed doing so makes
    # the render worse).
    layout_json = Column(JSONB, nullable=True)
    layout_status = Column(String, nullable=False, default="pending", server_default="pending")  # pending|ready|failed
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    attempts = relationship("Attempt", backref="room", cascade="all, delete-orphan", order_by="Attempt.id")


class Attempt(Base):
    __tablename__ = "attempts"
    id = Column(Integer, primary_key=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    room_treatment = Column(String, nullable=False, default=DEFAULT_ROOM_TREATMENT, server_default="luxury")
    lighting = Column(String, nullable=False, default=DEFAULT_LIGHTING, server_default="warm")
    ignore_placement = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    is_picked = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    # the latest floor-plan PNG uploaded for this attempt, and the placement
    # writer's cached state/result for it — see start_placement_writer()
    plan_path = Column(String, nullable=True)
    placement_writer = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    items = relationship("Item", backref="attempt", cascade="all, delete-orphan", order_by="Item.id")
    renders = relationship("Render", backref="attempt", cascade="all, delete-orphan", order_by="Render.id")


class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    attempt_id = Column(Integer, ForeignKey("attempts.id"), nullable=False)
    category = Column(String, nullable=False)
    type = Column(String, nullable=False)
    width_ft = Column(Float, nullable=False)
    photo_path = Column(String, nullable=False)
    # 'rect' | 'L' | 'curved' | 'round' — derived from category/type, never chosen directly
    shape = Column(String, nullable=False)
    # normalised (0-1) block placements on the room's floor plan, one entry
    # per sub-piece. 'rect'/'round' geometry is {x,y,w,h,rotation}; 'L' and
    # 'curved' geometry is {long, short, corner} where long/short are each
    # rects. See validate_placement() below.
    placement = Column(JSONB, nullable=True)


class Render(Base):
    __tablename__ = "renders"
    id = Column(Integer, primary_key=True)
    attempt_id = Column(Integer, ForeignKey("attempts.id"), nullable=False)
    image_path = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class GenerationDebug(Base):
    __tablename__ = "generation_debug"
    id = Column(Integer, primary_key=True)
    render_id = Column(Integer, ForeignKey("renders.id"), nullable=False, unique=True)
    prompt = Column(Text, nullable=False)
    model = Column(String, nullable=False)
    quality = Column(String, nullable=False)
    size = Column(String, nullable=False)
    elapsed_s = Column(Float, nullable=False)
    usage = Column(JSON, nullable=True)
    # ordered list of {filename, role, width, height, size_bytes, url}; role
    # "plan" is the floor-plan PNG, logged here but sent only to the writer
    images = Column(JSON, nullable=False)
    # {facts, output, used, reason, conflicts, usage, model, elapsed_s} — what the
    # placement writer was given, what it wrote, and whether it was used
    placement_writer = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class CreditLedger(Base):
    """Append-only spend/allocation history. A shop's balance is always
    SUM(delta) over rows in the current billing cycle — never a stored
    running total. A successful generation is recorded as two rows: the
    -30 hold inserted the moment the job starts (so concurrent jobs see
    the reduced balance immediately, and so the accounting-relevant
    fields — delta/reason/shop/user/attempt — are never touched again
    once written), and a zero-delta row added on completion carrying the
    real token/cost telemetry (unknown until the OpenAI call returns)."""

    __tablename__ = "credit_ledger"
    id = Column(Integer, primary_key=True)
    shop_id = Column(Integer, ForeignKey("shops.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    attempt_id = Column(Integer, ForeignKey("attempts.id"), nullable=True)
    render_id = Column(Integer, ForeignKey("renders.id"), nullable=True)
    delta = Column(Integer, nullable=False)  # negative = spend
    reason = Column(String, nullable=False)  # 'generation' | 'refund' | 'allocation' | 'adjustment'
    tokens_in = Column(Integer, nullable=True)
    tokens_out = Column(Integer, nullable=True)
    usd_cost = Column(Float, nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


SEED_USERS = [
    ("Aryan Pandya", "9876543210", "admin"),
    ("Mehul Prajapati", "9824155120", "salesman"),
    ("Rakesh Solanki", "9904371882", "salesman"),
]


def migrate_legacy_projects(db: Session) -> None:
    """One-time move from the old flat `projects` table to
    customers -> rooms -> attempts, re-pointing items/renders from
    project_id to attempt_id. Idempotent and atomic: if `projects` doesn't
    exist there is nothing to do (either never existed, or a previous run
    already finished and dropped it); everything here runs in the caller's
    transaction, so a crash partway leaves the original `projects` table
    untouched for the next attempt to retry from scratch."""
    if "projects" not in inspect(engine).get_table_names():
        return

    db.execute(text("ALTER TABLE items ADD COLUMN IF NOT EXISTS attempt_id INTEGER"))
    db.execute(text("ALTER TABLE renders ADD COLUMN IF NOT EXISTS attempt_id INTEGER"))

    rows = db.execute(
        text(
            "SELECT id, user_id, customer_name, room_type, room_photo_path, "
            "room_treatment, lighting, created_at FROM projects ORDER BY id"
        )
    ).fetchall()
    logger.info("migrating %d legacy projects to customers/rooms/attempts", len(rows))

    for row in rows:
        customer = Customer(user_id=row.user_id, name=row.customer_name, created_at=row.created_at)
        db.add(customer)
        db.flush()

        room = Room(customer_id=customer.id, room_type=row.room_type, photo_path=row.room_photo_path, created_at=row.created_at)
        db.add(room)
        db.flush()

        attempt = Attempt(
            room_id=room.id,
            room_treatment=row.room_treatment,
            lighting=row.lighting,
            ignore_placement=False,
            is_picked=False,
            created_at=row.created_at,
        )
        db.add(attempt)
        db.flush()

        db.execute(text("UPDATE items SET attempt_id = :aid WHERE project_id = :pid"), {"aid": attempt.id, "pid": row.id})
        db.execute(text("UPDATE renders SET attempt_id = :aid WHERE project_id = :pid"), {"aid": attempt.id, "pid": row.id})

    orphan_items = db.execute(text("SELECT COUNT(*) FROM items WHERE attempt_id IS NULL")).scalar()
    orphan_renders = db.execute(text("SELECT COUNT(*) FROM renders WHERE attempt_id IS NULL")).scalar()
    if orphan_items or orphan_renders:
        raise RuntimeError(f"legacy project migration left {orphan_items} items and {orphan_renders} renders unmigrated")

    db.execute(text("ALTER TABLE items ALTER COLUMN attempt_id SET NOT NULL"))
    db.execute(text("ALTER TABLE renders ALTER COLUMN attempt_id SET NOT NULL"))
    db.execute(text("ALTER TABLE items ADD CONSTRAINT items_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES attempts(id)"))
    db.execute(text("ALTER TABLE renders ADD CONSTRAINT renders_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES attempts(id)"))
    db.execute(text("ALTER TABLE items DROP COLUMN IF EXISTS project_id"))
    db.execute(text("ALTER TABLE renders DROP COLUMN IF EXISTS project_id"))
    db.execute(text("DROP TABLE projects"))

    logger.info("legacy project migration complete: %d projects migrated", len(rows))


def migrate_to_shops(db: Session) -> None:
    """One-time multi-tenant setup: creates the initial 'Reflection
    Lifestyle' shop, assigns every existing shop-less user to it,
    promotes the existing admin to owner, creates the superadmin account,
    and records the opening credit allocation. Idempotent: no-ops once
    any shop exists."""
    db.flush()
    if db.query(Shop).count() > 0:
        return

    shop = Shop(name="Reflection Lifestyle", monthly_credits=15000, cycle_start_day=1, active=True)
    db.add(shop)
    db.flush()

    for u in db.query(User).filter(User.shop_id.is_(None)).all():
        u.shop_id = shop.id
        if u.role == "admin":
            u.role = "owner"

    if db.query(User).filter(User.role == "superadmin").first() is None:
        db.add(
            User(
                shop_id=None,
                name="Yash",
                mobile=None,
                password_hash=hash_password(uuid.uuid4().hex),
                role="superadmin",
                active=True,
            )
        )

    db.add(CreditLedger(shop_id=shop.id, user_id=None, delta=shop.monthly_credits, reason="allocation"))
    db.flush()
    logger.info("multi-tenant migration complete: created shop %r", shop.name)


def migrate_item_placements(db: Session) -> None:
    """One-time move of items.placement from a single geometry dict to a
    JSONB array of {sub_index, label, shape, geometry} entries, one per
    placeable sub-piece (see compute_sub_pieces). Idempotent: an item whose
    placement is already a list has already been migrated and is skipped."""
    migrated = 0
    for item in db.query(Item).filter(Item.placement.isnot(None)).all():
        if isinstance(item.placement, list):
            continue
        first = compute_sub_pieces(item)[0]
        item.placement = [{"sub_index": 0, "label": first["label"], "shape": first["shape"], "geometry": item.placement}]
        migrated += 1
    if migrated:
        db.flush()
        logger.info("migrated %d item placements to sub-piece array format", migrated)


def migrate_item_shapes(db: Session) -> None:
    """Re-derives item.shape (e.g. Curved used to share 'L' and is now
    'curved') and relabels each placement entry's shape to match. Geometry is
    untouched: 'curved' uses the same {long, short, corner} form 'L' did.
    Idempotent: items already at their derived shape are skipped."""
    migrated = 0
    for item in db.query(Item).all():
        shape = derive_item_shape(item.category, item.type)
        if item.shape == shape:
            continue
        item.shape = shape
        if isinstance(item.placement, list):
            sub_shapes = {sp["sub_index"]: sp["shape"] for sp in compute_sub_pieces(item)}
            item.placement = [{**e, "shape": sub_shapes.get(e.get("sub_index"), e.get("shape"))} for e in item.placement]
        migrated += 1
    if migrated:
        db.flush()
        logger.info("re-derived shape for %d items", migrated)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        # migrate DBs created before free-hand placement drawing existed.
        conn.execute(text("ALTER TABLE items DROP COLUMN IF EXISTS pin_x"))
        conn.execute(text("ALTER TABLE items DROP COLUMN IF EXISTS pin_y"))
        # migrate DBs created before vision-generated layouts and structured
        # furniture blocks existed: drop the old free-hand strokes column
        # (existing items lose their strokes — attempts keep their renders),
        # add shape (backfilled from category/type, same rule as
        # derive_item_shape) and placement.
        conn.execute(text("ALTER TABLE items DROP COLUMN IF EXISTS strokes"))
        conn.execute(text("ALTER TABLE items ADD COLUMN IF NOT EXISTS shape TEXT"))
        conn.execute(
            text(
                "UPDATE items SET shape = CASE WHEN type = 'L-shape' THEN 'L' WHEN type = 'Curved' THEN 'curved' WHEN type = 'Corner' THEN 'corner' ELSE 'rect' END "
                "WHERE shape IS NULL"
            )
        )
        conn.execute(text("ALTER TABLE items ALTER COLUMN shape SET NOT NULL"))
        conn.execute(text("ALTER TABLE items ADD COLUMN IF NOT EXISTS placement JSONB"))
        # rooms get a vision-generated layout, pending until the background
        # job (or a manual edit) fills it in.
        conn.execute(text("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS layout_json JSONB"))
        conn.execute(text("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS layout_status TEXT NOT NULL DEFAULT 'pending'"))
        # placement writer: the plan image + cached result per attempt, and
        # what it did for each render.
        conn.execute(text("ALTER TABLE attempts ADD COLUMN IF NOT EXISTS plan_path TEXT"))
        conn.execute(text("ALTER TABLE attempts ADD COLUMN IF NOT EXISTS placement_writer JSONB"))
        conn.execute(text("ALTER TABLE generation_debug ADD COLUMN IF NOT EXISTS placement_writer JSON"))
        # migrate DBs created before multi-tenant shops existed: add the
        # column additively (users predates shops; create_all only creates
        # brand-new tables, it won't alter this existing one).
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INTEGER"))
        conn.execute(
            text(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_shop_id_fkey') THEN
                        ALTER TABLE users ADD CONSTRAINT users_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(id);
                    END IF;
                END $$;
                """
            )
        )
        # the superadmin has no mobile number (no identifier — /super/login
        # takes a password only); mobile predates this, so relax it and
        # backfill in one guarded, idempotent block.
        conn.execute(text("ALTER TABLE users ALTER COLUMN mobile DROP NOT NULL"))
        conn.execute(
            text(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_mobile_required_unless_superadmin') THEN
                        ALTER TABLE users ADD CONSTRAINT users_mobile_required_unless_superadmin
                            CHECK (role = 'superadmin' OR mobile IS NOT NULL);
                    END IF;
                END $$;
                """
            )
        )
        # deleting a salesman keeps their credit_ledger rows (accounting
        # history), just with user_id nulled rather than blocking the delete.
        conn.execute(
            text(
                """
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'credit_ledger_user_id_fkey' AND confdeltype != 'n'
                    ) THEN
                        ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_user_id_fkey;
                        ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_user_id_fkey
                            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
                    END IF;
                END $$;
                """
            )
        )
    db = SessionLocal()
    try:
        migrate_legacy_projects(db)

        if db.query(User).count() == 0:
            for name, mobile, role in SEED_USERS:
                db.add(
                    User(
                        name=name,
                        mobile=mobile,
                        password_hash=hash_password("demo123"),
                        role=role,
                        active=True,
                    )
                )
            logger.info("seeded %d users", len(SEED_USERS))
        if db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first() is None:
            db.add(Setting(key=PROMPT_SETTING_KEY, value=DEFAULT_GENERATION_PROMPT))
            logger.info("seeded default generation prompt")
        if db.query(Setting).filter(Setting.key == VISION_PROMPT_SETTING_KEY).first() is None:
            db.add(Setting(key=VISION_PROMPT_SETTING_KEY, value=DEFAULT_VISION_PROMPT))
            logger.info("seeded default vision prompt")
        if db.query(Setting).filter(Setting.key == VISION_MODEL_SETTING_KEY).first() is None:
            db.add(Setting(key=VISION_MODEL_SETTING_KEY, value=DEFAULT_VISION_MODEL))
            logger.info("seeded default vision model")
        if db.query(Setting).filter(Setting.key == PLACEMENT_WRITER_ENABLED_KEY).first() is None:
            db.add(Setting(key=PLACEMENT_WRITER_ENABLED_KEY, value="true"))
        if db.query(Setting).filter(Setting.key == PLACEMENT_WRITER_PROMPT_KEY).first() is None:
            db.add(Setting(key=PLACEMENT_WRITER_PROMPT_KEY, value=DEFAULT_PLACEMENT_WRITER_PROMPT))
            logger.info("seeded default placement writer prompt")
        db.query(Setting).filter(Setting.key.in_(["image_quality", "size_mode"])).delete(synchronize_session=False)

        # one-time cleanup: a previously-saved custom generation prompt may
        # still contain the old placement-annotation block / stroke-map
        # token. build_prompt() no longer substitutes either — left in
        # place they'd leak into the model call as literal, un-substituted
        # "{{#PLACEMENT}}"/"{{STROKE_MAP}}" text.
        saved_prompt = db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first()
        if saved_prompt is not None and (
            "{{#PLACEMENT}}" in saved_prompt.value or "{{STROKE_MAP}}" in saved_prompt.value
        ):
            cleaned = re.sub(r"\{\{#PLACEMENT\}\}.*?\{\{/PLACEMENT\}\}", "", saved_prompt.value, flags=re.DOTALL)
            cleaned = cleaned.replace("{{STROKE_MAP}}", "")
            saved_prompt.value = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip() + "\n"
            logger.info("stripped stale placement/stroke-map syntax from saved generation prompt")

        migrate_to_shops(db)
        migrate_item_shapes(db)
        migrate_item_placements(db)

        # the superadmin used to have a login mobile; it isn't one anymore
        # (/super/login takes a password only) — clear it once, idempotently.
        db.query(User).filter(User.role == "superadmin", User.mobile.isnot(None)).update(
            {User.mobile: None}, synchronize_session=False
        )

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    yield


app = FastAPI(lifespan=lifespan)
app.mount("/media", StaticFiles(directory=str(DATA_ROOT)), name="media")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def make_session_token(user_id: int) -> str:
    return serializer.dumps({"user_id": user_id})


def read_session_token(token: str) -> int | None:
    try:
        data = serializer.loads(token, max_age=SESSION_COOKIE_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("user_id")


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    user_id = read_session_token(token) if token else None
    if user_id is None:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    user = db.query(User).filter(User.id == user_id).first()
    if user is None or not user.active:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return user


def require_owner(user: User = Depends(get_current_user)) -> User:
    if user.role != "owner" or user.shop_id is None:
        raise HTTPException(status_code=403, detail="Owners only.")
    return user


def require_owner_or_superadmin(user: User = Depends(get_current_user)) -> User:
    if user.role not in ("owner", "superadmin"):
        raise HTTPException(status_code=403, detail="Owners only.")
    return user


def require_superadmin(user: User = Depends(get_current_user)) -> User:
    if user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin only.")
    return user


def resolve_admin_shop_id(user: User, shop_id: int | None) -> int | None:
    """Owners always operate on their own shop (the query param, if any,
    is ignored); a superadmin operates on whichever shop_id they passed,
    or none at all — callers should then prompt them to pick a shop."""
    if user.role == "owner":
        return user.shop_id
    return shop_id


def user_public(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "first_name": user.name.split(" ")[0],
        "mobile": user.mobile,
        "role": user.role,
        "active": user.active,
    }


# ---------------------------------------------------------------------------
# Image handling — reused/extended from the original generation pipeline.
# ---------------------------------------------------------------------------


class UploadValidationError(Exception):
    def __init__(self, status_code: int, error: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error = error
        self.message = message


HEIF_MIME_TYPES = {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}
HEIF_EXTENSIONS = (".heic", ".heif")


def _is_heif_upload(upload: UploadFile) -> bool:
    content_type = (upload.content_type or "").lower()
    filename = (upload.filename or "").lower()
    return content_type in HEIF_MIME_TYPES or filename.endswith(HEIF_EXTENSIONS)


async def read_validated_upload(upload: UploadFile) -> bytes:
    content_type = (upload.content_type or "").lower()
    # Some browsers send HEIC with an empty or octet-stream type, so fall
    # back to the file extension for those.
    if not (content_type.startswith("image/") or _is_heif_upload(upload)):
        raise UploadValidationError(400, "invalid_type", "That doesn't look like a photo. Please choose an image.")
    data = await upload.read()
    if len(data) == 0:
        raise UploadValidationError(400, "empty_upload", "That photo looks empty. Please try another.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadValidationError(400, "too_large", "That photo is too large. Please use one under 12MB.")
    return data


def convert_heif_to_jpeg(data: bytes) -> bytes:
    """Converts HEIC/HEIF bytes (the iPhone default) to JPEG bytes, keeping
    the EXIF orientation. Anything that isn't HEIF passes through unchanged."""
    if not pillow_heif.is_supported(data):
        return data
    try:
        with Image.open(io.BytesIO(data)) as heif_image:
            exif = heif_image.getexif()
            rgb = heif_image.convert("RGB")
        out = io.BytesIO()
        rgb.save(out, format="JPEG", quality=95, exif=exif)
        return out.getvalue()
    except Exception:
        logger.exception("HEIC/HEIF conversion failed")
        raise UploadValidationError(
            400,
            "heic_conversion_failed",
            "We couldn't convert that iPhone photo (HEIC). Try again, or set Camera > Formats to "
            "\"Most Compatible\" on the iPhone and retake it.",
        )


def load_and_downscale(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        image = image.convert("RGB")
    except Exception:
        raise UploadValidationError(400, "unreadable_image", "We couldn't read that photo. Please try another.")
    image.thumbnail((MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), Image.LANCZOS)
    return image


async def save_validated_upload(upload: UploadFile, dest_dir: Path) -> str:
    """Validates, downscales to MAX_IMAGE_DIMENSION and saves to dest_dir.
    Returns the path relative to DATA_ROOT."""
    data = convert_heif_to_jpeg(await read_validated_upload(upload))
    image = load_and_downscale(data)
    filename = f"{uuid.uuid4().hex}.jpg"
    dest_dir.mkdir(parents=True, exist_ok=True)
    image.save(dest_dir / filename, format="JPEG", quality=90)
    return str((dest_dir / filename).relative_to(DATA_ROOT)).replace("\\", "/")


def load_local_image_with_debug(path: Path, role: str, url: str) -> tuple[tuple[str, bytes, str], dict]:
    mime_type, _ = mimetypes.guess_type(path.name)
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as im:
        width, height = im.size
    file_tuple = (path.name, data, mime_type or "image/jpeg")
    descriptor = {
        "filename": path.name, "role": role, "width": width, "height": height,
        "size_bytes": len(data), "url": url,
    }
    return file_tuple, descriptor


def derive_size(width: int, height: int) -> str:
    if width > height:
        return "1536x1024"
    if height > width:
        return "1024x1536"
    return "1024x1024"


def extract_image_from_result(result) -> bytes | None:
    if not result.data:
        return None
    b64_json = result.data[0].b64_json
    if not b64_json:
        return None
    return base64.b64decode(b64_json)


class GenerationError(Exception):
    """Terminal, user-facing generation failure after retries are exhausted."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def get_setting(db: Session, key: str, default: str) -> str:
    """Loaded fresh on every generation — never cached — so admin edits to
    /admin/prompt take effect immediately with no redeploy."""
    setting = db.query(Setting).filter(Setting.key == key).first()
    return setting.value if setting else default


def set_setting(db: Session, key: str, value: str) -> Setting:
    setting = db.query(Setting).filter(Setting.key == key).first()
    if setting is None:
        setting = Setting(key=key, value=value)
        db.add(setting)
    else:
        setting.value = value
    db.commit()
    db.refresh(setting)
    return setting


def get_active_prompt(db: Session) -> str:
    return get_setting(db, PROMPT_SETTING_KEY, DEFAULT_GENERATION_PROMPT)


def get_active_vision_prompt(db: Session) -> str:
    return get_setting(db, VISION_PROMPT_SETTING_KEY, DEFAULT_VISION_PROMPT)


def get_active_vision_model(db: Session) -> str:
    return get_setting(db, VISION_MODEL_SETTING_KEY, DEFAULT_VISION_MODEL)


# ---------------------------------------------------------------------------
# Vision layout — fired in the background on room-photo upload, never
# awaited by the upload response. A salesman input aid only, never sent to
# the image generation model.
# ---------------------------------------------------------------------------


async def run_vision_job(room_id: int) -> None:
    db = SessionLocal()
    try:
        room = db.query(Room).filter(Room.id == room_id).first()
        if room is None:
            return
        prompt = get_active_vision_prompt(db)
        model = get_active_vision_model(db)
        room_path = DATA_ROOT / room.photo_path
        try:
            data = room_path.read_bytes()
            mime_type, _ = mimetypes.guess_type(room_path.name)
            b64 = base64.b64encode(data).decode("ascii")

            def call_vision_api():
                return client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {
                                    "type": "image_url",
                                    "image_url": {"url": f"data:{mime_type or 'image/jpeg'};base64,{b64}"},
                                },
                            ],
                        }
                    ],
                    response_format={"type": "json_object"},
                )

            result = await asyncio.to_thread(call_vision_api)
            layout = json.loads(result.choices[0].message.content)
        except Exception:
            logger.exception("vision layout job failed room_id=%s", room_id)
            room.layout_status = "failed"
            db.commit()
            return

        room.layout_json = layout
        room.layout_status = "ready"
        db.commit()
    except Exception:
        logger.exception("vision layout job crashed room_id=%s", room_id)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Credits
# ---------------------------------------------------------------------------


def _clamp_day(year: int, month: int, day: int) -> int:
    return min(day, calendar.monthrange(year, month)[1])


def cycle_window(shop: Shop, now: datetime | None = None) -> tuple[datetime, datetime]:
    """Returns the [start, end) UTC window of the billing cycle containing
    `now`, based on the shop's cycle_start_day. Clamped to the last day of
    a short month (e.g. day 31 in February lands on the 28th/29th)."""
    now = now or datetime.now(timezone.utc)
    start_day_this_month = _clamp_day(now.year, now.month, shop.cycle_start_day)
    if now.day >= start_day_this_month:
        start_year, start_month = now.year, now.month
    else:
        start_month = now.month - 1 or 12
        start_year = now.year if now.month > 1 else now.year - 1
    start = datetime(start_year, start_month, _clamp_day(start_year, start_month, shop.cycle_start_day), tzinfo=timezone.utc)
    end_month = start_month + 1
    end_year = start_year
    if end_month > 12:
        end_month = 1
        end_year += 1
    end = datetime(end_year, end_month, _clamp_day(end_year, end_month, shop.cycle_start_day), tzinfo=timezone.utc)
    return start, end


def shop_balance(db: Session, shop: Shop, now: datetime | None = None) -> int:
    start, end = cycle_window(shop, now)
    total = db.query(func.coalesce(func.sum(CreditLedger.delta), 0)).filter(
        CreditLedger.shop_id == shop.id,
        CreditLedger.created_at >= start,
        CreditLedger.created_at < end,
    ).scalar()
    return int(total or 0)


def compute_usd_cost(usage: dict | None) -> float | None:
    if not usage:
        return None
    in_details = usage.get("input_tokens_details") or {}
    out_details = usage.get("output_tokens_details") or {}
    image_in = in_details.get("image_tokens", 0) or 0
    text_in = in_details.get("text_tokens", 0) or 0
    image_out = out_details.get("image_tokens", 0) or 0
    cost = (image_in * IMAGE_INPUT_RATE_PER_M + text_in * TEXT_INPUT_RATE_PER_M) / 1_000_000
    cost += (image_out * IMAGE_OUTPUT_RATE_PER_M) / 1_000_000
    return round(cost, 6)


CONFIG_NOTES_BLOCK_RE = re.compile(r"\{\{#CONFIG_NOTES\}\}(.*?)\{\{/CONFIG_NOTES\}\}", re.DOTALL)

# Definitions for {{CONFIG_NOTES}}, keyed by (category, type) since "Single"
# means different things for a Chair and a Bed. Only types with an entry
# here ever produce a note; "3+2+1" isn't a selectable type yet but is kept
# for when it is.
CONFIG_NOTES = {
    ("Sofa", "3+2"): "A set of two separate sofas: one three-seater with exactly three seat cushions and three back cushions, and one two-seater with exactly two seat cushions and two back cushions, placed as a pair around the same coffee table, usually at right angles or facing each other. Not one continuous sofa.",
    ("Sofa", "3+3"): "A set of two separate three-seater sofas, each with exactly three seat cushions and three back cushions, placed as a pair, usually facing each other or at right angles. Not one continuous sofa.",
    ("Sofa", "3+2+1"): "A set of three separate pieces: a three-seater sofa with exactly three seat cushions and three back cushions, a two-seater sofa with exactly two seat cushions and two back cushions, and a single armchair with exactly one seat cushion and one back cushion.",
    ("Sofa", "1-seater"): "One single-seat sofa / armchair with exactly one seat cushion and one back cushion. If the reference photograph shows more, rebuild it as a single seat in the same design. A single piece.",
    ("Sofa", "2-seater"): "One straight sofa with exactly two seat cushions side by side and two back cushions. If the reference photograph shows a different number, add or remove matching cushions and lengthen or shorten the frame. Never keep the photograph's seat count. A single piece, not a set.",
    ("Sofa", "3-seater"): "One straight sofa with exactly three seat cushions side by side and three back cushions. If the reference photograph shows a different number, add or remove matching cushions and lengthen or shorten the frame. Never keep the photograph's seat count. A single piece, not a set.",
    ("Sofa", "4-seater"): "One straight sofa with exactly four seat cushions side by side and four back cushions. If the reference photograph shows a different number, add or remove matching cushions and lengthen or shorten the frame. Never keep the photograph's seat count. A single piece, not a set.",
    ("Sofa", "5-seater"): "One straight sofa with exactly five seat cushions side by side and five back cushions. If the reference photograph shows a different number, add or remove matching cushions and lengthen or shorten the frame. Never keep the photograph's seat count. A single piece, not a set.",
    ("Sofa", "L-shape"): "One continuous sectional sofa with a single right-angle turn forming an L. A single piece, not a set.",
    ("Sofa", "Corner"): "One corner sofa with a square corner and a backrest on BOTH arms, hand-rests at both ends. Not curved, no chaise lounge. A single piece.",
    ("Sofa", "Curved"): "One continuous sofa with a gently curved, arcing back rather than straight sections. A single piece.",
    ("Dining table", "4 seater"): "A dining table with four chairs around it.",
    ("Dining table", "6 seater"): "A dining table with six chairs around it.",
    ("Dining table", "8 seater"): "A long dining table with eight chairs around it.",
    ("Bed", "Single"): "A single bed.",
    ("Bed", "Queen"): "A queen size double bed.",
    ("Bed", "King"): "A king size double bed.",
    ("Chair", "Pair"): "Two matching chairs.",
}
MULTI_PIECE_SOFA_TYPES = {"3+2", "3+3", "3+2+1"}
MULTI_PIECE_WIDTH_NOTE = "The stated width refers to the largest single sofa in the set, not the combined width of all pieces."
SEAT_COUNT_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}


def seat_count_word(n: int) -> str:
    return SEAT_COUNT_WORDS.get(n, str(n))


def multi_piece_segments(type_: str) -> list[int] | None:
    """Parses a multi-piece type string like "3+2" into per-sofa seat
    counts, e.g. [3, 2]. Returns None if it isn't a valid "n+n[+n]" string."""
    parts = type_.split("+")
    if len(parts) < 2:
        return None
    segments = []
    for part in parts:
        part = part.strip()
        if not part.isdigit() or int(part) <= 0:
            return None
        segments.append(int(part))
    return segments


def compute_sub_pieces(item: Item) -> list[dict]:
    """The stable, zero-based breakdown of placeable sub-pieces for an item:
    one entry per physical piece a salesman can place a block for. A
    multi-piece sofa (e.g. "3+2") splits into one rect entry per sofa,
    each sized from the item's stated width_ft in proportion to its seat
    count against the largest segment (see MULTI_PIECE_WIDTH_NOTE — the
    stated width is that largest sofa's width, not the combined width).
    Everything else — including L-shape and Curved sofas — is a single
    entry labelled by the item's own type."""
    if item.category == "Sofa" and item.type in MULTI_PIECE_SOFA_TYPES:
        segments = multi_piece_segments(item.type)
        if segments:
            per_seat_width = item.width_ft / max(segments)
            return [
                {
                    "sub_index": i,
                    "label": f"{seats}-seater",
                    "shape": "rect",
                    "width_ft": float(round(per_seat_width * seats)),
                }
                for i, seats in enumerate(segments)
            ]
    return [{"sub_index": 0, "label": item.type, "shape": item.shape, "width_ft": item.width_ft}]


def build_image_manifest(items: list[Item]) -> str:
    """One line per image, in the exact order sent to the model — the whole
    point being that the numbering here always matches reality: the clean
    room photo, then each product photo in the order pieces were added.
    Product lines describe the photo as a design reference only (material,
    colour, texture, styling), never as already being in the requested
    configuration — otherwise the model copies the photographed seat count
    instead of building what was actually asked for."""
    lines = ["Image 1 is a room."]
    n = 2
    first_image_for_photo: dict[str, int] = {}
    for item in items:
        earlier = first_image_for_photo.get(item.photo_path)
        if earlier is not None:
            lines.append(
                f"Image {n} is the same showroom photograph as Image {earlier}, used for another "
                "piece of the same design."
            )
            n += 1
            continue
        first_image_for_photo[item.photo_path] = n
        lines.append(
            f"Image {n} is a showroom photograph of a {item.category.lower()}. It is a design "
            "reference for material, colour, texture and styling only — the requested "
            "configuration and size are stated below and may differ from what this photograph shows."
        )
        n += 1
    return "\n".join(lines)


CONFIG_NOTES_PREAMBLE = (
    "Build each piece in the configuration stated below, taking only the "
    "design language from its reference photograph. Where the photograph "
    "shows a different number of seats, sections or pieces, follow the "
    "written configuration and extend or rebuild the design accordingly."
)


def build_config_notes(items: list[Item]) -> str:
    """Definitions only for configurations actually present among items —
    e.g. what "3+3" or "L-shape" means — so the prompt never explains
    configurations that aren't in play."""
    lines = []
    seen = set()
    has_multi_piece_sofa = False
    for item in items:
        key = (item.category, item.type)
        if key in CONFIG_NOTES and key not in seen:
            seen.add(key)
            lines.append(f"{item.type} — {CONFIG_NOTES[key]}")
        if item.category == "Sofa" and item.type in MULTI_PIECE_SOFA_TYPES:
            has_multi_piece_sofa = True
    if has_multi_piece_sofa:
        lines.append(MULTI_PIECE_WIDTH_NOTE)
    if not lines:
        return ""
    return "\n".join([CONFIG_NOTES_PREAMBLE, *lines])


# ---------------------------------------------------------------------------
# {{PLACEMENT}} — converts each item's block placement (see validate_placement
# above) into plain-English placement instructions. A block's WALL is
# resolved from its rotation-implied "back edge": rotation 0 means the back
# is the top edge (against the far wall if within WALL_TOLERANCE), 90 the
# left edge, 180 the bottom edge (near wall), 270 the right edge. This is
# deterministic even for a block sitting in a corner near two walls at once,
# since only the back edge's wall is ever tested.
# ---------------------------------------------------------------------------

WALL_TOLERANCE = 0.06
WALL_FOR_ROTATION = {0: "far", 90: "left", 180: "near", 270: "right"}
FACING_FOR_ROTATION = {
    0: "toward the camera",
    90: "right, into the room",
    180: "toward the far wall",
    270: "left, into the room",
}
WALL_LAYOUT_KEY = {"far": "far_wall", "left": "left_wall", "right": "right_wall", "near": "near_wall"}
NO_PLACEMENT_LINE = "Place the furniture where a professional interior stylist would position it in this room."


def _third_index(value: float) -> int:
    if value < 1 / 3:
        return 0
    if value < 2 / 3:
        return 1
    return 2


def _rect_back_edge_distance(rect: dict, candidate_wall: str) -> float:
    if candidate_wall == "far":
        return rect["y"]
    if candidate_wall == "near":
        return 1 - (rect["y"] + rect["h"])
    if candidate_wall == "left":
        return rect["x"]
    return 1 - (rect["x"] + rect["w"])  # "right"


def resolve_rect_wall(rect: dict) -> tuple[str | None, str]:
    """Returns (wall_if_against, rotation_implied_candidate_wall)."""
    candidate = WALL_FOR_ROTATION[rect["rotation"]]
    against = _rect_back_edge_distance(rect, candidate) <= WALL_TOLERANCE
    return (candidate if against else None), candidate


def resolve_free_area(rect: dict) -> str:
    x_label = ("left", "centre", "right")[_third_index(rect["x"] + rect["w"] / 2)]
    y_label = ("far", "middle", "near")[_third_index(rect["y"] + rect["h"] / 2)]
    if y_label == "middle" and x_label == "centre":
        return "the centre of the room"
    if y_label == "middle":
        return f"the {x_label} of the room"
    if x_label == "centre":
        return f"the {y_label} end of the room"
    return f"the {y_label}-{x_label} of the room"


def _rect_span(rect: dict, wall: str) -> tuple[float, float]:
    if wall in ("far", "near"):
        return rect["x"], rect["x"] + rect["w"]
    return rect["y"], rect["y"] + rect["h"]


def _occupied_thirds(start: float, end: float) -> set[int]:
    indices = {_third_index(start), _third_index(end)}
    if end > start:
        indices.add(_third_index((start + end) / 2))
    return indices


FRACTION_WORDS = (
    (0.1, "a tenth"), (0.2, "a fifth"), (0.25, "a quarter"), (1 / 3, "a third"), (0.4, "two-fifths"),
    (0.5, "half"), (0.6, "three-fifths"), (2 / 3, "two-thirds"), (0.7, "seven-tenths"),
    (0.75, "three-quarters"), (0.8, "four-fifths"), (0.9, "nine-tenths"),
)
EDGE_TOLERANCE = 0.05  # closer than this to a wall reads as "at" that wall, not a fraction
CENTRED_TOLERANCE = 0.08
CORNER_CLEARANCE = 0.08
NEAR_CORNER_CLEARANCE = 0.15
FAR_GAP_THRESHOLD = 0.1
EMPTY_FOREGROUND_THRESHOLD = 0.15
DOORWAY_TYPES = {"door", "doorway"}
# The direction an L's short arm leaves its long arm: always the way the long arm's seats face.
RUN_DIRECTION = {0: "toward the camera", 90: "right", 180: "toward the far wall", 270: "left"}
DOORWAY_NEGATION = "It is NOT beside the doorway. Clear, empty wall stays visible between its end and the corner."


def _fraction_word(value: float) -> str:
    return min(FRACTION_WORDS, key=lambda fw: abs(fw[0] - value))[1]


def _span_sentence(subject: str, wall: str, start: float, end: float, on_wall: bool = True) -> str:
    """Where along `wall` a piece starts and stops. Far/near walls are measured
    from the left wall; side walls from the far wall toward the camera."""
    if wall in ("far", "near"):
        if abs((start + end) / 2 - 0.5) < CENTRED_TOLERANCE:
            if not on_wall:
                return f"{subject} is CENTRED between the left and right walls."
            return f"{subject} is CENTRED on the {wall} wall: its middle lines up with the MIDDLE of the {wall} wall."
        origin, first_wall, last_wall, joiner = "from the left wall", "the left wall", "the right wall", " and"
    else:
        origin, first_wall, last_wall, joiner = "from the far wall toward the camera", "the far wall", "the near wall", ", and"
    at_first = start <= EDGE_TOLERANCE
    starts = f"at {first_wall}" if at_first else f"about {_fraction_word(start)} of the way {origin}"
    if end >= 1 - EDGE_TOLERANCE:
        ends = f"at {last_wall}"
    else:
        ends = f"about {_fraction_word(end)} of the way" + (f" {origin}" if at_first else "")
    return f"{subject} starts {starts}{joiner} ends {ends}."


def _feature_thirds(position: object, wall: str) -> set[int]:
    """The thirds of `wall` a feature covers. Tolerant of free-text positions
    from the vision model, e.g. "centre, extending into the right third"."""
    text = str(position or "").lower()
    if wall in ("far", "near"):
        words = ((0, r"\bleft\b"), (1, r"\b(centre|center|middle)\b"), (2, r"\bright\b"))
    else:
        words = ((0, r"\bfar\b"), (1, r"\b(centre|center|middle)\b"), (2, r"\bnear\b"))
    found = {idx for idx, pattern in words if re.search(pattern, text)}
    if re.search(r"\b(full|whole|entire)\b", text):
        return {0, 1, 2}
    return set(range(min(found), max(found) + 1)) if found else set()


def _wall_features(layout_json: dict | None, wall: str) -> list[dict]:
    return ((layout_json or {}).get(WALL_LAYOUT_KEY[wall]) or {}).get("features") or []


def _feature_clauses_for(wall: str, span: tuple[float, float], layout_json: dict | None) -> list[str]:
    start, end = span
    occupied = _occupied_thirds(start, end)
    clauses = []
    for feature in _wall_features(layout_json, wall):
        thirds = _feature_thirds(feature.get("position"), wall)
        if not thirds:
            continue
        label = _feature_label(feature)
        overlaps = start < (max(thirds) + 1) / 3 and end > min(thirds) / 3
        if overlaps and wall == "far" and feature.get("type") == "window":
            clauses.append("It stands in front of the window, below the sill.")
        elif overlaps:
            clauses.append(f"It does not obstruct the {label}.")
        elif min(abs(t - o) for t in thirds for o in occupied) == 1:
            clauses.append(f"It stops before reaching the {label}, leaving it fully visible.")
    return clauses


def _clear_of_adjacent_doorway(wall: str, start: float, end: float, layout_json: dict | None) -> bool:
    """True when a doorway sits on a neighbouring wall, at the end that meets
    this piece's wall, and the piece stops short of that corner."""
    if wall in ("far", "near"):
        door_third = 0 if wall == "far" else 2  # far/near end of the side wall
        ends = (("left", start), ("right", 1 - end))
    else:
        door_third = 0 if wall == "left" else 2  # left/right end of the far or near wall
        ends = (("far", start), ("near", 1 - end))
    for adjacent, gap in ends:
        if gap <= CORNER_CLEARANCE:
            continue
        for feature in _wall_features(layout_json, adjacent):
            if feature.get("type") in DOORWAY_TYPES and door_third in _feature_thirds(feature.get("position"), adjacent):
                return True
    return False


def _wall_negations(wall: str, start: float, end: float, layout_json: dict | None) -> list[str]:
    """The model's habit is to push pieces into corners and beside doors, so
    say what NOT to do whenever the plan shows otherwise."""
    out = []
    if start > CORNER_CLEARANCE and 1 - end > CORNER_CLEARANCE:
        out.append("It is NOT in a corner.")
    if wall in ("left", "right") and 1 - end > NEAR_CORNER_CLEARANCE:
        out.append("It is NOT in the corner nearest the camera.")
    if _clear_of_adjacent_doorway(wall, start, end, layout_json):
        out.append(DOORWAY_NEGATION)
    return out


def _centre_sentence(subject: str, rect: dict) -> str:
    cx = rect["x"] + rect["w"] / 2
    cy = rect["y"] + rect["h"] / 2
    return (
        f"{subject} middle is about {_fraction_word(cx)} of the way from the left wall and about "
        f"{_fraction_word(cy)} of the way from the far wall toward the camera."
    )


def _resolution(wall: str | None, span: tuple[float, float], sentence: str, rects: list[dict], layout_json: dict | None) -> dict:
    extras = []
    if wall:
        extras = _feature_clauses_for(wall, span, layout_json) + _wall_negations(wall, span[0], span[1], layout_json)
    return {
        "wall": wall,
        "sentence": sentence,
        "extras": extras,
        "span": span if wall else (None, None),
        "sort_key": span[0] if wall else None,
        "near_edge": max(r["y"] + r["h"] for r in rects),
    }


def resolve_rect_placement(rect: dict, layout_json: dict | None = None) -> dict:
    wall, _candidate = resolve_rect_wall(rect)
    facing = FACING_FOR_ROTATION[rect["rotation"]]
    if not wall:
        sentence = (
            f"It stands in {resolve_free_area(rect)}, clear of the walls. {_centre_sentence('Its', rect)} "
            f"Its seats face {facing}."
        )
        return _resolution(None, (0, 0), sentence, [rect], layout_json)
    start, end = _rect_span(rect, wall)
    parts = [f"It stands against the {wall} wall, back flat against that wall.", _span_sentence("It", wall, start, end)]
    if wall in ("left", "right") and start > FAR_GAP_THRESHOLD:
        parts.append("A stretch of empty floor stays between it and the far wall.")
    parts.append(f"Its seats face {facing}.")
    return _resolution(wall, (start, end), " ".join(parts), [rect], layout_json)


def resolve_l_placement(
    placement: dict,
    layout_json: dict | None = None,
    intro: str = "It is one L-shaped sofa.",
    bend_name: str = "The bend of the L",
) -> dict:
    """Describes an L (or corner sofa) from where its two arm boxes actually
    are. geometry.corner only says which end of the L the bend is on, so it
    is never used as a position in the room."""
    long_rect, short_rect = placement["long"], placement["short"]
    long_wall, along = resolve_rect_wall(long_rect)  # `along`: the wall the long arm runs parallel to
    side_wall = along in ("left", "right")
    start, end = _rect_span(long_rect, along)
    short_start, short_end = _rect_span(short_rect, along)

    if long_wall:
        parts = [intro, f"Its long arm stands against the {long_wall} wall, back flat against that wall."]
    else:
        parts = [intro, f"Its long arm stands in {resolve_free_area(long_rect)}, parallel to the {along} wall but clear of it."]
    parts.append(_span_sentence("The long arm", along, start, end, on_wall=long_wall is not None))
    if long_wall and side_wall and start > FAR_GAP_THRESHOLD:
        parts.append("A stretch of empty floor stays between it and the far wall.")

    bend_at_high_end = (short_start + short_end) / 2 > (start + end) / 2
    if side_wall:
        bend_end = "the end of the long arm nearest the camera" if bend_at_high_end else "the end of the long arm nearest the far wall"
    else:
        bend_end = "the right end of the long arm" if bend_at_high_end else "the left end of the long arm"
    parts.append(f"{bend_name} is at {bend_end}.")

    direction = RUN_DIRECTION[long_rect["rotation"]]
    if side_wall:
        # how far across the room the short arm reaches, measured from the long arm's own wall
        reach = short_rect["x"] + short_rect["w"] if along == "left" else 1 - short_rect["x"]
        measure = "width"
    else:
        reach = short_rect["y"] + short_rect["h"] if along == "far" else 1 - short_rect["y"]
        measure = "depth"
    if long_wall:
        parts.append(f"The short arm runs {direction} from the {along} wall to about {_fraction_word(reach)} of the room's {measure}.")
    else:
        parts.append(
            f"The short arm runs {direction} from the long arm, reaching about {_fraction_word(reach)} of the "
            f"room's {measure} measured from the {along} wall."
        )
    parts.append(f"Its seats face {FACING_FOR_ROTATION[short_rect['rotation']]}.")
    parts.append(f"The seats on the long arm face {FACING_FOR_ROTATION[long_rect['rotation']]}.")

    span = (min(start, short_start), max(end, short_end))
    return _resolution(long_wall, span, " ".join(parts), [long_rect, short_rect], layout_json)


def resolve_curved_placement(placement: dict, layout_json: dict | None = None) -> dict:
    """A curved sofa shares the L's {long, short} arm boxes but is one
    arc-backed piece. Its orientation comes from which sides the two arms'
    backs are on, and its position from where the boxes actually are."""
    long_rect, short_rect = placement["long"], placement["short"]
    long_wall, along = resolve_rect_wall(long_rect)
    backs = {WALL_FOR_ROTATION[long_rect["rotation"]], WALL_FOR_ROTATION[short_rect["rotation"]]}
    depth_word = "far" if "far" in backs else "near"
    side_word = "left" if "left" in backs else "right"
    opposite = f"{'near' if depth_word == 'far' else 'far'}-{'right' if side_word == 'left' else 'left'}"
    x0 = min(long_rect["x"], short_rect["x"])
    y0 = min(long_rect["y"], short_rect["y"])
    x1 = max(long_rect["x"] + long_rect["w"], short_rect["x"] + short_rect["w"])
    y1 = max(long_rect["y"] + long_rect["h"], short_rect["y"] + short_rect["h"])
    bbox = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
    parts = [
        f"It is one continuous curved sofa. Its back bulges toward the {depth_word}-{side_word} and its seats face "
        f"the opposite way, diagonally toward the {opposite}.",
        f"It stands in {resolve_free_area(bbox)}." if not long_wall else f"One end runs along the {long_wall} wall, close against it.",
        _centre_sentence("Its", bbox),
    ]
    span = _rect_span(bbox, along)
    return _resolution(long_wall, span, " ".join(parts), [long_rect, short_rect], layout_json)


def resolve_round_placement(rect: dict, layout_json: dict | None = None) -> dict:
    """A round piece (e.g. a round dining table) has no back to set against
    a wall and no single seat direction, so it's described by position only."""
    wall, _candidate = resolve_rect_wall(rect)
    if wall:
        start, end = _rect_span(rect, wall)
        sentence = f"It stands close to the {wall} wall. {_span_sentence('It', wall, start, end)}"
        return _resolution(wall, (start, end), sentence, [rect], layout_json)
    sentence = f"It stands in {resolve_free_area(rect)}, clear of the walls. {_centre_sentence('Its', rect)}"
    return _resolution(None, (0, 0), sentence, [rect], layout_json)


def _feature_label(feature: dict) -> str:
    feature_type = feature.get("type") or "feature"
    if feature_type in ("unknown", "other"):
        notes = (feature.get("notes") or "").strip()
        return notes if notes else "feature"
    return feature_type


def _format_piece_list(numbers: list[int]) -> str:
    labels = [str(n) for n in numbers]
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return ", ".join(labels[:-1]) + f" and {labels[-1]}"


SEATER_TYPE_RE = re.compile(r"^(\d+)-seater$")


def sofa_seat_count(category: str, label: str) -> int | None:
    """Seat count for a sofa whose type (or sub-piece label) is "N-seater";
    None for L-shape, Corner, Curved and every non-sofa item."""
    match = SEATER_TYPE_RE.match(label) if category == "Sofa" else None
    return int(match.group(1)) if match else None


def sofa_seat_description(seats: int) -> str:
    """Piece-header wording that makes the seat count countable, so the model
    builds that many cushions instead of copying the reference photograph."""
    if seats == 1:
        return "single-seat sofa with exactly ONE seat cushion and ONE back cushion"
    word = seat_count_word(seats)
    return f"{word}-seater sofa with exactly {word.upper()} seat cushions and {word.upper()} back cushions"


def flatten_placed_subpieces(items: list[Item]) -> list[dict]:
    """One record per placed sub-piece, in item order then sub_index order.
    Sub-pieces with no placement are left out entirely — {{PLACEMENT}} only
    describes what was actually placed, even though {{PIECES}} (see
    build_pieces_text) lists all of them. Sub-pieces of the same item share
    that item's Image number, since they come from one reference photo."""
    records = []
    for item_index, item in enumerate(items):
        image_number = item_index + 2  # Image 1 is the room; products follow in add order
        sub_pieces = {sp["sub_index"]: sp for sp in compute_sub_pieces(item)}
        is_split = len(sub_pieces) > 1
        placed_entries = sorted((item.placement or []), key=lambda e: e.get("sub_index", 0))
        for entry in placed_entries:
            sub_piece = sub_pieces.get(entry.get("sub_index"))
            if sub_piece is None or entry.get("geometry") is None:
                continue
            # split sub-pieces are labelled "N-seater", same as the straight sofa types
            seats = sofa_seat_count(item.category, sub_piece["label"] if is_split else item.type)
            if seats is not None:
                description = sofa_seat_description(seats)
            else:
                description = f"{item.category} ({item.type})"
            records.append(
                {
                    "item": item,
                    "image_number": image_number,
                    "shape": sub_piece["shape"],
                    "geometry": entry["geometry"],
                    "width_ft": sub_piece["width_ft"],
                    "description": description,
                    "is_split": is_split,
                }
            )
    return records


def build_placement_text(items: list[Item], layout_json: dict | None, ignore_placement: bool) -> str:
    records = flatten_placed_subpieces(items)
    if ignore_placement or not records:
        return NO_PLACEMENT_LINE + "\n"

    resolved = []
    for rec in records:
        if rec["shape"] == "L":
            resolved.append(resolve_l_placement(rec["geometry"], layout_json))
        elif rec["shape"] == "corner":
            resolved.append(
                resolve_l_placement(
                    rec["geometry"], layout_json, "It is one corner sofa with backrests along both arms.", "The corner of the sofa"
                )
            )
        elif rec["shape"] == "curved":
            resolved.append(resolve_curved_placement(rec["geometry"], layout_json))
        elif rec["shape"] == "round":
            resolved.append(resolve_round_placement(rec["geometry"], layout_json))
        else:
            resolved.append(resolve_rect_placement(rec["geometry"], layout_json))

    wall_groups: dict[str, list[int]] = {}
    for idx, r in enumerate(resolved):
        if r["wall"]:
            wall_groups.setdefault(r["wall"], []).append(idx)

    neighbour_clause: list[str | None] = [None] * len(records)
    for wall, idxs in wall_groups.items():
        ordered = sorted(idxs, key=lambda i: resolved[i]["sort_key"])
        for pos in range(1, len(ordered)):
            prev_piece_number = ordered[pos - 1] + 1
            if wall in ("far", "near"):
                neighbour_clause[ordered[pos]] = f"immediately to the right of Piece {prev_piece_number}, with a small gap between them."
            else:
                neighbour_clause[ordered[pos]] = f"beyond Piece {prev_piece_number}, toward the camera."

    lines: list[str] = []
    counter = 1
    item_groups: dict[int, dict] = {}
    for idx, rec in enumerate(records):
        piece_number = idx + 1
        group = item_groups.setdefault(
            rec["item"].id, {"image_number": rec["image_number"], "is_split": rec["is_split"], "piece_numbers": []}
        )
        group["piece_numbers"].append(piece_number)
        lines.append(f"Piece {piece_number} — {rec['description']}, {rec['width_ft']:g} ft, from Image {rec['image_number']}.")
        lines.append(f"{counter}. {resolved[idx]['sentence']}")
        counter += 1
        extra_parts = []
        if neighbour_clause[idx]:
            extra_parts.append(neighbour_clause[idx])
        extra_parts.extend(resolved[idx]["extras"])
        if extra_parts:
            combined = " ".join(extra_parts)
            combined = combined[0].upper() + combined[1:]
            lines.append(f"{counter}. {combined}")
            counter += 1
        lines.append("")

    for wall, idxs in wall_groups.items():
        if len(idxs) < 2:
            continue
        ordered = sorted(idxs, key=lambda i: resolved[i]["sort_key"])
        piece_numbers = [i + 1 for i in ordered]
        order_word = "left to right" if wall in ("far", "near") else "far to near"
        lines.append(
            f"{counter}. Pieces {_format_piece_list(piece_numbers)} stand in that order from {order_word} "
            f"along the {wall} wall. They are separate pieces of furniture with gaps between them, not one "
            "continuous sofa."
        )
        counter += 1

    for group in item_groups.values():
        if group["is_split"] and len(group["piece_numbers"]) >= 2:
            lines.append(
                f"{counter}. Pieces {_format_piece_list(group['piece_numbers'])} are separate sofas belonging "
                f"to one set. They share the same design from Image {group['image_number']} and must match "
                "each other exactly."
            )
            counter += 1

    photo_groups: dict[str, dict] = {}
    for idx, rec in enumerate(records):
        pg = photo_groups.setdefault(
            rec["item"].photo_path, {"image_number": rec["image_number"], "item_ids": set(), "piece_numbers": []}
        )
        pg["item_ids"].add(rec["item"].id)
        pg["piece_numbers"].append(idx + 1)
    for pg in photo_groups.values():
        if len(pg["item_ids"]) >= 2:
            lines.append(
                f"{counter}. Pieces {_format_piece_list(pg['piece_numbers'])} are separate pieces of furniture "
                f"of the same design from Image {pg['image_number']} and must match each other exactly."
            )
            counter += 1

    if len({rec["item"].photo_path for rec in records}) >= 2:
        lines.append(
            f"{counter}. Pieces from different reference photographs must clearly differ in material and "
            "colour, exactly as those photographs show."
        )
        counter += 1

    lines.append(f"{counter}. The rest of the floor stays open and empty.")
    counter += 1

    foreground = 1 - max(r["near_edge"] for r in resolved)
    if foreground >= EMPTY_FOREGROUND_THRESHOLD:
        lines.append(
            f"{counter}. Between the furniture and the camera, the nearest {_fraction_word(foreground).removeprefix('a ')} of the "
            "floor stays completely empty. No piece reaches the bottom edge of the frame."
        )

    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# {{ROOM_LAYOUT}} — a compact, confident summary of the vision-generated
# layout (see run_vision_job), for placement context only. Built-in features
# are always described as present and finished; never mentions protective
# coverings (the main prompt's CLEAR THE SPACE section handles that).
# ---------------------------------------------------------------------------


def _feature_phrase(feature: dict) -> str:
    feature_type = feature.get("type") or "feature"
    if feature_type in ("unknown", "other"):
        notes = (feature.get("notes") or "").strip()
        return notes if notes else "a built-in feature"
    parts = [p for p in (feature.get("size"), feature_type) if p]
    phrase = "a " + " ".join(parts)
    position = feature.get("position")
    return f"{phrase} at the {position}" if position else phrase


def _wall_features_clause(wall_data: dict | None) -> str:
    features = (wall_data or {}).get("features") or []
    if not features:
        return "a long plain wall"
    phrases = [_feature_phrase(f) for f in features]
    if len(phrases) == 1:
        return f"with {phrases[0]}"
    return "with " + ", ".join(phrases[:-1]) + f" and {phrases[-1]}"


def _obstruction_phrase(obstruction: dict) -> str:
    obstruction_type = obstruction.get("type") or "obstruction"
    location = (obstruction.get("location") or "").strip().rstrip(".")
    if not location:
        return f"a {obstruction_type}"
    return f"a {obstruction_type} {location[0].lower()}{location[1:]}"


def build_room_layout_text(layout_json: dict | None) -> str:
    if not layout_json:
        return "For placement purposes only, the camera stands at the near end of the room.\n"

    far_clause = _wall_features_clause(layout_json.get("far_wall"))
    left_clause = _wall_features_clause(layout_json.get("left_wall"))
    right_clause = _wall_features_clause(layout_json.get("right_wall"))

    lines = [
        f"The room is {layout_json.get('depth_vs_width') or 'about square'}.",
        f"Far wall: {far_clause}.",
        f"Left wall: {left_clause}.",
        f"Right wall: {right_clause}.",
    ]
    # obstructions stand anywhere in the room, so they get their own line
    # rather than being attached to a wall they may not be on
    obstructions = layout_json.get("obstructions") or []
    if obstructions:
        lines.append("Obstructions: " + "; ".join(_obstruction_phrase(o) for o in obstructions) + ".")
    lines.append(
        f"For placement purposes only, the camera stands at the {layout_json.get('camera_position') or 'near end of the room'}."
    )
    return "\n".join(lines) + "\n"


def build_pieces_text(items: list[Item]) -> str:
    """Lists every placeable sub-piece, not the parent item — a "3+2" sofa
    lists its three-seater and two-seater separately, each with its own
    estimated width, regardless of whether either has been placed yet."""
    lines = []
    for item in items:
        sub_pieces = compute_sub_pieces(item)
        if len(sub_pieces) > 1:
            for sp in sub_pieces:
                lines.append(f"- {item.category} ({sp['label']}), {sp['width_ft']:g} ft wide")
        else:
            lines.append(f"- {item.category} ({item.type}), {item.width_ft:g} ft wide")
    return "\n".join(lines)


def build_prompt(
    template: str,
    room: Room,
    items: list[Item],
    room_treatment: str,
    lighting: str,
    ignore_placement: bool,
    placement_text: str | None = None,
) -> str:
    """`placement_text`, when given, is the placement writer's section and
    replaces the generated facts in {{PLACEMENT}}."""
    pieces = build_pieces_text(items)
    image_manifest = build_image_manifest(items)
    config_notes = build_config_notes(items)
    if placement_text is None:
        placement_text = build_placement_text(items, room.layout_json, ignore_placement)
    room_layout_text = build_room_layout_text(room.layout_json)
    room_treatment_text = ROOM_TREATMENT_TEXT.get(room_treatment, ROOM_TREATMENT_TEXT[DEFAULT_ROOM_TREATMENT])
    lighting_text = LIGHTING_TEXT.get(lighting, LIGHTING_TEXT[DEFAULT_LIGHTING])

    if config_notes:
        def unwrap_config_notes(match: re.Match) -> str:
            return match.group(1).replace("{{CONFIG_NOTES}}", config_notes)

        template = CONFIG_NOTES_BLOCK_RE.sub(unwrap_config_notes, template)
    else:
        template = CONFIG_NOTES_BLOCK_RE.sub("", template)

    prompt = (
        template.replace("{{ROOM_TYPE}}", room.room_type)
        .replace("{{PIECES}}", pieces)
        .replace("{{IMAGE_MANIFEST}}", image_manifest)
        .replace("{{CONFIG_NOTES}}", config_notes)  # covers bare (unwrapped) use too
        .replace("{{PLACEMENT}}", placement_text)
        .replace("{{ROOM_LAYOUT}}", room_layout_text)
        .replace("{{ROOM_TREATMENT}}", room_treatment_text)
        .replace("{{LIGHTING}}", lighting_text)
    )
    return re.sub(r"\n{3,}", "\n\n", prompt).rstrip() + "\n"


def call_image_api(
    prompt: str,
    image_files: list[tuple[str, bytes, str]],
    size: str,
    quality: str,
    log_label: str,
) -> dict:
    """Calls OpenAI's Image API edit endpoint with retry on rate limits,
    content-policy/bad-request failures and empty responses. Runs
    synchronously — callers should offload to a thread. On success, prints
    one stdout line with quality/size/input-image-count/elapsed time and
    the full token usage object, for cost tracking from Render logs, and
    returns {"image_bytes", "elapsed_s", "usage"} so callers (the debug
    view) can persist the same numbers."""
    for attempt in range(GENERATION_RETRIES + 1):
        start = time.monotonic()
        try:
            result = client.images.edit(
                model=MODEL_NAME,
                image=image_files,
                prompt=prompt,
                size=size,
                quality=quality,
                n=1,
            )
        except RateLimitError as exc:
            elapsed_s = time.monotonic() - start
            logger.info("gen label=%s attempt=%d elapsed_s=%.1f result=rate_limited", log_label, attempt, elapsed_s)
            if attempt < GENERATION_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            raise GenerationError("The service is a little busy right now. Please try again in a moment.")
        except BadRequestError as exc:
            elapsed_s = time.monotonic() - start
            logger.info(
                "gen label=%s attempt=%d elapsed_s=%.1f result=blocked:%s",
                log_label, attempt, elapsed_s, exc.code or exc.type,
            )
            if attempt < GENERATION_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            raise GenerationError("We couldn't generate a result for those photos. Try a different angle or photo.")
        except Exception as exc:
            elapsed_s = time.monotonic() - start
            logger.info(
                "gen label=%s attempt=%d elapsed_s=%.1f result=exception:%s",
                log_label, attempt, elapsed_s, exc.__class__.__name__,
            )
            raise GenerationError("Something went wrong generating your image. Please try again.")

        elapsed_s = time.monotonic() - start
        image_bytes = extract_image_from_result(result)
        if image_bytes is None:
            logger.info("gen label=%s attempt=%d elapsed_s=%.1f result=empty_response", log_label, attempt, elapsed_s)
            if attempt < GENERATION_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            raise GenerationError("That attempt didn't produce an image. Please try again.")

        usage = result.usage.model_dump() if result.usage else None
        print(
            f"gpt-image-2 generation label={log_label} quality={quality} size={size} "
            f"input_images={len(image_files)} elapsed_s={elapsed_s:.1f} usage={usage}",
            flush=True,
        )
        logger.info("gen label=%s attempt=%d elapsed_s=%.1f result=success", log_label, attempt, elapsed_s)
        return {"image_bytes": image_bytes, "elapsed_s": elapsed_s, "usage": usage}

    raise GenerationError("Something went wrong generating your image. Please try again.")


def error_response(status_code: int, error: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error, "message": message})


# ---------------------------------------------------------------------------
# PLACEMENT WRITER — a vision model rewrites the generated placement facts
# into instructions the image model follows better, by looking at the room
# photo and the salesman's floor plan (a PNG exported by the client). It
# starts when the salesman leaves the plan screen and its result is cached
# on the attempt; generation waits briefly for it and otherwise falls back,
# silently, to the facts themselves. The plan PNG only ever goes to this
# writer, never to the image model.
# ---------------------------------------------------------------------------

PLACEMENT_WRITER_ENABLED_KEY = "placement_writer_enabled"
PLACEMENT_WRITER_PROMPT_KEY = "placement_writer_prompt"
PLACEMENT_WRITER_WAIT_SECONDS = 45  # how long Generate waits for a writer that is still running
PLACEMENT_WRITER_CALL_TIMEOUT = 90  # hard limit on the model call itself
FACTS_TOKEN = "{{FACTS}}"
# Dollars per 1M tokens for the default vision model (gpt-6-luna), as listed
# by third-party pricing pages in Oct 2026. Only used for the cost logged
# beside a generation; wrong if settings.vision_model is changed.
VISION_INPUT_RATE_PER_M = 0.10
VISION_OUTPUT_RATE_PER_M = 0.50

DEFAULT_PLACEMENT_WRITER_PROMPT = """\
You write furniture placement instructions for an image generator.

INPUTS
- Image 1: a photograph of a room. The generator will add furniture into exactly this photograph.
- Image 2: a top-down floor plan of the same room, drawn by a salesman. Top edge = far wall, bottom edge = near wall, the circle below the bottom edge = where Image 1 was photographed from. Wall features are coloured segments on the walls with capital labels such as DOOR, WINDOW, OPENING or PILLAR; numbered labels (DOOR 1, DOOR 2) mean there are several; a label ending in "?" is uncertain. Find each labelled feature in Image 1. Each piece of furniture is a coloured block with its number in a circle. Thick solid bars on a block are its backrest and arms; seats face away from the backrest. Labels like "LOUNGE" name a part of a piece.
- PLACEMENT FACTS below: generated from the same plan. They are correct. Treat them and the plan as the authority on where each piece goes. Never move, add, remove or resize a piece.

YOUR JOB
The generator cannot see the plan and does not understand feet or fractions well. Left to itself it tends to push furniture into corners, beside doors and away from windows, to slide pieces sideways so they line up, and to build L-shaped sofas with the chaise or lounge at the end nearest the camera. Rewrite the facts so that it follows the plan instead of those habits.

RULES
1. Keep every "Piece N — ..." header line exactly as given, including "from Image k". In those headers "Image k" refers to the generator's product photographs, NOT to your Image 2 floor plan. Under each header, write numbered lines; numbering continues across pieces.
2. One fact per line. Never pack several facts into one line.
3. Anchor every position to something VISIBLE in Image 1: a labelled door or window and its edges, a corner, the sill, the bottom edge of the frame. Also say where it appears in the frame: left/right side, higher (further away) or lower (closer).
4. Describe BOTH ends of every piece: where each end is, and what is or is not at each end.
5. For each piece, find the habit above that would most likely move it away from where the plan puts it in this photo, and rule that out with a line starting "NOT". A NOT line must never forbid something the plan actually shows — if the plan agrees with a habit, do not mention that habit.
6. Use CAPS only for the single key word in a line: CENTRED, FAR, NEAR, LEFT, RIGHT, NOT.
7. For multi-part pieces (L-shape, corner, curved), say which part is where, which way each part's back and seats face, and which end of the piece is plain.
8. When two pieces overlap side to side on the plan, say which one stands IN FRONT (nearer the camera, lower in the frame) and which stands BEHIND, and that neither slides sideways to make room for the other.
9. Every labelled DOOR, WINDOW and OPENING must stay fully visible and usable in the result; say so for any that a piece stands near.
10. Keep any line saying pieces from different reference photographs must differ in material and colour.
11. Finish with numbered lines saying which floor areas stay empty, especially between the furniture and the camera.
12. Never describe the camera or ask to change the view.
13. If the plan and the photo disagree (a block over a door, a labelled feature you cannot find in Image 1), follow the plan and note it under CONFLICTS.

OUTPUT
Only the placement section, then a line "CONFLICTS", then a list (or "none"). Nothing before the first "Piece" line.

PLACEMENT FACTS
{{FACTS}}
"""

# attempt_id -> the writer task currently running for it (same process only,
# like JOBS), so Generate can wait for one that hasn't finished yet.
WRITER_TASKS: dict[int, asyncio.Task] = {}


def placement_writer_enabled(db: Session) -> bool:
    return get_setting(db, PLACEMENT_WRITER_ENABLED_KEY, "true").strip().lower() == "true"


def get_placement_writer_prompt(db: Session) -> str:
    return get_setting(db, PLACEMENT_WRITER_PROMPT_KEY, DEFAULT_PLACEMENT_WRITER_PROMPT)


def writer_signature(facts: str, layout_json: dict | None, prompt: str, model: str) -> str:
    """Identifies exactly what a writer result was written for. Any change to
    the placed blocks, the room's features, the prompt or the model changes
    it, so a stale result can never be used."""
    payload = json.dumps([facts, layout_json, prompt, model], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _piece_headers(lines: list[str]) -> list[str]:
    return [line.rstrip() for line in lines if line.startswith("Piece ")]


def parse_writer_output(facts: str, output: str) -> dict:
    """Splits the writer's reply into the placement section and its CONFLICTS
    list, and validates the section: every "Piece N — ..." header from the
    facts must appear unchanged and in the same order, and no other line may
    start with "Piece ". Returns {ok, reason, placement, conflicts}."""
    lines = (output or "").replace("\r\n", "\n").split("\n")
    conflicts_at = next((i for i, line in enumerate(lines) if line.strip().rstrip(":").strip() == "CONFLICTS"), None)
    body = lines if conflicts_at is None else lines[:conflicts_at]
    conflicts = "" if conflicts_at is None else "\n".join(lines[conflicts_at + 1 :]).strip()

    expected = _piece_headers(facts.split("\n"))
    got = _piece_headers(body)
    if got != expected:
        missing = [h for h in expected if h not in got]
        extra = [h for h in got if h not in expected]
        if missing:
            reason = f"validation failed: header missing or changed: {missing[0]!r}"
        elif extra:
            reason = f"validation failed: unexpected line starting with 'Piece ': {extra[0]!r}"
        else:
            reason = "validation failed: piece headers repeated or out of order"
        return {"ok": False, "reason": reason, "placement": None, "conflicts": conflicts}

    first = next(i for i, line in enumerate(body) if line.startswith("Piece "))
    placement = "\n".join(body[first:]).strip() + "\n"
    return {"ok": True, "reason": None, "placement": placement, "conflicts": conflicts}


def call_placement_writer(room_photo: bytes, room_mime: str, plan_png: bytes, prompt: str, model: str) -> dict:
    """One writer call: Image 1 = the room photo, Image 2 = the plan PNG.
    Synchronous — callers offload it to a thread."""

    def image_part(data: bytes, mime: str) -> dict:
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}}

    start = time.monotonic()
    result = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}, image_part(room_photo, room_mime), image_part(plan_png, "image/png")],
            }
        ],
        timeout=PLACEMENT_WRITER_CALL_TIMEOUT,
    )
    return {
        "output": result.choices[0].message.content or "",
        "usage": result.usage.model_dump() if result.usage else None,
        "elapsed_s": round(time.monotonic() - start, 1),
    }


def writer_usd_cost(prompt_tokens: int, completion_tokens: int) -> float:
    return round((prompt_tokens * VISION_INPUT_RATE_PER_M + completion_tokens * VISION_OUTPUT_RATE_PER_M) / 1_000_000, 6)


def _with_writer_spend(unlogged: dict | None, usage: dict | None) -> dict | None:
    """Adds one call's tokens to the attempt's not-yet-logged writer spend
    (logged, then cleared, by the next successful generation)."""
    if not usage:
        return unlogged
    prev = unlogged or {}
    return {
        "calls": prev.get("calls", 0) + 1,
        "prompt_tokens": prev.get("prompt_tokens", 0) + (usage.get("prompt_tokens") or 0),
        "completion_tokens": prev.get("completion_tokens", 0) + (usage.get("completion_tokens") or 0),
    }


def discard_placement_writer(attempt: Attempt) -> None:
    """Drops the cached writer result (and orphans any call still running)
    because the plan changed. Keeps the not-yet-logged spend."""
    unlogged = (attempt.placement_writer or {}).get("unlogged_usage")
    attempt.placement_writer = {"unlogged_usage": unlogged} if unlogged else None


async def run_placement_writer(attempt_id: int, signature: str) -> None:
    db = SessionLocal()
    try:
        attempt = db.query(Attempt).filter(Attempt.id == attempt_id).first()
        state = (attempt.placement_writer or {}) if attempt else {}
        if state.get("signature") != signature:
            return
        prompt = get_placement_writer_prompt(db).replace(FACTS_TOKEN, state["facts"])
        outcome: dict
        usage = None
        try:
            room_path = DATA_ROOT / attempt.room.photo_path
            room_mime, _ = mimetypes.guess_type(room_path.name)
            result = await asyncio.to_thread(
                call_placement_writer,
                room_path.read_bytes(),
                room_mime or "image/jpeg",
                (DATA_ROOT / state["plan_path"]).read_bytes(),
                prompt,
                state["model"],
            )
        except Exception as exc:
            logger.exception("placement writer call failed attempt_id=%s", attempt_id)
            outcome = {"status": "failed", "ok": False, "reason": f"writer call failed: {exc.__class__.__name__}"}
        else:
            usage = result["usage"]
            parsed = parse_writer_output(state["facts"], result["output"])
            outcome = {
                "status": "done",
                "ok": parsed["ok"],
                "reason": parsed["reason"],
                "output": result["output"],
                "placement": parsed["placement"],
                "conflicts": parsed["conflicts"],
                "usage": usage,
                "elapsed_s": result["elapsed_s"],
            }

        db.refresh(attempt)
        current = attempt.placement_writer or {}
        unlogged = _with_writer_spend(current.get("unlogged_usage"), usage)
        if current.get("signature") != signature:
            # the plan changed while this ran: the result is useless, the spend is real
            attempt.placement_writer = {**current, "unlogged_usage": unlogged} if (current or unlogged) else None
        else:
            attempt.placement_writer = {**current, **outcome, "unlogged_usage": unlogged}
        db.commit()
    except Exception:
        logger.exception("placement writer job crashed attempt_id=%s", attempt_id)
    finally:
        db.close()


def start_placement_writer(attempt: Attempt, plan_path: str | None, db: Session) -> str:
    """Starts the writer for the attempt's current plan unless an identical
    run is already cached or in flight. `plan_path` is a freshly uploaded
    plan image, or None to reuse the stored one. Returns what happened."""
    if not placement_writer_enabled(db):
        return "disabled"
    if not flatten_placed_subpieces(attempt.items):
        return "no_placement"
    plan_path = plan_path or attempt.plan_path
    if not plan_path:
        return "no_plan"
    facts = build_placement_text(attempt.items, attempt.room.layout_json, False)
    model = get_active_vision_model(db)
    signature = writer_signature(facts, attempt.room.layout_json, get_placement_writer_prompt(db), model)
    state = attempt.placement_writer or {}
    task = WRITER_TASKS.get(attempt.id)
    if state.get("signature") == signature and (
        state.get("status") == "done" or (state.get("status") == "running" and task is not None and not task.done())
    ):
        return "cached"

    attempt.plan_path = plan_path
    attempt.placement_writer = {
        "status": "running",
        "signature": signature,
        "facts": facts,
        "model": model,
        "plan_path": plan_path,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "unlogged_usage": state.get("unlogged_usage"),
    }
    db.commit()
    task = asyncio.create_task(run_placement_writer(attempt.id, signature))
    WRITER_TASKS[attempt.id] = task
    task.add_done_callback(lambda t, attempt_id=attempt.id: WRITER_TASKS.pop(attempt_id, None) if WRITER_TASKS.get(attempt_id) is t else None)
    return "started"


async def resolve_writer_placement(attempt: Attempt, db: Session) -> tuple[str | None, dict]:
    """Decides what goes into {{PLACEMENT}} for a generation: the writer's
    section if a valid one exists for exactly this plan (waiting up to
    PLACEMENT_WRITER_WAIT_SECONDS for one still running), otherwise None so
    the caller falls back to the facts. Also returns the record saved to
    generation_debug: facts, raw output, used/fallback + reason, usage."""
    facts = build_placement_text(attempt.items, attempt.room.layout_json, False)
    info: dict = {"facts": facts, "used": False, "reason": None, "output": None, "conflicts": None, "usage": None, "plan_path": None}

    def fallback(reason: str) -> tuple[None, dict]:
        info["reason"] = reason
        return None, info

    if not placement_writer_enabled(db):
        return fallback("the placement writer is switched off")
    if not flatten_placed_subpieces(attempt.items):
        return fallback("no pieces are placed on the plan")
    state = attempt.placement_writer or {}
    if not state.get("signature"):
        return fallback("no plan image was uploaded for this layout")
    model = get_active_vision_model(db)
    if state["signature"] != writer_signature(facts, attempt.room.layout_json, get_placement_writer_prompt(db), model):
        return fallback("the plan, the room's features or the writer settings changed after the writer ran")

    info["plan_path"] = state.get("plan_path")
    info["model"] = state.get("model")
    if state.get("status") == "running":
        task = WRITER_TASKS.get(attempt.id)
        if task is None or task.done():
            return fallback("the writer was interrupted before it finished")
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=PLACEMENT_WRITER_WAIT_SECONDS)
        except asyncio.TimeoutError:
            return fallback(f"the writer did not finish within {PLACEMENT_WRITER_WAIT_SECONDS} s")
        db.refresh(attempt)
        state = attempt.placement_writer or {}

    info.update(
        output=state.get("output"), conflicts=state.get("conflicts"), usage=state.get("usage"), elapsed_s=state.get("elapsed_s")
    )
    if state.get("status") == "done" and state.get("ok") and state.get("placement"):
        info["used"] = True
        return state["placement"], info
    return fallback(state.get("reason") or "the writer produced no result")


# ---------------------------------------------------------------------------
# Generation jobs — POST starts a background job, the client polls for the
# result so the flow survives the phone locking or the tab backgrounding.
# ---------------------------------------------------------------------------

JOBS: dict[str, dict] = {}


def refund_generation_credits(db: Session, shop_id: int, user_id: int, attempt_id: int | None) -> None:
    db.add(CreditLedger(shop_id=shop_id, user_id=user_id, attempt_id=attempt_id, delta=CREDITS_PER_GENERATION, reason="refund"))
    db.commit()


async def run_generation_job(job_id: str, attempt_id: int, user_id: int, shop_id: int) -> None:
    db = SessionLocal()
    try:
        attempt = (
            db.query(Attempt)
            .join(Room, Attempt.room_id == Room.id)
            .join(Customer, Room.customer_id == Customer.id)
            .filter(Attempt.id == attempt_id, Customer.user_id == user_id)
            .first()
        )
        if attempt is None:
            JOBS[job_id] = {"status": "error", "message": "That attempt could not be found."}
            refund_generation_credits(db, shop_id, user_id, None)
            return
        if not attempt.items:
            JOBS[job_id] = {"status": "error", "message": "Add at least one piece of furniture first."}
            refund_generation_credits(db, shop_id, user_id, attempt.id)
            return

        room = attempt.room
        template = get_active_prompt(db)
        writer_placement, writer_info = (None, None)
        if not attempt.ignore_placement:
            writer_placement, writer_info = await resolve_writer_placement(attempt, db)
        prompt = build_prompt(
            template, room, attempt.items, attempt.room_treatment, attempt.lighting, attempt.ignore_placement, writer_placement
        )
        print(f"=== resolved prompt for attempt {attempt_id} ===\n{prompt}\n=== end prompt ===", flush=True)

        room_path = DATA_ROOT / room.photo_path
        with Image.open(room_path) as room_image:
            size = derive_size(*room_image.size)

        image_files: list[tuple[str, bytes, str]] = []
        debug_images: list[dict] = []

        room_file, room_debug = load_local_image_with_debug(room_path, "room", f"/media/{room.photo_path}")
        image_files.append(room_file)
        debug_images.append(room_debug)

        for item in attempt.items:
            item_file, item_debug = load_local_image_with_debug(
                DATA_ROOT / item.photo_path, "product", f"/media/{item.photo_path}"
            )
            image_files.append(item_file)
            debug_images.append(item_debug)

        # The plan PNG is logged beside the others but never added to
        # image_files: it goes to the placement writer only.
        plan_path = (writer_info or {}).get("plan_path")
        if plan_path and (DATA_ROOT / plan_path).is_file():
            _plan_file, plan_debug = load_local_image_with_debug(DATA_ROOT / plan_path, "plan", f"/media/{plan_path}")
            debug_images.append(plan_debug)

        try:
            result = await asyncio.to_thread(
                call_image_api, prompt, image_files, size, IMAGE_QUALITY, f"attempt:{attempt_id}"
            )
        except GenerationError as exc:
            JOBS[job_id] = {"status": "error", "message": exc.message}
            refund_generation_credits(db, shop_id, user_id, attempt.id)
            return

        filename = f"{uuid.uuid4().hex}.jpg"
        image = Image.open(io.BytesIO(result["image_bytes"])).convert("RGB")
        image.save(RENDERS_DIR / filename, format="JPEG", quality=92)
        relative_path = f"renders/{filename}"

        render = Render(attempt_id=attempt.id, image_path=relative_path)
        db.add(render)
        db.commit()
        db.refresh(render)

        db.add(
            GenerationDebug(
                render_id=render.id,
                prompt=prompt,
                model=MODEL_NAME,
                quality=IMAGE_QUALITY,
                size=size,
                elapsed_s=result["elapsed_s"],
                usage=result["usage"],
                images=debug_images,
                placement_writer=writer_info,
            )
        )
        usage = result["usage"]
        tokens_in = usage.get("input_tokens") if usage else None
        tokens_out = usage.get("output_tokens") if usage else None
        usd_cost = compute_usd_cost(usage)
        note = None
        # The writer's spend (every call made for this attempt since the last
        # render) is logged in this same row; no extra credits are charged.
        db.refresh(attempt)
        writer_spend = (attempt.placement_writer or {}).get("unlogged_usage")
        if writer_spend:
            writer_cost = writer_usd_cost(writer_spend["prompt_tokens"], writer_spend["completion_tokens"])
            tokens_in = (tokens_in or 0) + writer_spend["prompt_tokens"]
            tokens_out = (tokens_out or 0) + writer_spend["completion_tokens"]
            usd_cost = round((usd_cost or 0) + writer_cost, 6)
            note = (
                f"includes placement writer: {writer_spend['calls']} call(s), {writer_spend['prompt_tokens']} in / "
                f"{writer_spend['completion_tokens']} out tokens, ${writer_cost:.6f}"
            )
            attempt.placement_writer = {**attempt.placement_writer, "unlogged_usage": None}
        db.add(
            CreditLedger(
                shop_id=shop_id,
                user_id=user_id,
                attempt_id=attempt.id,
                render_id=render.id,
                delta=0,
                reason="generation",
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                usd_cost=usd_cost,
                note=note,
            )
        )
        db.commit()

        JOBS[job_id] = {
            "status": "done",
            "render_id": render.id,
            "attempt_id": attempt.id,
            "image_url": f"/media/{relative_path}",
        }
    except Exception:
        logger.exception("generation job failed job_id=%s attempt_id=%s", job_id, attempt_id)
        JOBS[job_id] = {"status": "error", "message": "Something went wrong generating your image. Please try again."}
        db.rollback()
        refund_generation_credits(db, shop_id, user_id, attempt_id)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------


class LoginBody(BaseModel):
    mobile: str
    password: str


def session_response(user: User) -> JSONResponse:
    token = make_session_token(user.id)
    response = JSONResponse(content={"user": user_public(user)})
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
    )
    return response


@app.post("/api/login")
def api_login(body: LoginBody, db: Session = Depends(get_db)) -> JSONResponse:
    user = db.query(User).filter(User.mobile == body.mobile.strip(), User.role != "superadmin").first()
    if user is None or not user.active or not verify_password(body.password, user.password_hash):
        return error_response(401, "invalid_credentials", "That mobile number or password is incorrect.")
    return session_response(user)


class SuperLoginBody(BaseModel):
    password: str


@app.post("/api/super/login")
def api_super_login(body: SuperLoginBody, db: Session = Depends(get_db)) -> JSONResponse:
    for user in db.query(User).filter(User.role == "superadmin", User.active.is_(True)).all():
        if verify_password(body.password, user.password_hash):
            return session_response(user)
    return error_response(401, "invalid_credentials", "That password is incorrect.")


@app.post("/api/logout")
def api_logout() -> JSONResponse:
    response = JSONResponse(content={"ok": True})
    response.delete_cookie(SESSION_COOKIE_NAME)
    return response


@app.get("/api/me")
def api_me(user: User = Depends(get_current_user)) -> JSONResponse:
    return JSONResponse(content={"user": user_public(user)})


# ---------------------------------------------------------------------------
# Ownership helpers
# ---------------------------------------------------------------------------


def get_owned_customer(customer_id: int, user: User, db: Session) -> Customer:
    customer = db.query(Customer).filter(Customer.id == customer_id, Customer.user_id == user.id).first()
    if customer is None:
        raise HTTPException(status_code=404, detail="That customer could not be found.")
    return customer


def get_owned_room(room_id: int, user: User, db: Session) -> Room:
    room = (
        db.query(Room)
        .join(Customer, Room.customer_id == Customer.id)
        .filter(Room.id == room_id, Customer.user_id == user.id)
        .first()
    )
    if room is None:
        raise HTTPException(status_code=404, detail="That room could not be found.")
    return room


def get_owned_attempt(attempt_id: int, user: User, db: Session) -> Attempt:
    attempt = (
        db.query(Attempt)
        .join(Room, Attempt.room_id == Room.id)
        .join(Customer, Room.customer_id == Customer.id)
        .filter(Attempt.id == attempt_id, Customer.user_id == user.id)
        .first()
    )
    if attempt is None:
        raise HTTPException(status_code=404, detail="That attempt could not be found.")
    return attempt


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


def item_public(item: Item) -> dict:
    return {
        "id": item.id,
        "category": item.category,
        "type": item.type,
        "width_ft": item.width_ft,
        "photo_url": f"/media/{item.photo_path}",
        "shape": item.shape,
        "sub_pieces": compute_sub_pieces(item),
        "placement": item.placement or [],
    }


def render_public(render: Render) -> dict:
    return {
        "id": render.id,
        "image_url": f"/media/{render.image_path}",
        "created_at": render.created_at.isoformat() if render.created_at else None,
    }


def customer_summary(customer: Customer) -> dict:
    room_count = len(customer.rooms)
    render_count = sum(len(attempt.renders) for room in customer.rooms for attempt in room.attempts)
    return {
        "id": customer.id,
        "name": customer.name,
        "created_at": customer.created_at.isoformat() if customer.created_at else None,
        "room_count": room_count,
        "render_count": render_count,
    }


def thumbnail_url_from(render_path: str | None, fallback_photo_path: str | None) -> str | None:
    path = render_path or fallback_photo_path
    return f"/media/{path}" if path else None


def room_summary(room: Room) -> dict:
    latest_attempt = room.attempts[-1] if room.attempts else None
    latest_render = latest_attempt.renders[-1] if latest_attempt and latest_attempt.renders else None
    return {
        "id": room.id,
        "customer_id": room.customer_id,
        "room_type": room.room_type,
        "photo_url": f"/media/{room.photo_path}",
        "created_at": room.created_at.isoformat() if room.created_at else None,
        "attempt_count": len(room.attempts),
        "thumbnail_url": f"/media/{latest_render.image_path}" if latest_render else f"/media/{room.photo_path}",
    }


def room_detail(room: Room) -> dict:
    return {
        "id": room.id,
        "customer_id": room.customer_id,
        "customer_name": room.customer.name,
        "room_type": room.room_type,
        "photo_url": f"/media/{room.photo_path}",
        "created_at": room.created_at.isoformat() if room.created_at else None,
        "layout_json": room.layout_json,
        "layout_status": room.layout_status,
    }


def attempt_summary(attempt: Attempt) -> dict:
    latest_render = attempt.renders[-1] if attempt.renders else None
    return {
        "id": attempt.id,
        "room_id": attempt.room_id,
        "room_treatment": attempt.room_treatment,
        "lighting": attempt.lighting,
        "ignore_placement": attempt.ignore_placement,
        "is_picked": attempt.is_picked,
        "created_at": attempt.created_at.isoformat() if attempt.created_at else None,
        "item_count": len(attempt.items),
        "latest_render": (
            {"id": latest_render.id, "image_url": f"/media/{latest_render.image_path}"} if latest_render else None
        ),
    }


def attempt_detail(attempt: Attempt) -> dict:
    latest_render = attempt.renders[-1] if attempt.renders else None
    return {
        "id": attempt.id,
        "room": room_detail(attempt.room),
        "room_treatment": attempt.room_treatment,
        "lighting": attempt.lighting,
        "ignore_placement": attempt.ignore_placement,
        "is_picked": attempt.is_picked,
        "created_at": attempt.created_at.isoformat() if attempt.created_at else None,
        "items": [item_public(i) for i in attempt.items],
        "renders": [render_public(r) for r in attempt.renders],
        "latest_render": (
            {"id": latest_render.id, "image_url": f"/media/{latest_render.image_path}"} if latest_render else None
        ),
    }


# ---------------------------------------------------------------------------
# Shared item/stroke/finish/generate logic, used by the /api/attempts/*
# routes below.
# ---------------------------------------------------------------------------


async def _add_item_to_attempt(
    attempt: Attempt, category: str, type_: str, width_ft: float, photo: UploadFile, db: Session
) -> Attempt | JSONResponse:
    if category not in ITEM_TYPES:
        return error_response(400, "invalid_category", "Please choose a furniture category.")
    if type_ not in ITEM_TYPES[category]:
        return error_response(400, "invalid_type", "Please choose a valid type for that category.")
    if width_ft <= 0:
        return error_response(400, "invalid_width", "Please enter a width in feet.")
    if len(attempt.items) >= MAX_ITEMS_PER_ATTEMPT:
        return error_response(400, "too_many_items", f"You can add up to {MAX_ITEMS_PER_ATTEMPT} pieces.")
    try:
        photo_path = await save_validated_upload(photo, ITEMS_DIR)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)

    item = Item(
        attempt_id=attempt.id,
        category=category,
        type=type_,
        width_ft=width_ft,
        photo_path=photo_path,
        shape=derive_item_shape(category, type_),
    )
    db.add(item)
    discard_placement_writer(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt


def _delete_item_from_attempt(attempt: Attempt, item_id: int, db: Session) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    db.delete(item)
    discard_placement_writer(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt


class PlacementBody(BaseModel):
    placement: dict
    # Set when the block was resized on the plan: the sub-piece's new length
    # in feet, so the stored width (and so the prompt) matches the plan.
    width_ft: float | None = None


ROTATION_CHOICES = {0, 90, 180, 270}
CORNER_CHOICES = {"far-left", "far-right", "near-left", "near-right"}
MIN_RESIZE_WIDTH_FT = 1.0
MAX_RESIZE_WIDTH_FT = 30.0


def _validate_rect_placement(rect: object) -> dict | None:
    if not isinstance(rect, dict):
        return None
    try:
        x, y, w, h, rotation = rect["x"], rect["y"], rect["w"], rect["h"], rect["rotation"]
    except (KeyError, TypeError):
        return None
    for v in (x, y, w, h):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0 <= v <= 1):
            return None
    if isinstance(rotation, bool) or rotation not in ROTATION_CHOICES:
        return None
    return {"x": float(x), "y": float(y), "w": float(w), "h": float(h), "rotation": int(rotation)}


def validate_placement(shape: str, placement: object) -> dict | None:
    """Structurally validates a block placement against the item's derived
    shape: a 'rect' or 'round' placement is {x,y,w,h,rotation}; an 'L' or
    'curved' placement is {long, short, corner} where long/short are each
    rects. Coordinates are normalised 0-1 and rotation is one of the four
    cardinal directions."""
    if not isinstance(placement, dict):
        return None
    if shape in ("rect", "round"):
        return _validate_rect_placement(placement)
    if shape in ARM_SHAPES:
        corner = placement.get("corner")
        if not isinstance(corner, str) or corner.strip() not in CORNER_CHOICES:
            return None
        long_rect = _validate_rect_placement(placement.get("long"))
        short_rect = _validate_rect_placement(placement.get("short"))
        if long_rect is None or short_rect is None:
            return None
        return {"long": long_rect, "short": short_rect, "corner": corner.strip()}
    return None


def _scale_rect_about_centre(rect: dict, factor: float) -> dict:
    w = min(rect["w"] * factor, 1.0)
    h = min(rect["h"] * factor, 1.0)
    cx = rect["x"] + rect["w"] / 2
    cy = rect["y"] + rect["h"] / 2
    x = min(max(cx - w / 2, 0.0), 1.0 - w)
    y = min(max(cy - h / 2, 0.0), 1.0 - h)
    return {**rect, "x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}


def _set_item_placement(
    attempt: Attempt, item_id: int, sub_index: int, placement: dict, width_ft: float | None, db: Session
) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    old_sub_pieces = compute_sub_pieces(item)
    sub_piece = next((sp for sp in old_sub_pieces if sp["sub_index"] == sub_index), None)
    if sub_piece is None:
        return error_response(400, "invalid_sub_index", "That sub-piece doesn't exist for this item.")
    validated = validate_placement(sub_piece["shape"], placement)
    if validated is None:
        return error_response(400, "invalid_placement", "That placement isn't valid for this piece's shape.")

    others = [e for e in (item.placement or []) if e.get("sub_index") != sub_index]
    if width_ft is not None:
        if not (MIN_RESIZE_WIDTH_FT <= width_ft <= MAX_RESIZE_WIDTH_FT):
            return error_response(
                400, "invalid_width", f"A piece must be between {MIN_RESIZE_WIDTH_FT:g} and {MAX_RESIZE_WIDTH_FT:g} ft."
            )
        if len(old_sub_pieces) > 1:
            # A set's sub-piece widths all derive from item.width_ft (the
            # largest sofa), so resizing one rescales the set: back-solve the
            # item width from this sub-piece, then rescale the other placed
            # sofas to their new derived widths so the plan keeps matching.
            segments = multi_piece_segments(item.type) or []
            seats = segments[sub_index]
            # derived sub-piece widths are whole feet (compute_sub_pieces)
            width_ft = float(max(round(width_ft), 1))
            item.width_ft = width_ft * max(segments) / seats
            new_widths = {sp["sub_index"]: sp["width_ft"] for sp in compute_sub_pieces(item)}
            old_widths = {sp["sub_index"]: sp["width_ft"] for sp in old_sub_pieces}
            others = [
                {**e, "geometry": _scale_rect_about_centre(e["geometry"], new_widths[e["sub_index"]] / old_widths[e["sub_index"]])}
                if e.get("sub_index") in new_widths and old_widths.get(e.get("sub_index")) and e.get("shape") in ("rect", "round")
                else e
                for e in others
            ]
        else:
            item.width_ft = width_ft

    entry = {"sub_index": sub_index, "label": sub_piece["label"], "shape": sub_piece["shape"], "geometry": validated}
    remaining = [*others, entry]
    remaining.sort(key=lambda e: e["sub_index"])
    item.placement = remaining
    discard_placement_writer(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt


def _clear_item_placement(attempt: Attempt, item_id: int, sub_index: int, db: Session) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    item.placement = [e for e in (item.placement or []) if e.get("sub_index") != sub_index]
    discard_placement_writer(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt


def _set_finish(attempt: Attempt, room_treatment: str, lighting: str, db: Session) -> Attempt | JSONResponse:
    if room_treatment not in ROOM_TREATMENT_CHOICES:
        return error_response(400, "invalid_room_treatment", "Please choose how the room should look.")
    if lighting not in LIGHTING_CHOICES:
        return error_response(400, "invalid_lighting", "Please choose a lighting option.")
    attempt.room_treatment = room_treatment
    attempt.lighting = lighting
    db.commit()
    db.refresh(attempt)
    return attempt


def _start_generation(attempt: Attempt, ignore_placement: bool, user: User, db: Session) -> JSONResponse:
    if not attempt.items:
        return error_response(400, "no_items", "Add at least one piece of furniture first.")
    shop = db.query(Shop).filter(Shop.id == user.shop_id).first() if user.shop_id else None
    if shop is None:
        return error_response(400, "no_shop", "Your account isn't assigned to a shop.")
    if shop_balance(db, shop) < CREDITS_PER_GENERATION:
        return error_response(
            402,
            "insufficient_credits",
            "This month's credit pool is finished. Please contact the showroom owner to top up.",
        )
    attempt.ignore_placement = ignore_placement
    db.commit()
    db.add(CreditLedger(shop_id=shop.id, user_id=user.id, attempt_id=attempt.id, delta=-CREDITS_PER_GENERATION, reason="generation"))
    db.commit()
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "processing"}
    asyncio.create_task(run_generation_job(job_id, attempt.id, user.id, shop.id))
    return JSONResponse(content={"job_id": job_id})


class FinishBody(BaseModel):
    room_treatment: str
    lighting: str


@app.get("/api/jobs/{job_id}")
def api_job_status(job_id: str, user: User = Depends(get_current_user)) -> JSONResponse:
    job = JOBS.get(job_id)
    if job is None:
        return error_response(404, "job_not_found", "That job could not be found.")
    return JSONResponse(content=job)


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------


@app.get("/api/customers")
def api_list_customers(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> JSONResponse:
    rows = db.execute(
        text(
            """
            WITH my_rooms AS (
                SELECT r.id, r.customer_id, r.photo_path
                FROM rooms r
                JOIN customers c ON c.id = r.customer_id
                WHERE c.user_id = :user_id
            ),
            counts AS (
                SELECT
                    mr.customer_id,
                    COUNT(DISTINCT mr.id) AS room_count,
                    COUNT(rd.id) AS render_count
                FROM my_rooms mr
                LEFT JOIN attempts a ON a.room_id = mr.id
                LEFT JOIN renders rd ON rd.attempt_id = a.id
                GROUP BY mr.customer_id
            ),
            ranked_renders AS (
                SELECT
                    mr.customer_id,
                    rd.image_path,
                    ROW_NUMBER() OVER (
                        PARTITION BY mr.customer_id
                        ORDER BY a.is_picked DESC, rd.created_at DESC, rd.id DESC
                    ) AS rn
                FROM my_rooms mr
                JOIN attempts a ON a.room_id = mr.id
                JOIN renders rd ON rd.attempt_id = a.id
            ),
            fallback_room AS (
                SELECT DISTINCT ON (mr.customer_id)
                    mr.customer_id, mr.photo_path
                FROM my_rooms mr
                ORDER BY mr.customer_id, mr.id DESC
            )
            SELECT
                c.id,
                c.name,
                c.created_at,
                COALESCE(counts.room_count, 0) AS room_count,
                COALESCE(counts.render_count, 0) AS render_count,
                ranked_renders.image_path AS render_thumbnail_path,
                fallback_room.photo_path AS fallback_thumbnail_path
            FROM customers c
            LEFT JOIN counts ON counts.customer_id = c.id
            LEFT JOIN ranked_renders ON ranked_renders.customer_id = c.id AND ranked_renders.rn = 1
            LEFT JOIN fallback_room ON fallback_room.customer_id = c.id
            WHERE c.user_id = :user_id
            ORDER BY c.id DESC
            """
        ),
        {"user_id": user.id},
    ).mappings().all()

    customers = [
        {
            "id": row["id"],
            "name": row["name"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "room_count": row["room_count"],
            "render_count": row["render_count"],
            "thumbnail_url": thumbnail_url_from(row["render_thumbnail_path"], row["fallback_thumbnail_path"]),
        }
        for row in rows
    ]
    return JSONResponse(content={"customers": customers})


class CreateCustomerBody(BaseModel):
    name: str


@app.post("/api/customers")
def api_create_customer(
    body: CreateCustomerBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    if not body.name.strip():
        return error_response(400, "missing_name", "Please enter the customer's name.")
    customer = Customer(user_id=user.id, name=body.name.strip())
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return JSONResponse(content={"customer": customer_summary(customer)})


@app.get("/api/customers/{customer_id}")
def api_get_customer(
    customer_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    customer = get_owned_customer(customer_id, user, db)

    room_rows = db.execute(
        text(
            """
            WITH room_counts AS (
                SELECT
                    r.id AS room_id,
                    COUNT(DISTINCT a.id) AS attempt_count,
                    COUNT(rd.id) AS render_count
                FROM rooms r
                LEFT JOIN attempts a ON a.room_id = r.id
                LEFT JOIN renders rd ON rd.attempt_id = a.id
                WHERE r.customer_id = :customer_id
                GROUP BY r.id
            ),
            ranked_renders AS (
                SELECT
                    r.id AS room_id,
                    rd.image_path,
                    ROW_NUMBER() OVER (
                        PARTITION BY r.id
                        ORDER BY a.is_picked DESC, rd.created_at DESC, rd.id DESC
                    ) AS rn
                FROM rooms r
                JOIN attempts a ON a.room_id = r.id
                JOIN renders rd ON rd.attempt_id = a.id
                WHERE r.customer_id = :customer_id
            )
            SELECT
                r.id,
                r.customer_id,
                r.room_type,
                r.photo_path,
                r.created_at,
                COALESCE(room_counts.attempt_count, 0) AS attempt_count,
                COALESCE(room_counts.render_count, 0) AS render_count,
                ranked_renders.image_path AS render_thumbnail_path
            FROM rooms r
            LEFT JOIN room_counts ON room_counts.room_id = r.id
            LEFT JOIN ranked_renders ON ranked_renders.room_id = r.id AND ranked_renders.rn = 1
            WHERE r.customer_id = :customer_id
            ORDER BY r.id
            """
        ),
        {"customer_id": customer.id},
    ).mappings().all()

    rooms = [
        {
            "id": row["id"],
            "customer_id": row["customer_id"],
            "room_type": row["room_type"],
            "photo_url": f"/media/{row['photo_path']}",
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "attempt_count": row["attempt_count"],
            "render_count": row["render_count"],
            "has_render": row["render_thumbnail_path"] is not None,
            "thumbnail_url": thumbnail_url_from(row["render_thumbnail_path"], row["photo_path"]),
        }
        for row in room_rows
    ]

    customer_data = {
        "id": customer.id,
        "name": customer.name,
        "created_at": customer.created_at.isoformat() if customer.created_at else None,
        "room_count": len(rooms),
        "render_count": sum(r["render_count"] for r in rooms),
    }

    return JSONResponse(content={"customer": customer_data, "rooms": rooms})


@app.post("/api/customers/{customer_id}/rooms")
async def api_create_room(
    customer_id: int,
    room_type: str = Form(...),
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    customer = get_owned_customer(customer_id, user, db)
    if room_type not in ROOM_TYPES:
        return error_response(400, "invalid_room_type", "Please choose a room type.")
    try:
        photo_path = await save_validated_upload(photo, ROOMS_DIR)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)

    room = Room(customer_id=customer.id, room_type=room_type, photo_path=photo_path)
    db.add(room)
    db.commit()
    db.refresh(room)
    asyncio.create_task(run_vision_job(room.id))
    return JSONResponse(content={"room": room_summary(room)})


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------


@app.post("/api/rooms/{room_id}/photo")
async def api_update_room_photo(
    room_id: int,
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """Replaces the room's shared photo (used by every attempt under it —
    e.g. when the salesman revisits mid-construction with a newer photo)."""
    room = get_owned_room(room_id, user, db)
    try:
        photo_path = await save_validated_upload(photo, ROOMS_DIR)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)
    room.photo_path = photo_path
    room.layout_json = None
    room.layout_status = "pending"
    db.commit()
    db.refresh(room)
    asyncio.create_task(run_vision_job(room.id))
    return JSONResponse(content={"room": room_detail(room)})


@app.get("/api/rooms/{room_id}")
def api_get_room(room_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> JSONResponse:
    room = get_owned_room(room_id, user, db)
    attempts = sorted(room.attempts, key=lambda a: a.id, reverse=True)
    return JSONResponse(content={"room": room_detail(room), "attempts": [attempt_summary(a) for a in attempts]})


class UpdateRoomLayoutBody(BaseModel):
    layout_json: dict


@app.patch("/api/rooms/{room_id}/layout")
def api_update_room_layout(
    room_id: int, body: UpdateRoomLayoutBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    """Lets the salesman correct a vision layout that missed a feature —
    always sets status to 'ready' since a human has now confirmed it,
    whether the original vision call succeeded or failed."""
    room = get_owned_room(room_id, user, db)
    room.layout_json = body.layout_json
    room.layout_status = "ready"
    db.commit()
    db.refresh(room)
    return JSONResponse(content={"room": room_detail(room)})


class CreateAttemptBody(BaseModel):
    clone_from_attempt_id: int | None = None


@app.post("/api/rooms/{room_id}/attempts")
def api_create_attempt(
    room_id: int,
    body: CreateAttemptBody | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    room = get_owned_room(room_id, user, db)

    room_treatment = DEFAULT_ROOM_TREATMENT
    lighting = DEFAULT_LIGHTING
    source_items: list[Item] = []

    clone_from_attempt_id = body.clone_from_attempt_id if body else None
    if clone_from_attempt_id is not None:
        source = db.query(Attempt).filter(Attempt.id == clone_from_attempt_id, Attempt.room_id == room.id).first()
        if source is None:
            return error_response(404, "attempt_not_found", "That attempt could not be found.")
        room_treatment = source.room_treatment
        lighting = source.lighting
        source_items = source.items

    attempt = Attempt(room_id=room.id, room_treatment=room_treatment, lighting=lighting)
    db.add(attempt)
    db.flush()

    for item in source_items:
        db.add(
            Item(
                attempt_id=attempt.id,
                category=item.category,
                type=item.type,
                width_ft=item.width_ft,
                photo_path=item.photo_path,
                shape=item.shape,
                placement=[dict(entry) for entry in item.placement] if item.placement else None,
            )
        )

    db.commit()
    db.refresh(attempt)
    return JSONResponse(content={"attempt": attempt_detail(attempt)})


# ---------------------------------------------------------------------------
# Attempts
# ---------------------------------------------------------------------------


@app.get("/api/attempts/{attempt_id}")
def api_get_attempt(
    attempt_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    return JSONResponse(content={"attempt": attempt_detail(attempt)})


@app.post("/api/attempts/{attempt_id}/items")
async def api_add_item_to_attempt(
    attempt_id: int,
    category: str = Form(...),
    type: str = Form(...),
    width_ft: float = Form(...),
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = await _add_item_to_attempt(attempt, category, type, width_ft, photo, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.post("/api/attempts/{attempt_id}/items/batch")
async def api_add_items_batch(
    attempt_id: int,
    category: str = Form(...),
    pieces: str = Form(...),
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """Adds several separate pieces (each its own Item and width) that all
    share one uploaded photo."""
    attempt = get_owned_attempt(attempt_id, user, db)
    if category not in ITEM_TYPES:
        return error_response(400, "invalid_category", "Please choose a furniture category.")
    try:
        parsed = json.loads(pieces)
    except ValueError:
        parsed = None
    if not isinstance(parsed, list) or not parsed:
        return error_response(400, "invalid_pieces", "Please add at least one piece.")
    clean: list[tuple[str, float]] = []
    for entry in parsed:
        type_ = entry.get("type") if isinstance(entry, dict) else None
        width = entry.get("width_ft") if isinstance(entry, dict) else None
        if not isinstance(type_, str) or type_ not in ITEM_TYPES[category]:
            return error_response(400, "invalid_type", "Please choose a valid type for that category.")
        if isinstance(width, bool) or not isinstance(width, (int, float)) or not width > 0:
            return error_response(400, "invalid_width", "Please enter a width in feet.")
        clean.append((type_, float(width)))
    if len(attempt.items) + len(clean) > MAX_ITEMS_PER_ATTEMPT:
        return error_response(400, "too_many_items", f"You can add up to {MAX_ITEMS_PER_ATTEMPT} pieces.")
    try:
        photo_path = await save_validated_upload(photo, ITEMS_DIR)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)
    for type_, width in clean:
        db.add(
            Item(
                attempt_id=attempt.id,
                category=category,
                type=type_,
                width_ft=width,
                photo_path=photo_path,
                shape=derive_item_shape(category, type_),
            )
        )
    db.commit()
    db.refresh(attempt)
    return JSONResponse(content={"attempt": attempt_detail(attempt)})


@app.delete("/api/attempts/{attempt_id}/items/{item_id}")
def api_delete_item_from_attempt(
    attempt_id: int, item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _delete_item_from_attempt(attempt, item_id, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.post("/api/attempts/{attempt_id}/items/{item_id}/placement/{sub_index}")
def api_set_item_placement(
    attempt_id: int,
    item_id: int,
    sub_index: int,
    body: PlacementBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _set_item_placement(attempt, item_id, sub_index, body.placement, body.width_ft, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.delete("/api/attempts/{attempt_id}/items/{item_id}/placement/{sub_index}")
def api_clear_item_placement(
    attempt_id: int,
    item_id: int,
    sub_index: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _clear_item_placement(attempt, item_id, sub_index, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.patch("/api/attempts/{attempt_id}")
def api_patch_attempt(
    attempt_id: int, body: FinishBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _set_finish(attempt, body.room_treatment, body.lighting, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.post("/api/attempts/{attempt_id}/generate")
async def api_generate_attempt(
    attempt_id: int,
    ignore_placement: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    return _start_generation(attempt, ignore_placement, user, db)


@app.post("/api/attempts/{attempt_id}/plan")
async def api_upload_attempt_plan(
    attempt_id: int,
    plan: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """Receives the floor plan as the salesman left it (a PNG exported by the
    client when he taps Next) and starts the placement writer in the
    background. Never blocks or fails the flow: generation works without it."""
    attempt = get_owned_attempt(attempt_id, user, db)
    data = await plan.read()
    if not data or len(data) > MAX_UPLOAD_BYTES:
        return error_response(400, "invalid_plan", "That plan image couldn't be read.")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        image = image.convert("RGB")
    except Exception:
        return error_response(400, "invalid_plan", "That plan image couldn't be read.")
    PLANS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.png"
    image.save(PLANS_DIR / filename, format="PNG")
    status = start_placement_writer(attempt, f"plans/{filename}", db)
    if status != "started":
        (PLANS_DIR / filename).unlink(missing_ok=True)  # nothing new to write for; keep the plan already on record
    return JSONResponse(content={"writer": status})


# ---------------------------------------------------------------------------
# Renders
# ---------------------------------------------------------------------------


@app.post("/api/renders/{render_id}/pick")
def api_pick_render(
    render_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    render = (
        db.query(Render)
        .join(Attempt, Render.attempt_id == Attempt.id)
        .join(Room, Attempt.room_id == Room.id)
        .join(Customer, Room.customer_id == Customer.id)
        .filter(Render.id == render_id, Customer.user_id == user.id)
        .first()
    )
    if render is None:
        return error_response(404, "render_not_found", "That render could not be found.")
    attempt = render.attempt
    db.query(Attempt).filter(Attempt.room_id == attempt.room_id).update({Attempt.is_picked: False})
    attempt.is_picked = True
    db.commit()
    return JSONResponse(content={"attempt_id": attempt.id, "render_id": render.id, "is_picked": True})


# ---------------------------------------------------------------------------
# Shop credits
# ---------------------------------------------------------------------------


@app.get("/api/shop/credits")
def api_shop_credits(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> JSONResponse:
    if user.shop_id is None:
        return error_response(400, "no_shop", "Your account isn't assigned to a shop.")
    shop = db.query(Shop).filter(Shop.id == user.shop_id).first()
    _, cycle_end = cycle_window(shop)
    return JSONResponse(
        content={
            "balance": shop_balance(db, shop),
            "monthly_credits": shop.monthly_credits,
            "cycle_ends_on": cycle_end.date().isoformat(),
        }
    )


@app.get("/api/admin/shop/usage")
def api_admin_shop_usage(
    shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    resolved_shop_id = resolve_admin_shop_id(owner, shop_id)
    if resolved_shop_id is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    shop = db.query(Shop).filter(Shop.id == resolved_shop_id).first()
    if shop is None:
        return error_response(404, "shop_not_found", "That shop could not be found.")
    start, end = cycle_window(shop)

    per_salesman = db.execute(
        text(
            """
            SELECT
                u.id AS user_id,
                u.name,
                COUNT(*) FILTER (WHERE cl.reason = 'generation' AND cl.render_id IS NOT NULL) AS generations,
                COALESCE(-SUM(cl.delta) FILTER (WHERE cl.reason IN ('generation', 'refund')), 0) AS credits_spent,
                COALESCE(SUM(cl.usd_cost) FILTER (WHERE cl.reason = 'generation'), 0) AS usd_cost
            FROM users u
            LEFT JOIN credit_ledger cl
                ON cl.user_id = u.id AND cl.shop_id = :shop_id AND cl.created_at >= :start AND cl.created_at < :end
            WHERE u.shop_id = :shop_id AND u.role = 'salesman'
            GROUP BY u.id, u.name
            ORDER BY credits_spent DESC, u.name
            """
        ),
        {"shop_id": shop.id, "start": start, "end": end},
    ).mappings().all()

    daily = db.execute(
        text(
            """
            SELECT
                date_trunc('day', cl.created_at) AS day,
                COUNT(*) FILTER (WHERE cl.reason = 'generation' AND cl.render_id IS NOT NULL) AS generations,
                COALESCE(-SUM(cl.delta) FILTER (WHERE cl.reason IN ('generation', 'refund')), 0) AS credits_spent
            FROM credit_ledger cl
            WHERE cl.shop_id = :shop_id AND cl.created_at >= :start AND cl.created_at < :end
            GROUP BY day
            ORDER BY day
            """
        ),
        {"shop_id": shop.id, "start": start, "end": end},
    ).mappings().all()

    return JSONResponse(
        content={
            "cycle_start": start.date().isoformat(),
            "cycle_end": end.date().isoformat(),
            "salesmen": [
                {
                    "user_id": r["user_id"],
                    "name": r["name"],
                    "generations": r["generations"],
                    "credits_spent": r["credits_spent"],
                    "usd_cost": float(r["usd_cost"]),
                }
                for r in per_salesman
            ],
            "daily": [
                {"date": r["day"].date().isoformat(), "generations": r["generations"], "credits_spent": r["credits_spent"]}
                for r in daily
            ],
        }
    )


# ---------------------------------------------------------------------------
# Superadmin — shops
# ---------------------------------------------------------------------------


def shop_public(db: Session, shop: Shop) -> dict:
    return {
        "id": shop.id,
        "name": shop.name,
        "monthly_credits": shop.monthly_credits,
        "cycle_start_day": shop.cycle_start_day,
        "active": shop.active,
        "balance": shop_balance(db, shop),
        "salesman_count": db.query(User).filter(User.shop_id == shop.id, User.role == "salesman").count(),
        "created_at": shop.created_at.isoformat() if shop.created_at else None,
    }


@app.get("/api/super/shops")
def api_super_list_shops(
    superadmin: User = Depends(require_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    shops = db.query(Shop).order_by(Shop.id).all()
    return JSONResponse(content={"shops": [shop_public(db, s) for s in shops]})


@app.get("/api/super/shops/{shop_id}")
def api_super_get_shop(
    shop_id: int, superadmin: User = Depends(require_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        return error_response(404, "shop_not_found", "That shop could not be found.")
    return JSONResponse(content={"shop": shop_public(db, shop)})


class CreateShopBody(BaseModel):
    name: str
    monthly_credits: int = 15000
    cycle_start_day: int = 1


@app.post("/api/super/shops")
def api_super_create_shop(
    body: CreateShopBody, superadmin: User = Depends(require_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    if not body.name.strip():
        return error_response(400, "missing_name", "Please enter a shop name.")
    if body.monthly_credits < 0:
        return error_response(400, "invalid_credits", "Monthly credits can't be negative.")
    if not (1 <= body.cycle_start_day <= 28):
        return error_response(400, "invalid_cycle_day", "Cycle start day must be between 1 and 28.")
    shop = Shop(name=body.name.strip(), monthly_credits=body.monthly_credits, cycle_start_day=body.cycle_start_day, active=True)
    db.add(shop)
    db.commit()
    db.refresh(shop)
    db.add(CreditLedger(shop_id=shop.id, user_id=None, delta=shop.monthly_credits, reason="allocation"))
    db.commit()
    return JSONResponse(content={"shop": shop_public(db, shop)})


class UpdateShopBody(BaseModel):
    name: str | None = None
    monthly_credits: int | None = None
    active: bool | None = None


@app.patch("/api/super/shops/{shop_id}")
def api_super_update_shop(
    shop_id: int, body: UpdateShopBody, superadmin: User = Depends(require_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        return error_response(404, "shop_not_found", "That shop could not be found.")
    if body.name is not None:
        if not body.name.strip():
            return error_response(400, "missing_name", "Please enter a shop name.")
        shop.name = body.name.strip()
    if body.monthly_credits is not None:
        if body.monthly_credits < 0:
            return error_response(400, "invalid_credits", "Monthly credits can't be negative.")
        shop.monthly_credits = body.monthly_credits
    if body.active is not None:
        shop.active = body.active
    db.commit()
    db.refresh(shop)
    return JSONResponse(content={"shop": shop_public(db, shop)})


class AdjustCreditsBody(BaseModel):
    delta: int
    note: str = ""


@app.post("/api/super/shops/{shop_id}/credits")
def api_super_adjust_credits(
    shop_id: int, body: AdjustCreditsBody, superadmin: User = Depends(require_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        return error_response(404, "shop_not_found", "That shop could not be found.")
    if body.delta == 0:
        return error_response(400, "zero_delta", "Enter a non-zero adjustment.")
    db.add(
        CreditLedger(
            shop_id=shop.id,
            user_id=superadmin.id,
            delta=body.delta,
            reason="adjustment",
            note=body.note.strip() or None,
        )
    )
    db.commit()
    return JSONResponse(content={"shop": shop_public(db, shop)})


# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------


class CreateSalesmanBody(BaseModel):
    name: str
    mobile: str
    password: str
    shop_id: int | None = None


@app.get("/api/admin/users")
def api_admin_list_users(
    q: str = "", shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    resolved_shop_id = resolve_admin_shop_id(owner, shop_id)
    if resolved_shop_id is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    query = db.query(User).filter(User.role.in_(["salesman", "owner"]), User.shop_id == resolved_shop_id)
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter((User.name.ilike(like)) | (User.mobile.ilike(like)))
    users = query.order_by(User.name).all()
    users.sort(key=lambda u: 0 if u.role == "owner" else 1)
    result = []
    for u in users:
        count = (
            db.query(Room)
            .join(Customer, Room.customer_id == Customer.id)
            .filter(Customer.user_id == u.id)
            .count()
        )
        result.append({**user_public(u), "project_count": count})
    return JSONResponse(content={"users": result})


@app.post("/api/admin/users")
def api_admin_create_user(
    body: CreateSalesmanBody, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    resolved_shop_id = resolve_admin_shop_id(owner, body.shop_id)
    if resolved_shop_id is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    mobile = body.mobile.strip()
    if not body.name.strip() or not mobile or not body.password:
        return error_response(400, "missing_fields", "Please fill in every field.")
    if db.query(User).filter(User.mobile == mobile).first() is not None:
        return error_response(409, "mobile_taken", "That mobile number is already registered.")
    user = User(
        shop_id=resolved_shop_id,
        name=body.name.strip(),
        mobile=mobile,
        password_hash=hash_password(body.password),
        role="salesman",
        active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return JSONResponse(content={"user": user_public(user)})


def get_admin_target_user(user_id: int, owner: User, shop_id: int | None, db: Session) -> User | JSONResponse:
    """For viewing only (the list and the detail screen) — includes both
    salesmen and owners, since owners now appear in the salesmen list too."""
    resolved_shop_id = resolve_admin_shop_id(owner, shop_id)
    if resolved_shop_id is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    target = (
        db.query(User)
        .filter(User.id == user_id, User.shop_id == resolved_shop_id, User.role.in_(["salesman", "owner"]))
        .first()
    )
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
    return target


def get_admin_mutable_target(user_id: int, owner: User, shop_id: int | None, db: Session) -> User | JSONResponse:
    """For edit/reset-password/deactivate/delete — an owner can only ever
    manage salesmen (never themselves or another owner); only a
    superadmin can act on an owner-role account."""
    target = get_admin_target_user(user_id, owner, shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    if target.role != "salesman" and owner.role != "superadmin":
        return error_response(403, "owners_only", "You can't manage another owner's account.")
    return target


@app.get("/api/admin/users/{user_id}")
def api_admin_user_detail(
    user_id: int, shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    """Legacy shape for the static/ admin detail screen: one flattened
    "project" card per room, customer name attached, renders aggregated
    across all of that room's attempts. See /api/admin/user/{id} for the
    real customers -> rooms -> renders hierarchy."""
    target = get_admin_target_user(user_id, owner, shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    rooms = (
        db.query(Room)
        .join(Customer, Room.customer_id == Customer.id)
        .filter(Customer.user_id == user_id)
        .order_by(Room.id.desc())
        .all()
    )
    projects_payload = []
    for room in rooms:
        all_renders = sorted((r for attempt in room.attempts for r in attempt.renders), key=lambda r: r.id)
        latest_render = all_renders[-1] if all_renders else None
        projects_payload.append(
            {
                "id": room.id,
                "customer_name": room.customer.name,
                "room_type": room.room_type,
                "created_at": room.created_at.isoformat() if room.created_at else None,
                "thumbnail_url": f"/media/{latest_render.image_path}" if latest_render else f"/media/{room.photo_path}",
                "has_render": latest_render is not None,
                "renders": [f"/media/{r.image_path}" for r in all_renders],
            }
        )
    return JSONResponse(content={"user": user_public(target), "project_count": len(rooms), "projects": projects_payload})


@app.get("/api/admin/user/{user_id}")
def api_admin_user_detail_v2(
    user_id: int, shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    """The real hierarchy: customers -> rooms -> renders (aggregated across
    each room's attempts)."""
    target = get_admin_target_user(user_id, owner, shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    customers = db.query(Customer).filter(Customer.user_id == user_id).order_by(Customer.id.desc()).all()
    customers_payload = []
    for c in customers:
        rooms_payload = []
        for room in c.rooms:
            renders = [f"/media/{r.image_path}" for attempt in room.attempts for r in attempt.renders]
            rooms_payload.append(
                {
                    "id": room.id,
                    "room_type": room.room_type,
                    "photo_url": f"/media/{room.photo_path}",
                    "created_at": room.created_at.isoformat() if room.created_at else None,
                    "renders": renders,
                }
            )
        customers_payload.append(
            {
                "id": c.id,
                "name": c.name,
                "created_at": c.created_at.isoformat() if c.created_at else None,
                "rooms": rooms_payload,
            }
        )
    return JSONResponse(
        content={"user": user_public(target), "customer_count": len(customers), "customers": customers_payload}
    )


class ResetPasswordBody(BaseModel):
    password: str
    shop_id: int | None = None


@app.post("/api/admin/users/{user_id}/reset-password")
def api_admin_reset_password(
    user_id: int, body: ResetPasswordBody, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    target = get_admin_mutable_target(user_id, owner, body.shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    if not body.password or len(body.password) < 4:
        return error_response(400, "weak_password", "Please choose a longer password.")
    target.password_hash = hash_password(body.password)
    db.commit()
    return JSONResponse(content={"ok": True})


@app.post("/api/admin/users/{user_id}/toggle-active")
def api_admin_toggle_active(
    user_id: int, shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    target = get_admin_mutable_target(user_id, owner, shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    target.active = not target.active
    db.commit()
    return JSONResponse(content={"user": user_public(target)})


class UpdateSalesmanBody(BaseModel):
    name: str
    mobile: str
    shop_id: int | None = None


@app.patch("/api/admin/users/{user_id}")
def api_admin_update_user(
    user_id: int,
    body: UpdateSalesmanBody,
    owner: User = Depends(require_owner_or_superadmin),
    db: Session = Depends(get_db),
) -> JSONResponse:
    target = get_admin_mutable_target(user_id, owner, body.shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    mobile = body.mobile.strip()
    if not body.name.strip() or not mobile:
        return error_response(400, "missing_fields", "Please fill in every field.")
    if db.query(User).filter(User.mobile == mobile, User.id != target.id).first() is not None:
        return error_response(409, "mobile_taken", "That mobile number is already registered to someone else.")
    target.name = body.name.strip()
    target.mobile = mobile
    db.commit()
    db.refresh(target)
    return JSONResponse(content={"user": user_public(target)})


@app.delete("/api/admin/users/{user_id}")
def api_admin_delete_user(
    user_id: int, shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    resolved_shop_id = resolve_admin_shop_id(owner, shop_id)
    target = get_admin_mutable_target(user_id, owner, shop_id, db)
    if isinstance(target, JSONResponse):
        return target
    shop_owner = (
        db.query(User)
        .filter(User.shop_id == resolved_shop_id, User.role == "owner", User.id != target.id)
        .first()
    )
    if shop_owner is None:
        return error_response(400, "no_owner", "This shop has no other owner to reassign customers to.")
    db.query(Customer).filter(Customer.user_id == target.id).update(
        {Customer.user_id: shop_owner.id}, synchronize_session=False
    )
    db.delete(target)
    db.commit()
    return JSONResponse(content={"ok": True})


# ---------------------------------------------------------------------------
# Admin — generation prompt
# ---------------------------------------------------------------------------


PROMPT_PAGE_KEYS = [
    PROMPT_SETTING_KEY,
    VISION_PROMPT_SETTING_KEY,
    VISION_MODEL_SETTING_KEY,
    PLACEMENT_WRITER_ENABLED_KEY,
    PLACEMENT_WRITER_PROMPT_KEY,
]


def prompt_setting_response(db: Session) -> dict:
    rows = {row.key: row for row in db.query(Setting).filter(Setting.key.in_(PROMPT_PAGE_KEYS))}

    def value(key: str, default: str) -> str:
        return rows[key].value if key in rows else default

    setting = rows.get(PROMPT_SETTING_KEY)
    return {
        "prompt": value(PROMPT_SETTING_KEY, DEFAULT_GENERATION_PROMPT),
        "default_prompt": DEFAULT_GENERATION_PROMPT,
        "updated_at": setting.updated_at.isoformat() if setting and setting.updated_at else None,
        "placeholders": PROMPT_PLACEHOLDERS,
        "vision_prompt": value(VISION_PROMPT_SETTING_KEY, DEFAULT_VISION_PROMPT),
        "default_vision_prompt": DEFAULT_VISION_PROMPT,
        "vision_model": value(VISION_MODEL_SETTING_KEY, DEFAULT_VISION_MODEL),
        "default_vision_model": DEFAULT_VISION_MODEL,
        "placement_writer_enabled": value(PLACEMENT_WRITER_ENABLED_KEY, "true").strip().lower() == "true",
        "placement_writer_prompt": value(PLACEMENT_WRITER_PROMPT_KEY, DEFAULT_PLACEMENT_WRITER_PROMPT),
        "default_placement_writer_prompt": DEFAULT_PLACEMENT_WRITER_PROMPT,
    }


@app.get("/api/admin/prompt")
def api_admin_get_prompt(
    shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    if resolve_admin_shop_id(owner, shop_id) is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    return JSONResponse(content=prompt_setting_response(db))


class PromptBody(BaseModel):
    prompt: str
    vision_prompt: str | None = None
    vision_model: str | None = None
    placement_writer_enabled: bool | None = None
    placement_writer_prompt: str | None = None
    shop_id: int | None = None


@app.post("/api/admin/prompt")
def api_admin_save_prompt(
    body: PromptBody, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    if resolve_admin_shop_id(owner, body.shop_id) is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    if not body.prompt.strip():
        return error_response(400, "empty_prompt", "The prompt can't be empty.")
    if body.vision_prompt is not None and not body.vision_prompt.strip():
        return error_response(400, "empty_vision_prompt", "The vision prompt can't be empty.")
    if body.vision_model is not None and not body.vision_model.strip():
        return error_response(400, "empty_vision_model", "The vision model can't be empty.")
    if body.placement_writer_prompt is not None and FACTS_TOKEN not in body.placement_writer_prompt:
        return error_response(
            400, "writer_prompt_missing_facts", f"The placement writer prompt must contain {FACTS_TOKEN} where the facts go."
        )
    set_setting(db, PROMPT_SETTING_KEY, body.prompt)
    if body.vision_prompt is not None:
        set_setting(db, VISION_PROMPT_SETTING_KEY, body.vision_prompt.strip())
    if body.vision_model is not None:
        set_setting(db, VISION_MODEL_SETTING_KEY, body.vision_model.strip())
    if body.placement_writer_enabled is not None:
        set_setting(db, PLACEMENT_WRITER_ENABLED_KEY, "true" if body.placement_writer_enabled else "false")
    if body.placement_writer_prompt is not None:
        set_setting(db, PLACEMENT_WRITER_PROMPT_KEY, body.placement_writer_prompt)
    return JSONResponse(content=prompt_setting_response(db))


@app.post("/api/admin/prompt/reset")
def api_admin_reset_prompt(
    shop_id: int | None = None, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    if resolve_admin_shop_id(owner, shop_id) is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    set_setting(db, PROMPT_SETTING_KEY, DEFAULT_GENERATION_PROMPT)
    return JSONResponse(content=prompt_setting_response(db))


# ---------------------------------------------------------------------------
# Debug — exactly what was sent to the model for a given render
# ---------------------------------------------------------------------------


@app.get("/api/debug/generation/{render_id}")
def api_debug_generation(
    render_id: int, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    render = db.query(Render).filter(Render.id == render_id).first()
    if render is None:
        return error_response(404, "render_not_found", "That render could not be found.")
    debug_row = db.query(GenerationDebug).filter(GenerationDebug.render_id == render_id).first()
    if debug_row is None:
        return error_response(404, "no_debug_data", "No debug data was recorded for this render.")
    attempt = render.attempt
    room = attempt.room if attempt else None
    return JSONResponse(
        content={
            "render_id": render.id,
            "attempt_id": render.attempt_id,
            "customer_name": room.customer.name if room else None,
            "output_image_url": f"/media/{render.image_path}",
            "created_at": render.created_at.isoformat() if render.created_at else None,
            "prompt": debug_row.prompt,
            "model": debug_row.model,
            "quality": debug_row.quality,
            "size": debug_row.size,
            "elapsed_s": debug_row.elapsed_s,
            "usage": debug_row.usage,
            "images": debug_row.images,
            "placement_writer": debug_row.placement_writer,
        }
    )


@app.get("/debug/latest")
def debug_latest(owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)) -> Response:
    debug_row = db.query(GenerationDebug).order_by(GenerationDebug.id.desc()).first()
    if debug_row is None:
        raise HTTPException(status_code=404, detail="No generations have been recorded yet.")
    return RedirectResponse(url=f"/debug/generation/{debug_row.render_id}")


# ---------------------------------------------------------------------------
# React frontend — served at /, SPA fallback to index.html for client-side
# routing on any path that isn't a real built asset.
# ---------------------------------------------------------------------------


@app.get("/{full_path:path}")
async def serve_react_app(full_path: str = "") -> Response:
    if full_path.startswith(("api/", "media/")):
        raise HTTPException(status_code=404)
    if not FRONTEND_DIST_DIR.is_dir():
        raise HTTPException(status_code=404, detail="Frontend build not found. Run `npm run build` in frontend/.")
    candidate = FRONTEND_DIST_DIR / full_path
    if full_path and candidate.is_file():
        return FileResponse(str(candidate))
    return FileResponse(str(FRONTEND_DIST_DIR / "index.html"))

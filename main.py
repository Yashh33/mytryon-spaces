import asyncio
import base64
import calendar
import io
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
from PIL import Image, ImageDraw, ImageOps
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
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

load_dotenv()

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
DEBUG_DIR = DATA_ROOT / "debug"
for d in (ROOMS_DIR, ITEMS_DIR, RENDERS_DIR, DEBUG_DIR):
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
You are compositing furniture into a photograph of a real room.

CAMERA — highest priority
Reproduce the room photograph from the exact same camera position,
height, angle and focal length. Do not re-frame, re-crop, zoom, pan or
change the perspective in any way. The output must look like the same
photograph with furniture added, not a new photograph of the same room.

ROOM — do not alter
Preserve the room exactly: wall positions, room width, depth and
ceiling height, floor material and pattern, windows, doors, balcony
openings, curtains, ceiling fan, light fixtures, and the direction and
colour of the existing light. Do not enlarge, shrink or reproportion
the space. Do not add or remove architectural features.

PRODUCT DESIGN — take from the reference photograph
For each piece, reproduce its design language exactly as shown in its
reference photograph: fabric, colour, texture, weave, stitching,
tufting pattern, arm profile, back profile, leg or plinth style,
cushion style and overall visual character.

PRODUCT CONFIGURATION — take from the written specification
Each piece has a written type and width. Build the piece at that size
and in that seating configuration, even where the reference photograph
shows a different one. A two-seater reference at a stated seven feet
must be rendered as a seven-foot version of that same design, with
seat count and proportions extended naturally and consistently.

When the photograph and the specification disagree:
- the photograph decides material, colour, texture and design detail
- the specification decides length, seat count and configuration

PLACEMENT AND SCALE
Place each piece flat on the floor plane with correct contact shadows.
Scale each piece to its stated width relative to the room's visible
architecture — door heights, window sills, floor tiles and ceiling
height are the references. A seven-foot sofa must measure seven feet
against those cues.
Remove any existing furniture occupying the target area and rebuild the
floor and wall behind it consistently.

CLEAR THE SPACE
Remove people, workers, ladders, tools, paint buckets, cement bags,
stacked tiles, packaging and construction debris. Finish any visibly
unfinished surfaces — bare plaster becomes painted wall, exposed screed
becomes finished flooring — while keeping the same materials, layout
and proportions.

EXCLUDE FROM THE PRODUCT REFERENCE
Transfer only the furniture itself. Do not bring across rugs, cushions,
coffee tables, plants, lamps, artwork or any staging visible in the
product photograph unless that item was separately specified.

FINISH
Render a warm, inviting, lived-in interior. Soft warm lighting, gentle
shadows, clean finished surfaces. Photographic realism at the same
exposure and white balance as the room photograph. This is an
aspirational image for a customer deciding on a purchase.

THIS REQUEST
Room type: {{ROOM_TYPE}}
Pieces, in the same order as the product reference photographs:
{{PIECES}}

{{#PLACEMENT}}
PLACEMENT ANNOTATION
Two versions of the room are provided. The first is the clean
photograph and is the canvas you must render. The second is the same
photograph with hand-drawn coloured lines added.

Each coloured line traces where the correspondingly coloured piece
should sit: the line follows that piece's footprint on the floor and
indicates its position, its extent and the direction it faces. For an
L-shaped or sectional piece, the bend in the line shows where the
piece turns and which way each section runs.

Treat the lines as a rough hand sketch, not a precise boundary. Match
the intent — placement, orientation and approximate size — while
keeping the piece's true proportions.

The lines are annotation only. They are not objects, rugs, cables or
markings in the room. Do not render the lines, their colour or any
trace of them in your output. Render the clean room with the
furniture placed as the lines indicate.

Colour key: {{STROKE_MAP}}
{{/PLACEMENT}}
"""

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
        "token": "{{STROKE_MAP}}",
        "description": 'Inside the {{#PLACEMENT}}…{{/PLACEMENT}} block only: one line per piece with hand-drawn strokes, e.g. "Orange — L-shape sofa, 7 ft".',
    },
    {
        "token": "{{#PLACEMENT}} … {{/PLACEMENT}}",
        "description": "Wraps the placement-annotation section. Only appears in the prompt sent to the model when at least one piece has been drawn on in the /place screen — removed entirely otherwise, so it's safe to reword or move but keep both tags.",
    },
    {
        "token": "{{IMAGE_MANIFEST}}",
        "description": 'One line per image, in the exact order sent to the model, e.g. "Image 1 is a room." / "Image 2 is the same room as Image 1 with coloured lines drawn on it." / "Image 3 is a showroom photograph of a sofa...". The numbering always matches the real send order — without strokes, image 2 becomes the first product.',
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

CREDITS_PER_GENERATION = 30
SUPERADMIN_MOBILE = "9016233480"

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
    "Sofa": ["3+2", "3+3", "L-shape", "Curved"],
    "Dining table": ["4 seater", "6 seater", "8 seater"],
    "Chair": ["Single", "Pair"],
    "Bed": ["Single", "Queen", "King"],
}

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
    mobile = Column(String, nullable=False, unique=True)
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
    # list of strokes, each a list of {"x": 0-1, "y": 0-1} points normalised
    # to the room photo's width/height. Nullable; empty/None means no drawing.
    strokes = Column(JSON, nullable=True)


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
    # ordered list of {filename, role, width, height, size_bytes, url}
    images = Column(JSON, nullable=False)
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
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
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

    if db.query(User).filter(User.mobile == SUPERADMIN_MOBILE).first() is None:
        db.add(
            User(
                shop_id=None,
                name="Yash",
                mobile=SUPERADMIN_MOBILE,
                password_hash=hash_password(uuid.uuid4().hex),
                role="superadmin",
                active=True,
            )
        )

    db.add(CreditLedger(shop_id=shop.id, user_id=None, delta=shop.monthly_credits, reason="allocation"))
    db.flush()
    logger.info("multi-tenant migration complete: created shop %r", shop.name)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        # migrate DBs created before free-hand placement drawing existed:
        # drop the old pin columns, add the new strokes column, additively.
        conn.execute(text("ALTER TABLE items DROP COLUMN IF EXISTS pin_x"))
        conn.execute(text("ALTER TABLE items DROP COLUMN IF EXISTS pin_y"))
        conn.execute(text("ALTER TABLE items ADD COLUMN IF NOT EXISTS strokes JSON"))
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
        db.query(Setting).filter(Setting.key.in_(["image_quality", "size_mode"])).delete(synchronize_session=False)

        migrate_to_shops(db)

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


async def read_validated_upload(upload: UploadFile) -> bytes:
    content_type = upload.content_type or ""
    if not content_type.startswith("image/"):
        raise UploadValidationError(400, "invalid_type", "That doesn't look like a photo. Please choose an image.")
    data = await upload.read()
    if len(data) == 0:
        raise UploadValidationError(400, "empty_upload", "That photo looks empty. Please try another.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadValidationError(400, "too_large", "That photo is too large. Please use one under 12MB.")
    return data


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
    data = await read_validated_upload(upload)
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


def save_marked_copy_with_debug(image: Image.Image) -> tuple[tuple[str, bytes, str], dict]:
    """Saves the marked copy to DEBUG_DIR (never discarded, for the debug
    view) and returns both the OpenAI-bound file tuple and its descriptor."""
    filename = f"{uuid.uuid4().hex}.jpg"
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92)
    data = buf.getvalue()
    (DEBUG_DIR / filename).write_bytes(data)
    url = f"/media/debug/{filename}"
    file_tuple = ("marked-copy.jpg", data, "image/jpeg")
    descriptor = {
        "filename": "marked-copy.jpg", "role": "marked_copy", "width": image.width, "height": image.height,
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


PLACEMENT_BLOCK_RE = re.compile(r"\{\{#PLACEMENT\}\}(.*?)\{\{/PLACEMENT\}\}", re.DOTALL)
CONFIG_NOTES_BLOCK_RE = re.compile(r"\{\{#CONFIG_NOTES\}\}(.*?)\{\{/CONFIG_NOTES\}\}", re.DOTALL)

STROKE_COLORS = ["#F07522", "#2563EB", "#16A34A", "#9333EA"]
STROKE_COLOR_NAMES = ["Orange", "Blue", "Green", "Purple"]

# Definitions for {{CONFIG_NOTES}}, keyed by (category, type) since "Single"
# means different things for a Chair and a Bed. Only types with an entry
# here ever produce a note; "3+2+1" isn't a selectable type yet but is kept
# for when it is.
CONFIG_NOTES = {
    ("Sofa", "3+2"): "A set of two separate sofas: one three-seater and one two-seater, placed as a pair around the same coffee table, usually at right angles or facing each other. Not one continuous sofa.",
    ("Sofa", "3+3"): "A set of two separate three-seater sofas, placed as a pair, usually facing each other or at right angles. Not one continuous sofa.",
    ("Sofa", "3+2+1"): "A set of three separate pieces: a three-seater sofa, a two-seater sofa and a single armchair.",
    ("Sofa", "L-shape"): "One continuous sectional sofa with a single right-angle turn forming an L. A single piece, not a set.",
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


def numbered_items(items: list[Item]) -> list[tuple[int, Item]]:
    """Piece numbers are 1-based position in the list — the same order the
    product reference photos are sent to the model and the placement chips
    show."""
    return list(enumerate(items, start=1))


def marked_items(items: list[Item], ignore_placement: bool) -> list[tuple[int, Item]]:
    if ignore_placement:
        return []
    return [(n, item) for n, item in numbered_items(items) if item.strokes]


def build_image_manifest(items: list[Item], marked: list[tuple[int, Item]]) -> str:
    """One line per image, in the exact order sent to the model — the whole
    point being that the numbering here always matches reality. Product
    lines describe the photo as a design reference only (material, colour,
    texture, styling), never as already being in the requested
    configuration — otherwise the model copies the photographed seat count
    instead of building what was actually asked for."""
    lines = ["Image 1 is a room."]
    n = 2
    if marked:
        lines.append(f"Image {n} is the same room as Image 1 with coloured lines drawn on it.")
        n += 1
    for item in items:
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


def build_prompt(
    template: str,
    room_type: str,
    items: list[Item],
    marked: list[tuple[int, Item]],
    room_treatment: str,
    lighting: str,
) -> str:
    pieces = "\n".join(f"- {item.category} ({item.type}), {item.width_ft:g} ft wide" for item in items)
    image_manifest = build_image_manifest(items, marked)
    config_notes = build_config_notes(items)
    room_treatment_text = ROOM_TREATMENT_TEXT.get(room_treatment, ROOM_TREATMENT_TEXT[DEFAULT_ROOM_TREATMENT])
    lighting_text = LIGHTING_TEXT.get(lighting, LIGHTING_TEXT[DEFAULT_LIGHTING])

    if marked:
        stroke_map = "\n".join(
            f"{STROKE_COLOR_NAMES[(n - 1) % len(STROKE_COLOR_NAMES)]} — {item.type} {item.category.lower()}, {item.width_ft:g} ft"
            for n, item in marked
        )

        def unwrap_placement(match: re.Match) -> str:
            return match.group(1).replace("{{STROKE_MAP}}", stroke_map)

        template = PLACEMENT_BLOCK_RE.sub(unwrap_placement, template)
    else:
        template = PLACEMENT_BLOCK_RE.sub("", template)

    if config_notes:
        def unwrap_config_notes(match: re.Match) -> str:
            return match.group(1).replace("{{CONFIG_NOTES}}", config_notes)

        template = CONFIG_NOTES_BLOCK_RE.sub(unwrap_config_notes, template)
    else:
        template = CONFIG_NOTES_BLOCK_RE.sub("", template)

    prompt = (
        template.replace("{{ROOM_TYPE}}", room_type)
        .replace("{{PIECES}}", pieces)
        .replace("{{IMAGE_MANIFEST}}", image_manifest)
        .replace("{{CONFIG_NOTES}}", config_notes)  # covers bare (unwrapped) use too
        .replace("{{ROOM_TREATMENT}}", room_treatment_text)
        .replace("{{LIGHTING}}", lighting_text)
    )
    return re.sub(r"\n{3,}", "\n\n", prompt).rstrip() + "\n"


def build_marked_room_image(room_photo_path: Path, marked: list[tuple[int, Item]]) -> Image.Image | None:
    """Draws each piece's hand-drawn strokes, in that piece's colour, on a
    copy of the room photo. The original file is never touched; this copy
    exists only in memory for the duration of one generation call."""
    if not marked:
        return None
    image = Image.open(room_photo_path).convert("RGB").copy()
    draw = ImageDraw.Draw(image)
    stroke_width = max(3, int(image.width * 0.015))
    radius = stroke_width / 2
    for number, item in marked:
        color = STROKE_COLORS[(number - 1) % len(STROKE_COLORS)]
        for stroke in item.strokes or []:
            points = [(p["x"] * image.width, p["y"] * image.height) for p in stroke]
            if len(points) >= 2:
                draw.line(points, fill=color, width=stroke_width, joint="curve")
            # rounded caps/joins: cap every vertex (including single-point
            # "dot" strokes) with a filled circle of the same width
            for x, y in points:
                draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)
    return image


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
# Generation jobs — POST starts a background job, the client polls for the
# result so the flow survives the phone locking or the tab backgrounding.
# ---------------------------------------------------------------------------

JOBS: dict[str, dict] = {}


def refund_generation_credits(db: Session, shop_id: int, user_id: int, attempt_id: int | None) -> None:
    db.add(CreditLedger(shop_id=shop_id, user_id=user_id, attempt_id=attempt_id, delta=CREDITS_PER_GENERATION, reason="refund"))
    db.commit()


async def run_generation_job(job_id: str, attempt_id: int, user_id: int, shop_id: int, ignore_placement: bool = False) -> None:
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
        marked = marked_items(attempt.items, ignore_placement)
        template = get_active_prompt(db)
        prompt = build_prompt(template, room.room_type, attempt.items, marked, attempt.room_treatment, attempt.lighting)

        room_path = DATA_ROOT / room.photo_path
        with Image.open(room_path) as room_image:
            size = derive_size(*room_image.size)

        image_files: list[tuple[str, bytes, str]] = []
        debug_images: list[dict] = []

        room_file, room_debug = load_local_image_with_debug(room_path, "room", f"/media/{room.photo_path}")
        image_files.append(room_file)
        debug_images.append(room_debug)

        marked_image = build_marked_room_image(room_path, marked)
        if marked_image is not None:
            marked_file, marked_debug = save_marked_copy_with_debug(marked_image)
            image_files.append(marked_file)
            debug_images.append(marked_debug)

        for item in attempt.items:
            item_file, item_debug = load_local_image_with_debug(
                DATA_ROOT / item.photo_path, "product", f"/media/{item.photo_path}"
            )
            image_files.append(item_file)
            debug_images.append(item_debug)

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
            )
        )
        usage = result["usage"]
        db.add(
            CreditLedger(
                shop_id=shop_id,
                user_id=user_id,
                attempt_id=attempt.id,
                render_id=render.id,
                delta=0,
                reason="generation",
                tokens_in=usage.get("input_tokens") if usage else None,
                tokens_out=usage.get("output_tokens") if usage else None,
                usd_cost=compute_usd_cost(usage),
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


@app.post("/api/login")
def api_login(body: LoginBody, db: Session = Depends(get_db)) -> JSONResponse:
    user = db.query(User).filter(User.mobile == body.mobile.strip()).first()
    if user is None or not user.active or not verify_password(body.password, user.password_hash):
        return error_response(401, "invalid_credentials", "That mobile number or password is incorrect.")
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
        "strokes": item.strokes or [],
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

    item = Item(attempt_id=attempt.id, category=category, type=type_, width_ft=width_ft, photo_path=photo_path)
    db.add(item)
    db.commit()
    db.refresh(attempt)
    return attempt


def _delete_item_from_attempt(attempt: Attempt, item_id: int, db: Session) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    db.delete(item)
    db.commit()
    db.refresh(attempt)
    return attempt


class StrokePoint(BaseModel):
    x: float
    y: float


class StrokeBody(BaseModel):
    points: list[StrokePoint]


def validated_stroke_points(points: list[StrokePoint]) -> list[dict] | None:
    if not points:
        return None
    cleaned = []
    for p in points:
        if not (0 <= p.x <= 1) or not (0 <= p.y <= 1):
            return None
        cleaned.append({"x": p.x, "y": p.y})
    return cleaned


def _add_stroke(attempt: Attempt, item_id: int, points: list[StrokePoint], db: Session) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    cleaned = validated_stroke_points(points)
    if cleaned is None:
        return error_response(400, "invalid_stroke", "That stroke is outside the photo.")
    item.strokes = [*(item.strokes or []), cleaned]
    db.commit()
    db.refresh(attempt)
    return attempt


def _undo_stroke(attempt: Attempt, item_id: int, db: Session) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    item.strokes = (item.strokes or [])[:-1]
    db.commit()
    db.refresh(attempt)
    return attempt


def _clear_strokes(attempt: Attempt, item_id: int, db: Session) -> Attempt | JSONResponse:
    item = db.query(Item).filter(Item.id == item_id, Item.attempt_id == attempt.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    item.strokes = []
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
    asyncio.create_task(run_generation_job(job_id, attempt.id, user.id, shop.id, ignore_placement))
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
    db.commit()
    db.refresh(room)
    return JSONResponse(content={"room": room_detail(room)})


@app.get("/api/rooms/{room_id}")
def api_get_room(room_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> JSONResponse:
    room = get_owned_room(room_id, user, db)
    attempts = sorted(room.attempts, key=lambda a: a.id, reverse=True)
    return JSONResponse(content={"room": room_detail(room), "attempts": [attempt_summary(a) for a in attempts]})


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
                strokes=item.strokes,
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


@app.delete("/api/attempts/{attempt_id}/items/{item_id}")
def api_delete_item_from_attempt(
    attempt_id: int, item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _delete_item_from_attempt(attempt, item_id, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.post("/api/attempts/{attempt_id}/items/{item_id}/strokes")
def api_add_stroke_to_attempt(
    attempt_id: int,
    item_id: int,
    body: StrokeBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _add_stroke(attempt, item_id, body.points, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.post("/api/attempts/{attempt_id}/items/{item_id}/strokes/undo")
def api_undo_stroke_from_attempt(
    attempt_id: int, item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _undo_stroke(attempt, item_id, db)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse(content={"attempt": attempt_detail(result)})


@app.delete("/api/attempts/{attempt_id}/items/{item_id}/strokes")
def api_clear_strokes_from_attempt(
    attempt_id: int, item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    attempt = get_owned_attempt(attempt_id, user, db)
    result = _clear_strokes(attempt, item_id, db)
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
    owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    if owner.shop_id is None:
        return error_response(400, "no_shop_context", "Select a shop first.")
    shop = db.query(Shop).filter(Shop.id == owner.shop_id).first()
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


@app.get("/api/admin/users")
def api_admin_list_users(q: str = "", owner: User = Depends(require_owner), db: Session = Depends(get_db)) -> JSONResponse:
    query = db.query(User).filter(User.role == "salesman", User.shop_id == owner.shop_id)
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter((User.name.ilike(like)) | (User.mobile.ilike(like)))
    users = query.order_by(User.name).all()
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
    body: CreateSalesmanBody, owner: User = Depends(require_owner), db: Session = Depends(get_db)
) -> JSONResponse:
    mobile = body.mobile.strip()
    if not body.name.strip() or not mobile or not body.password:
        return error_response(400, "missing_fields", "Please fill in every field.")
    if db.query(User).filter(User.mobile == mobile).first() is not None:
        return error_response(409, "mobile_taken", "That mobile number is already registered.")
    user = User(
        shop_id=owner.shop_id,
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


@app.get("/api/admin/users/{user_id}")
def api_admin_user_detail(user_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)) -> JSONResponse:
    """Legacy shape for the static/ admin detail screen: one flattened
    "project" card per room, customer name attached, renders aggregated
    across all of that room's attempts. See /api/admin/user/{id} for the
    real customers -> rooms -> renders hierarchy."""
    target = db.query(User).filter(User.id == user_id, User.shop_id == owner.shop_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
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
    user_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)
) -> JSONResponse:
    """The real hierarchy: customers -> rooms -> renders (aggregated across
    each room's attempts)."""
    target = db.query(User).filter(User.id == user_id, User.shop_id == owner.shop_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
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


@app.post("/api/admin/users/{user_id}/reset-password")
def api_admin_reset_password(
    user_id: int, body: ResetPasswordBody, owner: User = Depends(require_owner), db: Session = Depends(get_db)
) -> JSONResponse:
    target = db.query(User).filter(User.id == user_id, User.shop_id == owner.shop_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
    if not body.password or len(body.password) < 4:
        return error_response(400, "weak_password", "Please choose a longer password.")
    target.password_hash = hash_password(body.password)
    db.commit()
    return JSONResponse(content={"ok": True})


@app.post("/api/admin/users/{user_id}/toggle-active")
def api_admin_toggle_active(user_id: int, owner: User = Depends(require_owner), db: Session = Depends(get_db)) -> JSONResponse:
    target = db.query(User).filter(User.id == user_id, User.shop_id == owner.shop_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
    target.active = not target.active
    db.commit()
    return JSONResponse(content={"user": user_public(target)})


# ---------------------------------------------------------------------------
# Admin — generation prompt
# ---------------------------------------------------------------------------


def prompt_setting_response(db: Session, setting: Setting | None) -> dict:
    return {
        "prompt": setting.value if setting else DEFAULT_GENERATION_PROMPT,
        "default_prompt": DEFAULT_GENERATION_PROMPT,
        "updated_at": setting.updated_at.isoformat() if setting and setting.updated_at else None,
        "placeholders": PROMPT_PLACEHOLDERS,
    }


@app.get("/api/admin/prompt")
def api_admin_get_prompt(owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)) -> JSONResponse:
    setting = db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first()
    return JSONResponse(content=prompt_setting_response(db, setting))


class PromptBody(BaseModel):
    prompt: str


@app.post("/api/admin/prompt")
def api_admin_save_prompt(
    body: PromptBody, owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    if not body.prompt.strip():
        return error_response(400, "empty_prompt", "The prompt can't be empty.")
    setting = set_setting(db, PROMPT_SETTING_KEY, body.prompt)
    return JSONResponse(content=prompt_setting_response(db, setting))


@app.post("/api/admin/prompt/reset")
def api_admin_reset_prompt(
    owner: User = Depends(require_owner_or_superadmin), db: Session = Depends(get_db)
) -> JSONResponse:
    setting = set_setting(db, PROMPT_SETTING_KEY, DEFAULT_GENERATION_PROMPT)
    return JSONResponse(content=prompt_setting_response(db, setting))


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

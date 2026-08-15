import asyncio
import io
import logging
import mimetypes
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import bcrypt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from PIL import Image, ImageDraw, ImageFont, ImageOps
from pydantic import BaseModel
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("mytryon")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Disk root for uploaded photos and renders: /data on Render (mounted disk),
# ./data for local dev. Override with DATA_DIR if needed.
DATA_ROOT = Path(os.environ.get("DATA_DIR") or ("/data" if Path("/data").is_dir() else BASE_DIR / "data"))
ROOMS_DIR = DATA_ROOT / "rooms"
ITEMS_DIR = DATA_ROOT / "items"
RENDERS_DIR = DATA_ROOT / "renders"
for d in (ROOMS_DIR, ITEMS_DIR, RENDERS_DIR):
    d.mkdir(parents=True, exist_ok=True)

MODEL_NAME = "gemini-3.1-flash-image"

# ---------------------------------------------------------------------------
# GEMINI PROMPT — the live prompt lives in the `settings` table (key
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

{{#PINS}}
PLACEMENT REFERENCE
Two versions of the room are provided. The first is the clean
photograph and is the canvas you must render. The second is an
annotated copy showing numbered circular markers.

Each marker indicates where the correspondingly numbered piece
should stand, the marker's position being the floor contact point
at the centre of that piece's footprint.

The markers are guidance only. They are not objects in the room.
Do not render the markers, circles, numbers or any annotation in
your output. Render the clean room with the furniture placed at
the marked positions.

Marker numbers correspond to: {{PIN_MAP}}
{{/PINS}}
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
        "token": "{{PIN_MAP}}",
        "description": 'Inside the {{#PINS}}…{{/PINS}} block only: one line per pinned piece, e.g. "Marker 1 — L-shape sofa, 7 ft".',
    },
    {
        "token": "{{#PINS}} … {{/PINS}}",
        "description": "Wraps the placement-reference section. Only appears in the prompt sent to the model when at least one piece has a pin placed on the /place screen — removed entirely otherwise, so it's safe to reword or move but keep both tags.",
    },
]

# ---------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_IMAGE_DIMENSION = 1536
MAX_ITEMS_PER_PROJECT = 4
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

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
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


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    mobile = Column(String, nullable=False, unique=True)
    password_hash = Column(String, nullable=False)
    role = Column(String, nullable=False, default="salesman")  # 'salesman' | 'admin'
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    customer_name = Column(String, nullable=False)
    room_type = Column(String, nullable=False)
    room_photo_path = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    items = relationship("Item", backref="project", cascade="all, delete-orphan", order_by="Item.id")
    renders = relationship("Render", backref="project", cascade="all, delete-orphan", order_by="Render.id")


class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    category = Column(String, nullable=False)
    type = Column(String, nullable=False)
    width_ft = Column(Float, nullable=False)
    photo_path = Column(String, nullable=False)
    pin_x = Column(Float, nullable=True)  # normalised 0-1, relative to room photo width
    pin_y = Column(Float, nullable=True)  # normalised 0-1, relative to room photo height


class Render(Base):
    __tablename__ = "renders"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    image_path = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        # additive migration for DBs created before placement pins existed
        conn.execute(text("ALTER TABLE items ADD COLUMN IF NOT EXISTS pin_x DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE items ADD COLUMN IF NOT EXISTS pin_y DOUBLE PRECISION"))
    db = SessionLocal()
    try:
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
            db.commit()
            logger.info("seeded %d users", len(SEED_USERS))
        if db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first() is None:
            db.add(Setting(key=PROMPT_SETTING_KEY, value=DEFAULT_GENERATION_PROMPT))
            db.commit()
            logger.info("seeded default generation prompt")
    finally:
        db.close()
    yield


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
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


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admins only.")
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


def load_local_image_part(path: Path) -> types.Part:
    mime_type, _ = mimetypes.guess_type(path.name)
    return types.Part.from_bytes(data=path.read_bytes(), mime_type=mime_type or "image/jpeg")


BLOCKED_FINISH_REASONS = {
    types.FinishReason.SAFETY,
    types.FinishReason.PROHIBITED_CONTENT,
    types.FinishReason.IMAGE_SAFETY,
    types.FinishReason.IMAGE_PROHIBITED_CONTENT,
    types.FinishReason.BLOCKLIST,
    types.FinishReason.SPII,
    types.FinishReason.RECITATION,
    types.FinishReason.IMAGE_RECITATION,
}


def blocked_reason(response: types.GenerateContentResponse) -> str | None:
    feedback = getattr(response, "prompt_feedback", None)
    if feedback is not None and getattr(feedback, "block_reason", None):
        return f"prompt_blocked:{feedback.block_reason}"
    if not response.candidates:
        return "no_candidates"
    finish_reason = response.candidates[0].finish_reason
    if finish_reason in BLOCKED_FINISH_REASONS:
        return f"finish_reason:{finish_reason}"
    return None


def extract_image(response: types.GenerateContentResponse) -> tuple[bytes, str] | None:
    try:
        parts = response.parts
    except Exception:
        return None
    if not parts:
        return None
    for part in parts:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data, part.inline_data.mime_type or "image/png"
    return None


def is_rate_limited(exc: Exception) -> bool:
    message = str(exc)
    return "429" in message or "RESOURCE_EXHAUSTED" in message.upper()


class GenerationError(Exception):
    """Terminal, user-facing generation failure after retries are exhausted."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def get_active_prompt(db: Session) -> str:
    """Loaded fresh on every generation — never cached — so admin edits to
    /admin/prompt take effect immediately with no redeploy."""
    setting = db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first()
    return setting.value if setting else DEFAULT_GENERATION_PROMPT


PIN_BLOCK_RE = re.compile(r"\{\{#PINS\}\}(.*?)\{\{/PINS\}\}", re.DOTALL)


def numbered_items(items: list[Item]) -> list[tuple[int, Item]]:
    """Piece numbers are 1-based position in the list — the same order the
    product reference photos are sent to Gemini and the /place chips show."""
    return list(enumerate(items, start=1))


def pinned_items(items: list[Item], ignore_pins: bool) -> list[tuple[int, Item]]:
    if ignore_pins:
        return []
    return [(n, item) for n, item in numbered_items(items) if item.pin_x is not None and item.pin_y is not None]


def build_prompt(template: str, room_type: str, items: list[Item], pinned: list[tuple[int, Item]]) -> str:
    pieces = "\n".join(f"- {item.category} ({item.type}), {item.width_ft:g} ft wide" for item in items)

    if pinned:
        pin_map = "\n".join(f"Marker {n} — {item.type} {item.category.lower()}, {item.width_ft:g} ft" for n, item in pinned)

        def unwrap_block(match: re.Match) -> str:
            return match.group(1).replace("{{PIN_MAP}}", pin_map)

        template = PIN_BLOCK_RE.sub(unwrap_block, template)
    else:
        template = PIN_BLOCK_RE.sub("", template)

    prompt = template.replace("{{ROOM_TYPE}}", room_type).replace("{{PIECES}}", pieces)
    return re.sub(r"\n{3,}", "\n\n", prompt).rstrip() + "\n"


MARKER_COLORS = ["#F07522", "#1A1815", "#CE5C10", "#8A857E"]


def build_marked_room_image(room_photo_path: Path, pinned: list[tuple[int, Item]]) -> Image.Image | None:
    """Draws a filled, numbered circle at each pinned piece's floor contact
    point on a copy of the room photo. The original file is never touched;
    this copy exists only in memory for the duration of one generation call."""
    if not pinned:
        return None
    image = Image.open(room_photo_path).convert("RGB").copy()
    draw = ImageDraw.Draw(image)
    diameter = image.width * 0.06
    radius = diameter / 2
    font = ImageFont.load_default(size=max(14, int(diameter * 0.55)))
    for number, item in pinned:
        cx = item.pin_x * image.width
        cy = item.pin_y * image.height
        color = MARKER_COLORS[(number - 1) % len(MARKER_COLORS)]
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            fill=color,
            outline="white",
            width=max(2, int(diameter * 0.05)),
        )
        text_str = str(number)
        bbox = draw.textbbox((0, 0), text_str, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text_str, fill="white", font=font)
    return image


def image_to_part(image: Image.Image) -> types.Part:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92)
    return types.Part.from_bytes(data=buf.getvalue(), mime_type="image/jpeg")


def call_gemini(prompt: str, parts: list[types.Part], log_label: str) -> bytes:
    """Calls Gemini with retry on rate limits, safety blocks and empty
    responses. Runs synchronously — callers should offload to a thread."""
    last_error = "unknown"
    for attempt in range(GENERATION_RETRIES + 1):
        start = time.monotonic()
        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=[prompt, *parts],
                config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
            )
        except Exception as exc:
            elapsed_ms = (time.monotonic() - start) * 1000
            retryable = is_rate_limited(exc)
            logger.info(
                "gen label=%s attempt=%d elapsed_ms=%.0f result=exception:%s retryable=%s",
                log_label, attempt, elapsed_ms, exc.__class__.__name__, retryable,
            )
            last_error = "rate_limited" if retryable else "model_error"
            if retryable and attempt < GENERATION_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            if retryable:
                raise GenerationError("The service is a little busy right now. Please try again in a moment.")
            raise GenerationError("Something went wrong generating your image. Please try again.")

        elapsed_ms = (time.monotonic() - start) * 1000
        block_reason = blocked_reason(response)
        if block_reason:
            logger.info("gen label=%s attempt=%d elapsed_ms=%.0f result=%s", log_label, attempt, elapsed_ms, block_reason)
            last_error = "blocked"
            if attempt < GENERATION_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            raise GenerationError("We couldn't generate a result for those photos. Try a different angle or photo.")

        image = extract_image(response)
        if image is None:
            logger.info("gen label=%s attempt=%d elapsed_ms=%.0f result=empty_response", log_label, attempt, elapsed_ms)
            last_error = "empty_response"
            if attempt < GENERATION_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                continue
            raise GenerationError("That attempt didn't produce an image. Please try again.")

        logger.info("gen label=%s attempt=%d elapsed_ms=%.0f result=success", log_label, attempt, elapsed_ms)
        return image[0]

    raise GenerationError("Something went wrong generating your image. Please try again.")


def error_response(status_code: int, error: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error, "message": message})


# ---------------------------------------------------------------------------
# Generation jobs — POST starts a background job, the client polls for the
# result so the flow survives the phone locking or the tab backgrounding.
# ---------------------------------------------------------------------------

JOBS: dict[str, dict] = {}


async def run_generation_job(job_id: str, project_id: int, user_id: int, ignore_pins: bool = False) -> None:
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == user_id).first()
        if project is None:
            JOBS[job_id] = {"status": "error", "message": "That project could not be found."}
            return
        if not project.items:
            JOBS[job_id] = {"status": "error", "message": "Add at least one piece of furniture first."}
            return

        pinned = pinned_items(project.items, ignore_pins)
        template = get_active_prompt(db)
        prompt = build_prompt(template, project.room_type, project.items, pinned)
        room_part = load_local_image_part(DATA_ROOT / project.room_photo_path)
        marked_image = build_marked_room_image(DATA_ROOT / project.room_photo_path, pinned)
        item_parts = [load_local_image_part(DATA_ROOT / item.photo_path) for item in project.items]

        parts = [room_part]
        if marked_image is not None:
            parts.append(image_to_part(marked_image))
        parts.extend(item_parts)

        try:
            image_bytes = await asyncio.to_thread(call_gemini, prompt, parts, f"project:{project_id}")
        except GenerationError as exc:
            JOBS[job_id] = {"status": "error", "message": exc.message}
            return

        filename = f"{uuid.uuid4().hex}.jpg"
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image.save(RENDERS_DIR / filename, format="JPEG", quality=92)
        relative_path = f"renders/{filename}"

        render = Render(project_id=project.id, image_path=relative_path)
        db.add(render)
        db.commit()
        db.refresh(render)

        JOBS[job_id] = {
            "status": "done",
            "render_id": render.id,
            "project_id": project.id,
            "image_url": f"/media/{relative_path}",
        }
    except Exception:
        logger.exception("generation job failed job_id=%s project_id=%s", job_id, project_id)
        JOBS[job_id] = {"status": "error", "message": "Something went wrong generating your image. Please try again."}
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
# Project routes
# ---------------------------------------------------------------------------


def project_summary(project: Project) -> dict:
    latest_render = project.renders[-1] if project.renders else None
    return {
        "id": project.id,
        "customer_name": project.customer_name,
        "room_type": project.room_type,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "thumbnail_url": f"/media/{latest_render.image_path}" if latest_render else f"/media/{project.room_photo_path}",
        "has_render": latest_render is not None,
    }


def project_detail(project: Project) -> dict:
    latest_render = project.renders[-1] if project.renders else None
    return {
        "id": project.id,
        "customer_name": project.customer_name,
        "room_type": project.room_type,
        "room_photo_url": f"/media/{project.room_photo_path}",
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "items": [
            {
                "id": item.id,
                "category": item.category,
                "type": item.type,
                "width_ft": item.width_ft,
                "photo_url": f"/media/{item.photo_path}",
                "pin_x": item.pin_x,
                "pin_y": item.pin_y,
            }
            for item in project.items
        ],
        "renders": [
            {"id": r.id, "image_url": f"/media/{r.image_path}", "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in project.renders
        ],
        "latest_render": (
            {"id": latest_render.id, "image_url": f"/media/{latest_render.image_path}"} if latest_render else None
        ),
    }


@app.get("/api/projects")
def api_list_projects(q: str = "", user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> JSONResponse:
    query = db.query(Project).filter(Project.user_id == user.id)
    if q.strip():
        query = query.filter(Project.customer_name.ilike(f"%{q.strip()}%"))
    projects = query.order_by(Project.id.desc()).all()
    return JSONResponse(content={"projects": [project_summary(p) for p in projects]})


@app.post("/api/projects")
async def api_create_project(
    customer_name: str = Form(...),
    room_type: str = Form(...),
    room_photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    if not customer_name.strip():
        return error_response(400, "missing_customer_name", "Please enter the customer's name.")
    if room_type not in ROOM_TYPES:
        return error_response(400, "invalid_room_type", "Please choose a room type.")
    try:
        photo_path = await save_validated_upload(room_photo, ROOMS_DIR)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)

    project = Project(
        user_id=user.id,
        customer_name=customer_name.strip(),
        room_type=room_type,
        room_photo_path=photo_path,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return JSONResponse(content={"project": project_detail(project)})


def get_owned_project(project_id: int, user: User, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if project is None:
        raise HTTPException(status_code=404, detail="That project could not be found.")
    return project


@app.get("/api/projects/{project_id}")
def api_get_project(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    return JSONResponse(content={"project": project_detail(project)})


@app.post("/api/projects/{project_id}/items")
async def api_add_item(
    project_id: int,
    category: str = Form(...),
    type: str = Form(...),
    width_ft: float = Form(...),
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    if category not in ITEM_TYPES:
        return error_response(400, "invalid_category", "Please choose a furniture category.")
    if type not in ITEM_TYPES[category]:
        return error_response(400, "invalid_type", "Please choose a valid type for that category.")
    if width_ft <= 0:
        return error_response(400, "invalid_width", "Please enter a width in feet.")
    if len(project.items) >= MAX_ITEMS_PER_PROJECT:
        return error_response(400, "too_many_items", f"You can add up to {MAX_ITEMS_PER_PROJECT} pieces.")
    try:
        photo_path = await save_validated_upload(photo, ITEMS_DIR)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)

    item = Item(project_id=project.id, category=category, type=type, width_ft=width_ft, photo_path=photo_path)
    db.add(item)
    db.commit()
    db.refresh(project)
    return JSONResponse(content={"project": project_detail(project)})


@app.delete("/api/projects/{project_id}/items/{item_id}")
def api_delete_item(
    project_id: int, item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    item = db.query(Item).filter(Item.id == item_id, Item.project_id == project.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    db.delete(item)
    db.commit()
    db.refresh(project)
    return JSONResponse(content={"project": project_detail(project)})


class PinBody(BaseModel):
    x: float
    y: float


@app.post("/api/projects/{project_id}/items/{item_id}/pin")
def api_set_pin(
    project_id: int,
    item_id: int,
    body: PinBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    item = db.query(Item).filter(Item.id == item_id, Item.project_id == project.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    if not (0 <= body.x <= 1) or not (0 <= body.y <= 1):
        return error_response(400, "invalid_coordinates", "That pin is outside the photo.")
    item.pin_x = body.x
    item.pin_y = body.y
    db.commit()
    db.refresh(project)
    return JSONResponse(content={"project": project_detail(project)})


@app.delete("/api/projects/{project_id}/items/{item_id}/pin")
def api_clear_pin(
    project_id: int, item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    item = db.query(Item).filter(Item.id == item_id, Item.project_id == project.id).first()
    if item is None:
        return error_response(404, "item_not_found", "That piece could not be found.")
    item.pin_x = None
    item.pin_y = None
    db.commit()
    db.refresh(project)
    return JSONResponse(content={"project": project_detail(project)})


@app.post("/api/projects/{project_id}/generate")
async def api_generate(
    project_id: int, ignore_pins: bool = False, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    if not project.items:
        return error_response(400, "no_items", "Add at least one piece of furniture first.")

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "processing"}
    asyncio.create_task(run_generation_job(job_id, project.id, user.id, ignore_pins))
    return JSONResponse(content={"job_id": job_id})


@app.get("/api/jobs/{job_id}")
def api_job_status(job_id: str, user: User = Depends(get_current_user)) -> JSONResponse:
    job = JOBS.get(job_id)
    if job is None:
        return error_response(404, "job_not_found", "That job could not be found.")
    return JSONResponse(content=job)


# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------


class CreateSalesmanBody(BaseModel):
    name: str
    mobile: str
    password: str


@app.get("/api/admin/users")
def api_admin_list_users(q: str = "", admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> JSONResponse:
    query = db.query(User).filter(User.role == "salesman")
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter((User.name.ilike(like)) | (User.mobile.ilike(like)))
    users = query.order_by(User.name).all()
    result = []
    for u in users:
        count = db.query(Project).filter(Project.user_id == u.id).count()
        result.append({**user_public(u), "project_count": count})
    return JSONResponse(content={"users": result})


@app.post("/api/admin/users")
def api_admin_create_user(
    body: CreateSalesmanBody, admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> JSONResponse:
    mobile = body.mobile.strip()
    if not body.name.strip() or not mobile or not body.password:
        return error_response(400, "missing_fields", "Please fill in every field.")
    if db.query(User).filter(User.mobile == mobile).first() is not None:
        return error_response(409, "mobile_taken", "That mobile number is already registered.")
    user = User(name=body.name.strip(), mobile=mobile, password_hash=hash_password(body.password), role="salesman", active=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    return JSONResponse(content={"user": user_public(user)})


@app.get("/api/admin/users/{user_id}")
def api_admin_user_detail(user_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> JSONResponse:
    target = db.query(User).filter(User.id == user_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
    projects = db.query(Project).filter(Project.user_id == user_id).order_by(Project.id.desc()).all()
    return JSONResponse(
        content={
            "user": user_public(target),
            "project_count": len(projects),
            "projects": [
                {
                    **project_summary(p),
                    "renders": [f"/media/{r.image_path}" for r in p.renders],
                }
                for p in projects
            ],
        }
    )


class ResetPasswordBody(BaseModel):
    password: str


@app.post("/api/admin/users/{user_id}/reset-password")
def api_admin_reset_password(
    user_id: int, body: ResetPasswordBody, admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> JSONResponse:
    target = db.query(User).filter(User.id == user_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
    if not body.password or len(body.password) < 4:
        return error_response(400, "weak_password", "Please choose a longer password.")
    target.password_hash = hash_password(body.password)
    db.commit()
    return JSONResponse(content={"ok": True})


@app.post("/api/admin/users/{user_id}/toggle-active")
def api_admin_toggle_active(user_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> JSONResponse:
    target = db.query(User).filter(User.id == user_id).first()
    if target is None:
        return error_response(404, "user_not_found", "That salesman could not be found.")
    target.active = not target.active
    db.commit()
    return JSONResponse(content={"user": user_public(target)})


# ---------------------------------------------------------------------------
# Admin — generation prompt
# ---------------------------------------------------------------------------


def prompt_setting_response(setting: Setting | None) -> dict:
    return {
        "prompt": setting.value if setting else DEFAULT_GENERATION_PROMPT,
        "default_prompt": DEFAULT_GENERATION_PROMPT,
        "updated_at": setting.updated_at.isoformat() if setting and setting.updated_at else None,
        "placeholders": PROMPT_PLACEHOLDERS,
    }


@app.get("/api/admin/prompt")
def api_admin_get_prompt(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> JSONResponse:
    setting = db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first()
    return JSONResponse(content=prompt_setting_response(setting))


class PromptBody(BaseModel):
    prompt: str


@app.post("/api/admin/prompt")
def api_admin_save_prompt(
    body: PromptBody, admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> JSONResponse:
    if not body.prompt.strip():
        return error_response(400, "empty_prompt", "The prompt can't be empty.")
    setting = db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first()
    if setting is None:
        setting = Setting(key=PROMPT_SETTING_KEY, value=body.prompt)
        db.add(setting)
    else:
        setting.value = body.prompt
    db.commit()
    db.refresh(setting)
    return JSONResponse(content=prompt_setting_response(setting))


@app.post("/api/admin/prompt/reset")
def api_admin_reset_prompt(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> JSONResponse:
    setting = db.query(Setting).filter(Setting.key == PROMPT_SETTING_KEY).first()
    if setting is None:
        setting = Setting(key=PROMPT_SETTING_KEY, value=DEFAULT_GENERATION_PROMPT)
        db.add(setting)
    else:
        setting.value = DEFAULT_GENERATION_PROMPT
    db.commit()
    db.refresh(setting)
    return JSONResponse(content=prompt_setting_response(setting))


# ---------------------------------------------------------------------------
# Static frontend — one page shell, client-side routing.
# ---------------------------------------------------------------------------


@app.get("/{full_path:path}")
async def spa(full_path: str) -> Response:
    if full_path.startswith(("api/", "media/", "static/")):
        raise HTTPException(status_code=404)
    return FileResponse(str(STATIC_DIR / "index.html"))

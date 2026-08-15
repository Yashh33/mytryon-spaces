import asyncio
import io
import logging
import mimetypes
import os
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
from PIL import Image, ImageOps
from pydantic import BaseModel
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    create_engine,
    func,
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
# GEMINI PROMPT — edited frequently, kept isolated. No string interpolation
# is performed on this constant; it is sent to the model verbatim, followed
# by the room photo, each product reference photo, and a per-request detail
# block naming the room type and every piece with its type and width.
# ---------------------------------------------------------------------------
GENERATION_PROMPT = """\
You are given a set of reference images, in this order:
1. A photo of a customer's room, currently under-construction or unfurnished.
2. One or more furniture product photos, each a single piece the customer
   has shortlisted, supplied in the same order as the piece list below.

Generate one photorealistic image that places every product from the
product reference photos into the room from the first reference photo.

Before placing furniture, clean up the room itself: remove any people,
ladders, scaffolding, tools, cement bags, tile stacks, packaging, and
construction debris visible in the room photo. Render the room as warm,
finished, and lived-in — soft warm lighting, clean finished walls and
floor. This is an aspirational image for a customer, not a documentary
photo of a construction site.

Product identity is authoritative and must be preserved exactly for each
piece: silhouette, proportions, cushion and panel count, leg shape,
stitching, fabric colour, and fabric texture. Do not redesign, restyle,
or simplify any product.

Transfer only the furniture product itself from each product photo.
Exclude any staging props visible in the product reference photos — rugs,
cushions, coffee tables, plants, lamps, decorative objects. Place only
the products in the room.

The room's architecture must be preserved: flooring, walls, windows,
doors, and proportions, along with the existing lighting direction and
colour temperature, stay consistent with the room photo.

Place each product flat and contact-correct on the floor plane, with
grounded, physically plausible shadows. Scale each piece to its stated
width in feet, relative to the room's real proportions and other visible
reference objects (doors, windows, floor tiles/boards).

If existing furniture occupies a target placement area, remove it and
reconstruct the floor and wall behind it consistently with the rest of
the room.

Match the output's exposure and white balance to the room photo. The
result must read as a real photograph of the room with the products in
it, not a studio render or a collage.
"""

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


class Render(Base):
    __tablename__ = "renders"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    image_path = Column(String, nullable=False)
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
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


def build_prompt(room_type: str, items: list[Item]) -> str:
    lines = [GENERATION_PROMPT, "", f"Room type: {room_type}", "Pieces, in reference-photo order:"]
    for item in items:
        lines.append(f"- {item.category} ({item.type}), {item.width_ft:g} ft wide")
    return "\n".join(lines)


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


async def run_generation_job(job_id: str, project_id: int, user_id: int) -> None:
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == user_id).first()
        if project is None:
            JOBS[job_id] = {"status": "error", "message": "That project could not be found."}
            return
        if not project.items:
            JOBS[job_id] = {"status": "error", "message": "Add at least one piece of furniture first."}
            return

        prompt = build_prompt(project.room_type, project.items)
        room_part = load_local_image_part(DATA_ROOT / project.room_photo_path)
        item_parts = [load_local_image_part(DATA_ROOT / item.photo_path) for item in project.items]

        try:
            image_bytes = await asyncio.to_thread(call_gemini, prompt, [room_part, *item_parts], f"project:{project_id}")
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


@app.post("/api/projects/{project_id}/generate")
async def api_generate(
    project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> JSONResponse:
    project = get_owned_project(project_id, user, db)
    if not project.items:
        return error_response(400, "no_items", "Add at least one piece of furniture first.")

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "processing"}
    asyncio.create_task(run_generation_job(job_id, project.id, user.id))
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
# Static frontend — one page shell, client-side routing.
# ---------------------------------------------------------------------------


@app.get("/{full_path:path}")
async def spa(full_path: str) -> Response:
    if full_path.startswith(("api/", "media/", "static/")):
        raise HTTPException(status_code=404)
    return FileResponse(str(STATIC_DIR / "index.html"))

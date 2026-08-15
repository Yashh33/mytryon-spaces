import base64
import io
import json
import logging
import mimetypes
import os
import time
import uuid
from pathlib import Path

import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from PIL import Image, ImageOps

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("mytryon")

BASE_DIR = Path(__file__).resolve().parent
PRODUCTS_DIR = BASE_DIR / "products"
STATIC_DIR = BASE_DIR / "static"

MODEL_NAME = "gemini-3.1-flash-image"

# ---------------------------------------------------------------------------
# GEMINI PROMPT — edited frequently, kept isolated. No string interpolation
# is performed on this constant; it is sent to the model verbatim alongside
# the product reference images and the customer's room photo.
# ---------------------------------------------------------------------------
GENERATION_PROMPT = """\
You are given three reference images, in this order:
1. A furniture product, front view.
2. The same furniture product, a detail/angle view.
3. A photo of a customer's room.

Generate one photorealistic image that places the product from references
1 and 2 into the room from reference 3.

Product identity is authoritative and must be preserved exactly:
silhouette, proportions, cushion and panel count, leg shape, stitching,
fabric colour, and fabric texture. Do not redesign, restyle, or simplify
the product.

Transfer only the furniture product itself. Exclude any staging props
visible in the product reference photos — rugs, cushions, coffee tables,
plants, lamps, decorative objects. Place only the product in the room.

The room's architecture must be preserved: flooring, walls, windows, and
the existing lighting direction and colour temperature stay as they are
in the room photo.

Place the product flat and contact-correct on the floor plane, with
grounded, physically plausible shadows. Scale the product plausibly
relative to visible reference objects in the room (doors, windows,
furniture, floor tiles/boards).

If existing furniture occupies the target placement area, remove it and
reconstruct the floor and wall behind it consistently with the rest of
the room.

Match the output's exposure and white balance to the room photo. The
result must read as a real photograph of the room with the product in
it, not a studio render or a collage.
"""

# ---------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_GENERATIONS_PER_SESSION = 50
SESSION_COOKIE_NAME = "mt_session"
SESSION_COOKIE_MAX_AGE = 60 * 60 * 24  # 1 day

# In-memory only, per the "no database" requirement. Resets on restart.
_session_generation_counts: dict[str, int] = {}

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

app = FastAPI()
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/products", StaticFiles(directory=str(PRODUCTS_DIR)), name="products")


def load_products() -> dict[str, dict]:
    with open(BASE_DIR / "products.json", "r", encoding="utf-8") as f:
        items = json.load(f)
    return {item["sku"]: item for item in items}


def public_base_url(request: Request) -> str:
    """Base URL as seen by the client, honouring reverse-proxy / tunnel headers
    (cloudflared quick tunnels terminate TLS upstream and forward plain HTTP)."""
    proto = request.headers.get("x-forwarded-proto")
    if not proto:
        cf_visitor = request.headers.get("cf-visitor")
        if cf_visitor:
            try:
                proto = json.loads(cf_visitor).get("scheme")
            except Exception:
                proto = None
    proto = (proto or request.url.scheme).split(",")[0].strip()
    host = request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


PRODUCTS = load_products()


def log_call(sku: str, elapsed_ms: float, result: str) -> None:
    logger.info("sku=%s elapsed_ms=%.0f result=%s", sku, elapsed_ms, result)


def get_session_id(request: Request) -> str:
    return request.cookies.get(SESSION_COOKIE_NAME) or uuid.uuid4().hex


def attach_session_cookie(response: Response, session_id: str) -> Response:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        session_id,
        max_age=SESSION_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
    )
    return response


def load_local_image_part(path: Path) -> types.Part:
    mime_type, _ = mimetypes.guess_type(path.name)
    return types.Part.from_bytes(data=path.read_bytes(), mime_type=mime_type or "image/jpeg")


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


def image_bytes_to_part(data: bytes) -> types.Part:
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        image = image.convert("RGB")
    except Exception:
        raise UploadValidationError(400, "unreadable_image", "We couldn't read that photo. Please try another.")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=90)
    return types.Part.from_bytes(data=buf.getvalue(), mime_type="image/jpeg")


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


def error_response(status_code: int, error: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error, "message": message})


def generate_and_respond(
    front_part: types.Part, detail_part: types.Part, room_part: types.Part, log_label: str
) -> Response:
    """Shared by the live /f/{sku} flow and /demo: calls Gemini with the
    product + room references and turns the result into an HTTP response."""
    start = time.monotonic()
    try:
        model_response = client.models.generate_content(
            model=MODEL_NAME,
            contents=[GENERATION_PROMPT, front_part, detail_part, room_part],
            config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
        )
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        log_call(log_label, elapsed_ms, f"exception:{exc.__class__.__name__}")
        return error_response(502, "model_error", "Something went wrong generating your image. Please try again.")

    elapsed_ms = (time.monotonic() - start) * 1000

    block_reason = blocked_reason(model_response)
    if block_reason:
        log_call(log_label, elapsed_ms, block_reason)
        return error_response(
            422,
            "blocked",
            "We couldn't generate a result for that photo. Try a different angle or a different room.",
        )

    image = extract_image(model_response)
    if image is None:
        log_call(log_label, elapsed_ms, "empty_response")
        return error_response(502, "empty_response", "That attempt didn't produce an image. Please try again.")

    image_bytes, image_mime_type = image
    log_call(log_label, elapsed_ms, "success")
    return Response(content=image_bytes, media_type=image_mime_type)


@app.get("/favicon.ico")
async def favicon() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "favicon.ico"))


# ---------------------------------------------------------------------------
# Admin/print page
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def admin_index(request: Request) -> HTMLResponse:
    base_url = public_base_url(request)
    cards = []
    for sku, product in PRODUCTS.items():
        page_url = f"{base_url}/f/{sku}"
        photo_url = f"/products/{product['folder']}/front.jpg"
        qr_img = qrcode.make(page_url)
        buf = io.BytesIO()
        qr_img.save(buf, format="PNG")
        qr_data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        cards.append(
            f"""
            <a class="tag-card" href="{page_url}">
              <img class="product-photo" src="{photo_url}" alt="{sku}" />
              <img class="qr" src="{qr_data_uri}" alt="QR code for {sku}" />
              <span class="tag-sku">{sku}</span>
            </a>
            """
        )
    html = f"""
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Showroom tags</title>
      <link rel="icon" href="/static/favicon.ico" />
      <link rel="stylesheet" href="/static/style.css" />
    </head>
    <body class="admin-body">
      <h1>Showroom tags</h1>
      <p class="muted">Print this page and cut out a tag per product.</p>
      <a class="btn btn-primary btn-large demo-cta" href="/demo">Try any product</a>
      <div class="tag-grid">
        {''.join(cards)}
      </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


# ---------------------------------------------------------------------------
# Customer page
# ---------------------------------------------------------------------------

@app.get("/f/{sku}")
async def customer_page(sku: str, request: Request, reset: str | None = None) -> Response:
    if sku not in PRODUCTS:
        return FileResponse(str(STATIC_DIR / "404.html"), status_code=404)
    session_id = get_session_id(request)
    if reset == "1":
        _session_generation_counts.pop(session_id, None)
    response = FileResponse(str(STATIC_DIR / "index.html"))
    return attach_session_cookie(response, session_id)


@app.get("/api/product/{sku}")
async def api_product(sku: str) -> JSONResponse:
    product = PRODUCTS.get(sku)
    if product is None:
        return error_response(404, "unknown_sku", "That product could not be found.")
    return JSONResponse(
        content={
            "sku": product["sku"],
            "image_url": f"/products/{product['folder']}/front.jpg",
        }
    )


@app.post("/api/generate")
async def api_generate(request: Request, sku: str = Form(...), photo: UploadFile = File(...)) -> Response:
    session_id = get_session_id(request)

    def finish(response: Response) -> Response:
        return attach_session_cookie(response, session_id)

    product = PRODUCTS.get(sku)
    if product is None:
        return finish(error_response(404, "unknown_sku", "That product could not be found."))

    generation_count = _session_generation_counts.get(session_id, 0)
    if generation_count >= MAX_GENERATIONS_PER_SESSION:
        log_call(sku, 0, "cap_reached")
        return finish(
            error_response(
                429,
                "cap_reached",
                f"You've used all {MAX_GENERATIONS_PER_SESSION} tries for this session. Ask a team member if you'd like another go.",
            )
        )

    room_bytes = b""
    try:
        room_bytes = await read_validated_upload(photo)
        room_part = image_bytes_to_part(room_bytes)
    except UploadValidationError as exc:
        return finish(error_response(exc.status_code, exc.error, exc.message))
    finally:
        room_bytes = b""  # never persisted, never logged; drop the reference immediately

    product_dir = PRODUCTS_DIR / product["folder"]
    try:
        front_part = load_local_image_part(product_dir / "front.jpg")
        detail_part = load_local_image_part(product_dir / "angle-left.jpg")
    except FileNotFoundError:
        log_call(sku, 0, "missing_product_images")
        return finish(error_response(500, "product_not_ready", "This product isn't ready yet. Please try another item."))

    _session_generation_counts[session_id] = generation_count + 1

    return finish(generate_and_respond(front_part, detail_part, room_part, sku))


# ---------------------------------------------------------------------------
# Demo page — any product photo against any room photo, no catalogue, no cap
# ---------------------------------------------------------------------------

@app.get("/demo")
async def demo_page() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "demo.html"))


@app.post("/api/generate-demo")
async def api_generate_demo(product_photo: UploadFile = File(...), room_photo: UploadFile = File(...)) -> Response:
    product_bytes = b""
    room_bytes = b""
    try:
        product_bytes = await read_validated_upload(product_photo)
        product_part = image_bytes_to_part(product_bytes)
        room_bytes = await read_validated_upload(room_photo)
        room_part = image_bytes_to_part(room_bytes)
    except UploadValidationError as exc:
        return error_response(exc.status_code, exc.error, exc.message)
    finally:
        product_bytes = b""
        room_bytes = b""

    return generate_and_respond(product_part, product_part, room_part, "demo")

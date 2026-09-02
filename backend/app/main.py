# Serves the static frontend (frontend/index.html, frontend/js, frontend/css,
# frontend/vendor) from the same process as the API, per the roadmap's
# "decide once" note for Phase 2 - one process, one command, no CORS to
# configure.
from pathlib import Path

# Some local security software (antivirus HTTPS scanning, corporate proxies)
# intercepts TLS and re-signs traffic with a locally-generated root cert that
# isn't in Python's bundled certifi CA list, so certifi-based verification
# fails even though the OS/browser trusts it fine. truststore patches ssl to
# verify against the OS certificate store instead, matching what curl/browsers
# already trust. Must run before anything (httpx) builds an SSLContext.
import truststore

truststore.inject_into_ssl()

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .alignment import router as alignment_router
from .assets import router as assets_router
from .audio import router as audio_router
from .comfy import router as comfy_router
from .describe import router as describe_router
from .draft import router as draft_router
from .expand import router as expand_router
from .export import router as export_router
from .jobs import router as jobs_router
from .live_api import router as live_api_router
from .projects import DATA_DIR
from .projects import router as projects_router
from .read_api import router as read_api_router
from .settings import router as settings_router
from .write_api import router as write_api_router

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = REPO_ROOT / "frontend"

app = FastAPI(title="CUTTAlogue")


# Frontend files carry no Cache-Control header by default, so browsers apply
# heuristic caching off Last-Modified and can skip asking the server at all
# on a plain refresh - stale JS/CSS silently keeps running after an edit,
# with no failed request to explain why. no-cache forces revalidation (an
# ETag round-trip) on every load without losing the "don't re-download
# unchanged bytes" benefit, which is what actually matters during local dev.
@app.middleware("http")
async def no_cache_frontend(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith(("/js/", "/css/")):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.include_router(projects_router)
app.include_router(read_api_router)
app.include_router(write_api_router)
app.include_router(jobs_router)
app.include_router(live_api_router)
app.include_router(assets_router)
app.include_router(audio_router)
app.include_router(export_router)
app.include_router(settings_router)
app.include_router(describe_router)
app.include_router(draft_router)
app.include_router(expand_router)
app.include_router(comfy_router)
app.include_router(alignment_router)

for static_dir in ("js", "css", "vendor"):
    path = FRONTEND_DIR / static_dir
    if path.exists():
        app.mount(f"/{static_dir}", StaticFiles(directory=path), name=static_dir)

# Serves original asset files and thumbnails straight off disk for preview -
# no auth/access-control needed for a local single-user tool. URL shape:
# /project-files/<projectId>/<relativePath from the project's asset descriptor>
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/project-files", StaticFiles(directory=DATA_DIR), name="project-files")


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(FRONTEND_DIR / "favicon.ico")

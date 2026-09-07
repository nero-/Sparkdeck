"""FastAPI assembly: routes, error model, optional bearer token, static UI.
The Application's startup/shutdown is wired via the app lifespan so uvicorn,
TestClient, and any ASGI host all drive it identically. `app_factory` exists
for uvicorn --factory dev mode.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from . import VERSION
from .app import Application
from .api.routes import SparkdeckError, attach

_APPLICATION: Application | None = None


def app_factory() -> FastAPI:
    """uvicorn --factory entry: builds a fresh Application from the runtime env."""
    global _APPLICATION
    if _APPLICATION is None:
        from .config import load_config

        _APPLICATION = Application(load_config())
        return create_app(_APPLICATION)
    return create_app(_APPLICATION)  # re-registration-safe second call


def create_app(a: Application) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await a.startup()
        try:
            yield
        finally:
            await a.shutdown()

    app = FastAPI(title="Sparkdeck", version=VERSION,
                  docs_url=None, redoc_url=None, openapi_url="/api/openapi.json",
                  lifespan=lifespan)

    @app.exception_handler(SparkdeckError)
    async def sparkdeck_error(_req, exc: SparkdeckError):
        return JSONResponse(status_code=exc.status_code,
                            content={"error": exc.detail})

    @app.exception_handler(Exception)
    async def unhandled(_req: Request, exc: Exception):
        if a.cfg.verbose:
            import traceback

            traceback.print_exc()
        return JSONResponse(status_code=500, content={
            "error": {"code": "internal", "message": repr(exc)[:400], "detail": {}}})

    attach(app, a)

    @app.get("/api/healthz")
    async def healthz():
        return {"ok": True}

    # SPA static (built web/dist). Absent → helpful placeholder.
    dist = a.web_dist()
    if dist.exists():
        @app.get("/", include_in_schema=False)
        async def index():
            return FileResponse(dist / "index.html")

        assets = dist / "assets"
        if assets.exists():
            from fastapi.staticfiles import StaticFiles

            app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa_fallback(path: str):
            if path.startswith("api/"):
                return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "no such api route"}})
            target = dist / path
            if target.is_file():
                return FileResponse(target)
            return FileResponse(dist / "index.html")
    else:
        @app.get("/", include_in_schema=False)
        async def no_ui():
            return JSONResponse({"sparkdeck": VERSION, "ui": "not built — run make web (npm ci + build) to produce web/dist"})
    return app

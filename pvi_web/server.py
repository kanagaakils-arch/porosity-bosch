"""Porosity Inspector — FastAPI Server."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

try:
    from .routers.porosity import router as porosity_router
    from .routers.ai_training import router as ai_router
except ImportError:
    from routers.porosity import router as porosity_router
    from routers.ai_training import router as ai_router

BASE_DIR   = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(
        "┌─────────────────────────────────────────────┐\n"
        "│  Porosity Inspector                        │\n"
        "│  Inspector:  http://localhost:8002          │\n"
        "│  Train:      http://localhost:8002/train    │\n"
        "│  Analyze:    http://localhost:8002/analyze  │\n"
        "│  History:    http://localhost:8002/history  │\n"
        "│  Admin:      http://localhost:8002/admin    │\n"
        "└─────────────────────────────────────────────┘"
    )
    yield

app = FastAPI(title="Porosity Inspector", lifespan=lifespan)

app.include_router(porosity_router, prefix="/api/porosity")
app.include_router(ai_router,       prefix="/api/ai")

# Legacy route aliases so the current porosity tool keeps working untouched.
app.include_router(porosity_router, prefix="/api")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def read_index():
    """Serve the platform SPA entrypoint."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/history")
def read_history():
    """Serve the AI training history page."""
    return FileResponse(STATIC_DIR / "history.html")


@app.get("/admin")
def read_admin():
    """Serve the AI admin panel."""
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/train")
def read_train():
    """Serve the training image upload page."""
    return FileResponse(STATIC_DIR / "train.html")


@app.get("/analyze")
def read_analyze():
    """Serve the AI analyze page."""
    return FileResponse(STATIC_DIR / "analyze.html")


@app.get("/metrics")
def read_metrics():
    """Serve the model analytics & benchmarks page."""
    return FileResponse(STATIC_DIR / "metrics.html")


@app.get("/validate")
def read_validate():
    """Serve the batch validation suite."""
    return FileResponse(STATIC_DIR / "validate.html")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=str, default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, reload=False)

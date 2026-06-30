"""Porosity Inspector — FastAPI Server."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

try:
    from .routers.porosity import router as porosity_router
except ImportError:
    from routers.porosity import router as porosity_router

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(
        "┌─────────────────────────────────────────┐\n"
        "│  Porosity Inspector                    │\n"
        "│  http://localhost:8002                  │\n"
        "│  Tool: Porosity Inspector              │\n"
        "└─────────────────────────────────────────┘"
    )
    yield

app = FastAPI(title="Porosity Inspector", lifespan=lifespan)

app.include_router(porosity_router, prefix="/api/porosity")

# Legacy route aliases so the current porosity tool keeps working untouched.
app.include_router(porosity_router, prefix="/api")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def read_index():
    """Serve the platform SPA entrypoint."""
    return FileResponse(STATIC_DIR / "index.html")



if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=str, default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, reload=False)

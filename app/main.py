from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import auth, notes, settings, tasks, users

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="notask",
    description="Notes et tâches — API REST protégée par JWT.",
    version="1.0.0",
    lifespan=lifespan,
)

# Ouvert pour permettre un client Android natif (widgets d'écran d'accueil)
# appelant l'API directement. L'authentification repose sur le jeton Bearer,
# pas sur les cookies : aucun risque de CSRF lié à cette ouverture.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(settings.router)
app.include_router(notes.router)
app.include_router(tasks.router)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")

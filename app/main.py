from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import attachments, auth, labels, note_versions, notes, settings, tasks, users

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="notask",
    description="Notasks et tâches — API REST protégée par JWT.",
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

@app.middleware("http")
async def no_cache(request: Request, call_next):
    """Aucune réponse ne doit être resservie depuis le cache du navigateur
    sans revalidation auprès du serveur.

    Pour l'API (/api/*) : sans ça, un navigateur peut resservir un ancien
    /api/auth/status et réafficher l'écran de configuration alors que le
    compte existe déjà.

    Pour le HTML/JS/CSS (/, /static/*) : ni StaticFiles ni FileResponse ne
    posent de Cache-Control par défaut, seulement un ETag/Last-Modified.
    Un navigateur peut alors resservir app.js/style.css/index.html depuis
    son cache local SANS même revalider auprès du serveur (mise en cache
    heuristique, RFC 7234), même après un rechargement simple — un
    redéploiement côté serveur reste alors invisible tant que l'utilisateur
    ne force pas un rechargement complet. `no-cache` (pas `no-store`) force
    la revalidation à chaque chargement tout en gardant les 304 bon marché
    quand le fichier n'a pas changé.
    """
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    else:
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(settings.router)
app.include_router(notes.router)
app.include_router(tasks.router)
app.include_router(labels.router)
app.include_router(attachments.router)
app.include_router(note_versions.router)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


# Page "fantôme" — non reliée depuis le menu, volontairement : elle n'existe
# que pour être ajoutée à l'écran d'accueil mobile comme icône À PART (voir
# quick-manifest.json, avec son propre start_url/id, donc une icône propre
# indépendante de celle de l'app principale). Même app.js/style.css que la
# page principale (aucune logique dupliquée : auth, chiffrement, composeur,
# tout est réutilisé tel quel) — seule une classe sur <body> et un drapeau
# JS (voir NOTASK_QUICK_CAPTURE dans app.js) changent l'affichage pour ne
# montrer que le composeur, déjà déplié, plein écran.
@app.get("/quick", include_in_schema=False)
def quick_capture():
    return FileResponse(STATIC_DIR / "quick.html")


# Servis à la racine (pas sous /static/) : la portée par défaut d'un service
# worker se limite à son propre dossier et aux dossiers en dessous — un
# sw.js sous /static/ ne pourrait contrôler que /static/*, jamais les pages
# de l'app elles-mêmes, servies depuis /.
@app.get("/manifest.json", include_in_schema=False)
def manifest():
    return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")


@app.get("/quick-manifest.json", include_in_schema=False)
def quick_manifest():
    return FileResponse(STATIC_DIR / "quick-manifest.json", media_type="application/manifest+json")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")

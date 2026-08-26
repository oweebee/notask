import logging
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import events as bus
from app.db import init_db
from app.routers import (
    attachments, auth, events, google, labels, note_versions, notes, settings, tasks, users,
)
from app.security import decode_access_token

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="notask",
    description="Notasks et tâches — API REST protégée par JWT.",
    # Palier 0.9 jusqu'à l'annonce de la V1 (cf. fichier VERSION à la
    # racine et APP_VERSION dans app/static/app.js) : la 1.0.0 affichée ici
    # était une valeur d'amorçage jamais mise à jour, trompeuse.
    version="0.9041",
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
    # Seule exception : /.well-known/assetlinks.json, lu par Chrome et par les
    # serveurs de Google pour vérifier l'application Android compagnon. Son
    # contenu ne change qu'à une rotation de clé de signature, et il pose
    # lui-même son propre Cache-Control — que la ligne ci-dessous écraserait.
    if request.url.path.startswith("/.well-known/"):
        return response
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    else:
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


log = logging.getLogger("notask")


@app.exception_handler(Exception)
async def erreur_inattendue(request: Request, exc: Exception):
    """Renvoie la CAUSE d'une erreur 500 au client, au lieu du « Internal
    Server Error » opaque de FastAPI.

    Motif : le journal de l'application est purement côté navigateur, et rien
    côté serveur ne conserve les traces. Quand un enregistrement échouait, la
    seule information disponible était une boîte « Erreur 500 » — impossible
    de savoir ce qui s'était passé sans aller lire les logs du conteneur dans
    Coolify, ce qui n'est pas un chemin acceptable pour diagnostiquer un
    incident courant.

    Le `detail` renvoyé se limite au TYPE et au MESSAGE de l'exception (ex.
    « IntegrityError: UNIQUE constraint failed… »), jamais à la trace
    complète : celle-ci part dans les logs du serveur, où elle a sa place. Le
    type et le message suffisent presque toujours à identifier la cause, et
    ne révèlent pas l'arborescence du code.

    Application auto-hébergée, mono-utilisateur : le compromis
    diagnosticabilité / discrétion penche clairement du premier côté. Sur un
    service multi-locataires, cette remontée n'aurait rien à faire ici.
    """
    log.error(
        "Erreur non rattrapée sur %s %s\n%s",
        request.method,
        request.url.path,
        "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    )
    return JSONResponse(
        status_code=500,
        content={"detail": f"{type(exc).__name__}: {exc}"},
    )


@app.middleware("http")
async def diffuser_changements(request: Request, call_next):
    """Après toute écriture réussie sur l'API, prévient les autres clients du
    même utilisateur (voir app/events.py et app/routers/events.py).

    Posé en middleware plutôt que route par route, DÉLIBÉRÉMENT : les écritures
    sont éparpillées sur huit routeurs (notasks, lignes, libellés, pièces
    jointes, versions, réglages…) et la liste s'allonge à chaque
    fonctionnalité. Une notification oubliée sur une route ne se voit pas — le
    client reste simplement figé sur des données anciennes, sans erreur nulle
    part. Un point de passage unique ferme cette porte.

    Le jeton est relu ici plutôt que de dépendre de get_current_user : un
    middleware s'exécute AVANT que FastAPI ne résolve les dépendances de la
    route, il n'a donc pas accès à son résultat. Seul l'identifiant est
    décodé, sans aller en base — on ne cherche pas à autoriser quoi que ce
    soit ici, la route s'en est déjà chargée, on cherche seulement à savoir
    QUI prévenir.
    """
    response = await call_next(request)

    if request.method in ("GET", "HEAD", "OPTIONS"):
        return response
    if not request.url.path.startswith("/api/"):
        return response
    # 2xx uniquement : une écriture refusée n'a rien changé à annoncer.
    if not (200 <= response.status_code < 300):
        return response

    entete = request.headers.get("authorization") or ""
    if not entete.lower().startswith("bearer "):
        return response
    user_id = decode_access_token(entete.split(" ", 1)[1].strip())
    if user_id is not None:
        bus.publier(user_id, request.headers.get("x-client-id"))
    return response


app.include_router(auth.router)
app.include_router(events.router)
app.include_router(users.router)
app.include_router(settings.router)
app.include_router(notes.router)
app.include_router(tasks.router)
app.include_router(labels.router)
app.include_router(attachments.router)
app.include_router(note_versions.router)
app.include_router(google.router)


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


# Digital Asset Links — moitié « site » de la vérification qui autorise
# l'application Android compagnon (widgets d'écran d'accueil) à afficher ce
# site en plein écran, sans la barre d'adresse de Chrome. Sa moitié
# « application » est la ressource `asset_statements` de l'APK, qui désigne
# en retour cette adresse.
#
# NOTASK_ANDROID_CERT_SHA256 contient l'empreinte de la clé ayant signé
# l'APK, au format majuscules séparées par des deux-points
# (AA:BB:CC:...), telle que la sort `keytool -list -v`. Plusieurs empreintes
# peuvent être séparées par des virgules — utile pendant une rotation de clé,
# où deux versions signées différemment circulent en même temps.
#
# Variable absente = pas d'application Android déclarée : on renvoie une
# liste vide plutôt qu'une 404. Chrome traite les deux pareil (vérification
# refusée), mais une liste vide dit « rien à déclarer ici », là où une 404
# laisse penser à une erreur de configuration du serveur.
#
# La route est publique et le doit : Chrome la lit sans aucun jeton, depuis
# les serveurs de Google pour la vérification des liens d'application. Elle
# n'expose qu'une empreinte de certificat, qui est une donnée publique par
# construction — c'est l'empreinte de la clé, jamais la clé.
@app.get("/.well-known/assetlinks.json", include_in_schema=False)
def asset_links():
    import json
    import os

    from fastapi.responses import Response

    def _nettoyer(valeur: str) -> str:
        """Ne garde que l'empreinte elle-même.

        Un panneau de configuration comme Coolify sépare le nom et la valeur
        en deux champs. Coller la ligne entière dans le champ « valeur » est
        l'erreur naturelle, et elle produisait un fichier assetlinks.json
        syntaxiquement valide mais contenant
        `NOTASK_ANDROID_CERT_SHA256=3D:C2:...` en guise d'empreinte — donc une
        vérification qui échoue sans le moindre message, côté Android comme
        côté serveur. On retire donc un éventuel préfixe `NOM=`.
        """
        valeur = valeur.strip()
        if "=" in valeur:
            valeur = valeur.rsplit("=", 1)[1].strip()
        return valeur.upper()

    empreintes = [
        e
        for e in (
            _nettoyer(f) for f in os.getenv("NOTASK_ANDROID_CERT_SHA256", "").split(",")
        )
        # Une empreinte SHA-256 fait 32 octets, soit 95 caractères en
        # hexadécimal séparé par des deux-points. Tout le reste est du bruit.
        if len(e) == 95 and all(c in "0123456789ABCDEF:" for c in e)
    ]
    paquet = os.getenv("NOTASK_ANDROID_PACKAGE", "com.oweebee.notaskwidget")

    corps = (
        []
        if not empreintes
        else [
            {
                "relation": ["delegate_permission/common.handle_all_urls"],
                "target": {
                    "namespace": "android_app",
                    "package_name": paquet,
                    "sha256_cert_fingerprints": empreintes,
                },
            }
        ]
    )
    # Cache-Control explicite, respecté grâce à l'exemption /.well-known/
    # posée dans le middleware no_cache plus haut : ce fichier ne change qu'à
    # une rotation de clé de signature, le faire revalider à chaque lecture
    # n'apporterait rien.
    return Response(
        content=json.dumps(corps),
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
    )

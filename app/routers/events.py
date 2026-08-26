"""Route Server-Sent Events : le client garde une connexion ouverte, le
serveur y pousse un signal à chaque changement (voir app/events.py).

Pourquoi PAS `EventSource`, l'API navigateur prévue pour ça : elle ne sait
pas envoyer d'en-tête `Authorization`. Le seul moyen d'authentifier une
connexion `EventSource` serait de mettre le jeton dans l'URL — où il finirait
dans les journaux du serveur, ceux de Traefik, et l'historique du navigateur.
Le client utilise donc `fetch()` en lecture de flux (voir brancherFluxTempsReel
dans app.js), qui accepte les en-têtes normalement, au prix d'une reconnexion
à écrire à la main.
"""

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Header
from fastapi.responses import StreamingResponse

from app import events
from app.deps import get_current_user
from app.models import User

router = APIRouter(prefix="/api", tags=["events"])

# Sans trafic, une connexion inactive finit par être coupée par Traefik ou par
# le réseau mobile. Un commentaire SSE (une ligne commençant par ':') fait
# circuler des octets sans rien signifier pour le client — c'est le battement
# de cœur qui maintient la connexion ouverte.
INTERVALLE_BATTEMENT = 25  # secondes


@router.get("/events")
async def flux_evenements(
    user: User = Depends(get_current_user),
    # Identifiant du client, tiré au sort par le navigateur (voir CLIENT_ID
    # dans app.js). Sert uniquement à ne pas se renvoyer à soi-même le signal
    # de ses propres écritures — aucune valeur d'authentification.
    x_client_id: Optional[str] = Header(default=None),
):
    abonne = events.abonner(user.id, x_client_id)
    file = abonne[0]

    async def flux():
        try:
            # Premier octet immédiat : tant que rien n'est envoyé, `fetch()`
            # côté client n'a pas encore résolu ses en-têtes, et un proxy
            # pourrait garder la réponse en tampon.
            yield ": connecté\n\n"
            while True:
                try:
                    await asyncio.wait_for(file.get(), timeout=INTERVALLE_BATTEMENT)
                    yield "data: maj\n\n"
                except asyncio.TimeoutError:
                    yield ": battement\n\n"
        finally:
            # Atteint aussi bien à la fermeture de l'onglet qu'à une coupure
            # réseau : sans ça, chaque rechargement de page laisserait une
            # file orpheline en mémoire, définitivement.
            events.desabonner(user.id, abonne)

    return StreamingResponse(
        flux(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            # Neutralise la mise en tampon de nginx, si un jour un proxy de ce
            # type se glisse devant : sans ça il retiendrait les événements
            # jusqu'à remplir son tampon, et le « temps réel » ne le serait
            # plus du tout. Sans effet avec Traefik, qui ne met pas en tampon.
            "X-Accel-Buffering": "no",
        },
    )

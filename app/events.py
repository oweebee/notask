"""Diffusion des changements aux clients connectés (Server-Sent Events).

But : une modification faite dans un navigateur apparaît immédiatement dans
les autres, dans la PWA et dans l'APK, sans rafraîchissement manuel.

**Le contenu des notasks ne passe JAMAIS par ici.** Le serveur ne diffuse
qu'un signal « quelque chose a changé pour cet utilisateur » ; le client
recharge ensuite par les routes habituelles et déchiffre lui-même. C'est ce
qui permet à cette fonctionnalité de coexister avec le chiffrement de bout en
bout sans y toucher : rien à déchiffrer côté serveur, donc rien de nouveau à
lui confier.

Tout tient en mémoire du processus, volontairement : le conteneur lance UN
seul uvicorn, sans `--workers` (voir le CMD du Dockerfile). Un abonné inscrit
ici est donc forcément visible depuis le processus qui publie. Si un jour
plusieurs workers étaient lancés, ce fichier deviendrait faux en silence — un
client servi par le worker A ne verrait jamais les publications du worker B —
et il faudrait passer par un intermédiaire commun (Redis, base, socket).
"""

import asyncio
import logging
from typing import Dict, Optional, Set, Tuple

log = logging.getLogger("notask")

# Un ensemble d'abonnés par utilisateur : un abonné = un onglet, une PWA, une
# fenêtre. Chacun est un couple (file d'attente, identifiant de client) —
# l'identifiant sert à ne PAS renvoyer à un client le signal de ses propres
# écritures : il vient déjà de recharger, un second rechargement immédiat
# serait au mieux inutile, au pire gênant (saisie en cours réaffichée).
_abonnes: Dict[int, Set[Tuple[asyncio.Queue, Optional[str]]]] = {}

# Au-delà, la file d'un client trop lent (onglet en veille, réseau coupé) est
# considérée comme perdue plutôt que de grossir indéfiniment en mémoire. Le
# signal étant sans contenu, en perdre n'a aucune conséquence : le client
# rechargera de toute façon tout à la reconnexion.
TAILLE_MAX_FILE = 32


def abonner(user_id: int, client_id: Optional[str] = None):
    abonne = (asyncio.Queue(maxsize=TAILLE_MAX_FILE), client_id)
    _abonnes.setdefault(user_id, set()).add(abonne)
    return abonne


def desabonner(user_id: int, abonne) -> None:
    abonnes = _abonnes.get(user_id)
    if not abonnes:
        return
    abonnes.discard(abonne)
    if not abonnes:
        _abonnes.pop(user_id, None)


def publier(user_id: int, origine: Optional[str] = None) -> None:
    """Signale aux clients de cet utilisateur qu'il faut recharger.

    `origine` : identifiant du client à l'origine de l'écriture, qui est le
    seul à ne PAS être prévenu — il a déjà les données à jour.

    Ne lève jamais : une notification perdue ne doit en aucun cas faire
    échouer l'écriture qui vient d'aboutir. Le pire cas est un client qui
    reste sur des données d'il y a quelques secondes.
    """
    for file, client_id in list(_abonnes.get(user_id, ())):
        if origine is not None and client_id == origine:
            continue
        try:
            file.put_nowait("maj")
        except asyncio.QueueFull:
            log.warning("File d'événements saturée (utilisateur %s), signal ignoré", user_id)
        except Exception:
            log.exception("Échec de publication d'un événement")

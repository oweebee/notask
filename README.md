# notask

Notes et tâches auto-hébergées : un Google Keep et un Google Tasks réduits à
l'essentiel. API REST FastAPI protégée par JWT, interface web sans framework,
déploiement Docker via Coolify derrière Traefik, sans port publié.

## Fonctionnement

Au premier démarrage, l'application est **verrouillée** : aucune donnée n'est
accessible tant que le compte administrateur n'a pas été créé depuis l'écran de
configuration. Ensuite, l'admin gère les comptes depuis l'onglet *Comptes*.

Chaque utilisateur ne voit que ses propres notes et tâches.

## Principe : la notâche

**Il n'existe qu'un objet créable : la note.** Une tâche n'est pas une chose
séparée, c'est une note à laquelle on a posé une échéance.

- Une note **sans date** est une note ordinaire. Elle n'est pas cochable.
- Une note **avec date** devient une tâche : elle apparaît dans la vue Tâches
  et peut être terminée. Retirer la date la ramène à l'état de note.
- Chaque **case à cocher** d'une note peut porter sa propre échéance. La ligne
  devient alors une tâche autonome, sans changer d'apparence dans la note.
  Dans la vue Tâches, elle rappelle toujours le nom de sa note d'origine.

On ne crée jamais une tâche directement : elle naît d'une note. La vue Tâches
est une lecture, pas un lieu de création.

## Fonctions

**Notes** — titre et texte libre, 21 couleurs, épinglage, archive, listes à
cocher, recherche.

**Tâches** — regroupement automatique en *En retard*, *Aujourd'hui*,
*Imminentes* (échéance dans 7 jours ou moins), *À venir* et *Terminées*,
échéance à la minute, lien retour vers la note d'origine.

**Récurrence** — une échéance peut se répéter chaque semaine, chaque mois ou
chaque année. La reprogrammation a lieu **au moment où la notask est cochée
terminée**, jamais avant : la date affichée reste celle qu'on a fixée tant
que la tâche n'est pas faite. Le décalage se fait dans le fuseau de
l'utilisateur, pour qu'un rendez-vous hebdomadaire de 10 h reste à 10 h de
part et d'autre d'un changement d'heure.

**Rappels navigateur** — notification à l'heure de l'échéance (la veille à
20 h pour une journée complète), activables depuis *Profil*. Fonctionnent
tant qu'une fenêtre notask est ouverte, même en arrière-plan ; navigateur
fermé, seuls l'APK Android et Google Calendar prennent le relais.

**Rafraîchissement automatique** — un onglet laissé ouvert se remet à jour
toutes les cinq minutes et immédiatement au retour dessus, sans jamais
interrompre une saisie en cours.

## Structure

```
app/
  main.py            application FastAPI
  models.py          modèles SQLModel
  db.py              moteur SQLite (/data/notask.db)
  security.py        hachage scrypt + jetons JWT
  deps.py            dépendances d'authentification
  google_calendar.py client REST Google (OAuth + Calendar v3)
  routers/
    auth.py          setup, login, profil, mot de passe
    users.py         gestion des comptes (admin)
    notes.py         notes façon Keep
    tasks.py         listes et tâches façon Tasks
    google.py        connexion/déconnexion Google Calendar
    settings.py      réglages libres par utilisateur (dont le fuseau horaire)
  static/            interface web (HTML, CSS, JS)
tests/test_api.py         tests bout en bout
tests/test_recurrence.py  récurrences, regroupements, changement d'heure
Dockerfile
push.bat             envoi des modifications sur GitHub
```

## API

Toutes les routes `/api/*` exigent un en-tête `Authorization: Bearer <token>`,
sauf `/api/auth/status`, `/api/auth/setup` et `/api/auth/login`.
Documentation interactive sur `/docs`.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/auth/status` | l'app attend-elle sa configuration ? |
| POST | `/api/auth/setup` | créer l'admin (une seule fois) |
| POST | `/api/auth/login` | obtenir un jeton |
| GET | `/api/auth/me` | profil courant |
| POST | `/api/auth/password` | changer son mot de passe |
| GET/POST | `/api/users` | lister / créer un compte (admin) |
| PATCH/DELETE | `/api/users/{id}` | modifier / supprimer (admin) |
| GET | `/api/settings` | réglages de l'utilisateur |
| PATCH | `/api/settings` | fusionner des clés (`null` supprime) |
| PUT | `/api/settings` | remplacer tous les réglages |
| GET/POST | `/api/notes` | lister / créer |
| GET/PATCH/DELETE | `/api/notes/{id}` | détail / modifier / supprimer |
| PATCH | `/api/notes/{id}/items/{item_id}` | cocher ou dater une ligne |
| GET | `/api/tasks` | notes et lignes datées, regroupées (`?bucket=late\|today\|imminent\|upcoming\|done`) |
| PATCH | `/api/tasks/{kind}/{id}` | terminer (`kind` = `note` ou `item`) |
| GET | `/api/google/status` | connecté / déconnecté / à reconnecter |
| GET | `/api/google/connect?token=` | démarre la connexion (redirige vers Google) |
| GET | `/api/google/callback` | retour de Google (usage interne, pas d'appel direct) |
| POST | `/api/google/disconnect` | déconnecte le compte Google |
| GET/PUT/DELETE | `/api/google/admin-config` | Client ID/Secret OAuth de l'installation (admin) |

Le jeton est valable 30 jours — adapté à un client Android natif dont les
widgets d'écran d'accueil interrogent l'API en tâche de fond.

### Réglages

`/api/settings` est une boîte JSON libre, une par utilisateur : le serveur
conserve le contenu sans l'interpréter. Ajouter un réglage côté client ne
demande donc aucune modification du serveur — pratique pour que le web et le
widget Android partagent la même configuration.

```bash
curl -X PATCH https://notask.exemple.tld/api/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"theme":"dark","widget_liste":3}'
```

Limites : 100 clés par utilisateur, 10 000 caractères par valeur texte.

Une clé est lue par le serveur, et une seule : **`timezone`** (`"Europe/Paris"`),
que le client déclare au démarrage. C'est la seule notion de fuseau horaire du
serveur, qui vit par ailleurs entièrement en UTC. Elle sert uniquement à
reprogrammer une échéance récurrente à la même heure locale d'une fois sur
l'autre — sans elle, « + 1 semaine » vaut « + 7 × 24 h » et un rappel de 10 h
dérive à 11 h au passage à l'heure d'été. Absente ou invalide, le calcul
retombe en UTC sans erreur.

## Google Calendar

Synchro optionnelle, par utilisateur, activable depuis la boîte *Profil* :
une notask (ou une ligne à cocher) datée devient un événement dans le
calendrier principal du compte Google connecté. Détail de l'implémentation
et des compromis dans `app/google_calendar.py`.

**Compromis de chiffrement, accepté explicitement (pas une conséquence
cachée)** : pour une notask/ligne qui a une échéance, le serveur voit
désormais son titre en clair (nécessaire pour nommer l'événement Google —
voir `Note.calendar_title`/`NoteItem.calendar_title` dans `app/models.py`).
Tout le reste (description, contenu, pièces jointes, notasks sans échéance)
reste chiffré de bout en bout comme avant, inchangé.

**Sens de la synchro** : dans les deux sens, mais de façon asymétrique du
fait du chiffrement — une notask crée/modifie/supprime son événement
Google ; à l'inverse, un changement de **date** fait directement dans
Google Calendar est répercuté sur la notask, mais un changement de
**titre** fait côté Google ne peut PAS l'être (le titre réel est chiffré,
le serveur n'a pas la clé). Événement supprimé côté Google => la notask
perd sa date (redevient une note ordinaire), jamais supprimée elle-même.
Notask archivée ou mise à la corbeille => son événement Google est
supprimé automatiquement.

Aucune tâche planifiée : le tirage des changements côté Google (voir
`pull_changes()`) se fait paresseusement à chaque chargement de la liste
des notasks, même principe que la purge de corbeille.

### Créer les identifiants OAuth

1. [console.cloud.google.com](https://console.cloud.google.com) → créer un
   projet (ou en réutiliser un).
2. **APIs et services → Bibliothèque** → activer *Google Calendar API*.
3. **APIs et services → Écran de consentement OAuth** → type *Externe*,
   renseigner nom de l'appli + e-mail ; en mode *Test*, ajouter son propre
   compte Google comme utilisateur test (pas besoin de validation Google
   pour un usage personnel).
4. **APIs et services → Identifiants → Créer des identifiants → ID client
   OAuth** → type *Application Web*.
   URI de redirection autorisée : `https://notask.mondomaine.tld/api/google/callback`
   (remplacer par le vrai domaine de déploiement — doit correspondre
   exactement, schéma https compris).
5. Renseigner le Client ID et le Client Secret obtenus, par l'une des deux
   voies suivantes (la base est prioritaire si les deux sont renseignées) :
   - **Depuis l'appli** (le plus simple) : onglet *Comptes* (admin), section
     *Google Calendar* en bas de page — deux champs, bouton Enregistrer.
     Stocké en base, jamais renvoyé au client une fois saisi (voir
     `GoogleAppConfig` dans `app/models.py`).
   - **Variables d'environnement** : `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
     dans les réglages Coolify — jamais dans le dépôt Git, ce sont des secrets.

**Erreur "redirect_uri_mismatch" côté Google** : Uvicorn tourne avec
`--proxy-headers` (voir Dockerfile) pour que l'URI de redirection calculée
côté serveur soit bien en `https://` (Traefik termine le TLS et transmet en
clair en interne — sans ce réglage, Starlette la calculerait en `http://`,
qui ne correspondrait plus à celle enregistrée dans la console Google).
Si l'erreur persiste : vérifier que l'URI enregistrée dans Google Cloud
Console correspond EXACTEMENT (schéma, domaine, `/api/google/callback`,
sans slash final) à celle utilisée, et qu'un redéploiement complet
(reconstruction de l'image, pas juste un restart) a bien eu lieu après
toute modification du Dockerfile.

## Sécurité

- Mots de passe hachés en **scrypt** (bibliothèque standard, paramètres OWASP),
  jamais stockés en clair.
- Jetons **JWT HS256**. La clé de signature vient de `NOTASK_SECRET_KEY` ; à
  défaut elle est générée puis conservée dans `/data/secret.key`.
  **Ce fichier est dans le volume persistant : le supprimer déconnecte tout le monde.**
- CORS ouvert, sans cookies : l'authentification passe uniquement par l'en-tête
  `Authorization`, ce qui écarte le risque de CSRF.
- Cloisonnement des données vérifié par les tests : un utilisateur reçoit `404`
  sur les notes et tâches d'un autre.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `NOTASK_DATA_DIR` | `/data` | dossier de la base et de la clé |
| `DATABASE_URL` | `sqlite:///<data>/notask.db` | connexion base |
| `NOTASK_SECRET_KEY` | générée | clé de signature JWT |
| `NOTASK_TOKEN_TTL_DAYS` | `30` | durée de validité des jetons |
| `GOOGLE_CLIENT_ID` | — | ID client OAuth (intégration Google Calendar, voir plus haut) |
| `GOOGLE_CLIENT_SECRET` | — | secret client OAuth associé |

## Développement

```bash
pip install -r requirements.txt
set NOTASK_DATA_DIR=.\data          # Windows
uvicorn app.main:app --reload
```

Tests :

```bash
pip install pytest httpx
python -m pytest tests/ -q
```

## Déploiement Coolify

Déployé en **Service** (New → Docker Compose). Un Service ne clone aucun dépôt :
c'est Docker qui récupère le code, via l'URL Git indiquée dans `build:`.

Le volume `notask_data` est déclaré dans le compose : Coolify le crée
automatiquement et le conserve entre les redéploiements. Aucun réglage manuel
de stockage.

1. DNS : enregistrement A `notask.mondomaine.tld` → IP du serveur.
2. New → **Docker Compose**, coller le contenu de `docker-compose.yaml`.
3. Champ **Domains for notask** : `https://notask.mondomaine.tld:8111`
   Le `:8111` désigne le port du conteneur ; rien n'est publié sur l'hôte,
   Traefik sert le site en 443 et gère le certificat.
4. Deploy.

Conséquences de ce mode, à connaître :

- Le dépôt **doit rester public** — Docker clone sans identifiants.
- **Pas de déploiement automatique** au push : après `push.bat`, cliquer
  *Redeploy* dans Coolify.
- Modifier `docker-compose.yaml` dans le dépôt ne suffit pas : le compose vit
  dans Coolify, il faut l'y recopier.

Le compose ne contient volontairement **aucun label Traefik** : Coolify les
génère lui-même, lui seul connaissant le nom de son réseau proxy. Des labels
écrits à la main produisent un `no available server`.

### Si le champ Domains refuse de s'enregistrer

Sur certaines versions de Coolify, enregistrer le domaine d'une ressource
compose échoue (erreur `sslipDomainWarning` et retour au domaine `.sslip.io`).
Contournement, à exécuter dans le terminal Coolify puis redéployer :

```bash
docker exec coolify-db psql -U coolify -d coolify -c \
  "update applications set docker_compose_domains =
   '{\"notask\":{\"domain\":\"https://notask.mondomaine.tld:8111\"}}'
   where uuid = '<uuid-de-la-ressource>';"
```

L'UUID figure dans l'URL de la ressource dans Coolify.

## Mise à jour

Double-clic sur `push.bat` (ou `push.bat "mon message"`), puis Redeploy depuis
Coolify — ou automatiquement si le webhook GitHub est activé.

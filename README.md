# notask

Notes et tâches auto-hébergées : un Google Keep et un Google Tasks réduits à
l'essentiel. API REST FastAPI protégée par JWT, interface web sans framework,
déploiement Docker via Coolify derrière Traefik, sans port publié.

## Fonctionnement

Au premier démarrage, l'application est **verrouillée** : aucune donnée n'est
accessible tant que le compte administrateur n'a pas été créé depuis l'écran de
configuration. Ensuite, l'admin gère les comptes depuis l'onglet *Comptes*.

Chaque utilisateur ne voit que ses propres notes et tâches.

## Fonctions

**Notes (Keep)** — titre et texte libre, 11 couleurs, épinglage, archive,
listes à cocher, recherche.

**Tâches (Tasks)** — listes multiples, échéance avec repérage des retards,
détails, sous-tâches (un niveau), étoile, effacement des tâches terminées.
Cocher une tâche coche ses sous-tâches.

## Structure

```
app/
  main.py            application FastAPI
  models.py          modèles SQLModel
  db.py              moteur SQLite (/data/notask.db)
  security.py        hachage scrypt + jetons JWT
  deps.py            dépendances d'authentification
  routers/
    auth.py          setup, login, profil, mot de passe
    users.py         gestion des comptes (admin)
    notes.py         notes façon Keep
    tasks.py         listes et tâches façon Tasks
  static/            interface web (HTML, CSS, JS)
tests/test_api.py    tests bout en bout
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
| GET/POST | `/api/notes` | lister / créer |
| GET/PATCH/DELETE | `/api/notes/{id}` | détail / modifier / supprimer |
| GET/POST | `/api/lists` | listes de tâches |
| PATCH/DELETE | `/api/lists/{id}` | renommer / supprimer |
| GET/POST | `/api/lists/{id}/tasks` | tâches d'une liste |
| POST | `/api/lists/{id}/clear-completed` | effacer les terminées |
| GET/PATCH/DELETE | `/api/tasks/{id}` | détail / modifier / supprimer |

Le jeton est valable 30 jours — adapté à un client Android natif dont les
widgets d'écran d'accueil interrogent l'API en tâche de fond.

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

Build Pack **Dockerfile** (pas Docker Compose : sur Coolify v4.2.0, le champ
`docker_compose_domains` ne s'enregistre pas et le domaine reste ignoré).

1. DNS : enregistrement A `notask.mondomaine.tld` → IP du serveur.
2. New Resource → **Dockerfile**, source = ce repo GitHub, branche `main`.
3. **Domains** : `https://notask.mondomaine.tld`
4. **Ports Exposes** : `8111`
5. **Persistent Storage** : montage vers `/data`
   — indispensable, sinon la base et la clé JWT sont perdues à chaque déploiement.

Le conteneur n'expose 8111 que sur le réseau Docker : aucun port publié sur
l'hôte, Traefik sert le site en 443 et gère le certificat.

## Mise à jour

Double-clic sur `push.bat` (ou `push.bat "mon message"`), puis Redeploy depuis
Coolify — ou automatiquement si le webhook GitHub est activé.

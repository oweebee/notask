# notask

Gestion de tâches et de notes. API REST FastAPI + petite UI web, packagée en Docker,
déployée par Coolify derrière Traefik **sans port publié**.

## Structure

```
app/
  __init__.py
  main.py          API REST + montage de l'UI
  models.py        modèles SQLModel (Task, Note)
  db.py            moteur SQLite (/data/notask.db)
  static/index.html
Dockerfile
docker-compose.yaml
push.bat           envoi des modifs sur GitHub
requirements.txt
```

## Endpoints

| Méthode | Route | Description |
|---|---|---|
| GET | `/` | UI web |
| GET | `/docs` | Swagger (client APK futur) |
| GET | `/health` | healthcheck |
| GET/POST | `/api/tasks` | lister / créer |
| GET/PATCH/DELETE | `/api/tasks/{id}` | détail / modifier / supprimer |
| GET/POST | `/api/notes` | lister / créer |
| GET/PATCH/DELETE | `/api/notes/{id}` | détail / modifier / supprimer |

## Dev local

```bash
pip install -r requirements.txt
set NOTASK_DATA_DIR=.\data          # Windows
uvicorn app.main:app --reload
```

Ou en Docker :

```bash
docker compose up --build
```

Note : le compose ne publie **aucun port**. En local, pour tester dans un navigateur,
ajouter temporairement `ports: ["8111:8111"]` — ne pas committer cette ligne.

## Déploiement Coolify

### 1. DNS

Créer un enregistrement **A** `notask.mondomaine.tld` → IP du serveur Coolify.
(Si un domaine wildcard `*.mondomaine.tld` pointe déjà vers le serveur, rien à faire.)

### 2. Ressource Coolify

Coolify → **New Resource** → **Docker Compose**, source : ce repo GitHub, branche `main`,
chemin du compose : `docker-compose.yaml`.

### 3. Domaine

Dans Coolify, service `notask`, champ **Domains for notask**, remplacer le domaine
`.sslip.io` généré automatiquement par :

```
https://notask.mondomaine.tld:8111
```

Format exact : schéma `https://`, nom d'hôte, puis `:8111`. Ce port désigne le
**port du conteneur** vers lequel router — rien n'est publié sur l'hôte, Traefik
sert le site en 443 et gère le certificat.

Le domaine n'apparaît nulle part dans le repo : il ne vit que dans Coolify.

### 4. Déployer

Le conteneur n'expose 8111 que sur le réseau Docker de la stack — aucun port publié
sur l'hôte, seul Traefik y accède.

Le volume `notask-data` conserve la base SQLite entre les déploiements.

## Mise à jour

Double-clic sur `push.bat` (ou `push.bat "mon message"`), puis redéploiement
depuis Coolify — ou automatiquement si le webhook GitHub est activé côté Coolify.

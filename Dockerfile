FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NOTASK_DATA_DIR=/data

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /data

# Port interne uniquement — jamais publié sur l'hôte, Traefik y accède
# via le réseau Docker.
EXPOSE 8111

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8111/health || exit 1

# --proxy-headers + --forwarded-allow-ips='*' : sans ça, Starlette calcule
# request.base_url (voir app/routers/google.py _redirect_uri()) à partir de
# la connexion RÉELLE reçue par le conteneur — en http://, puisque Traefik
# termine le TLS et transmet en clair sur le réseau Docker interne. Résultat
# sans ce réglage : une URI de redirection OAuth en http:// envoyée à
# Google, qui ne correspond plus à celle en https:// enregistrée dans la
# console (erreur "redirect_uri_mismatch"). Faire confiance à TOUTES les IP
# ('*') pour les en-têtes X-Forwarded-* est sans risque ici : le port 8111
# n'est jamais publié sur l'hôte (voir EXPOSE ci-dessus et le commentaire
# associé) — seul Traefik, via le réseau Docker interne, peut atteindre ce
# conteneur.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8111", "--proxy-headers", "--forwarded-allow-ips=*"]

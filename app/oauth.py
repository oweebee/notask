"""
app/oauth.py
OAuth 2.1 minimal pour compatibilité connecteur MCP web Claude.ai.
Stockage in-memory (perdu au redémarrage — OK pour usage perso).
Le token émis = NOTASK_MCP_KEY → compatible avec auth_wrapper de mcp_server.py.
"""
import base64
import hashlib
import os
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

router = APIRouter()

# In-memory — réinitialisés au redémarrage; les tokens émis perdurent via NOTASK_MCP_KEY
_clients: dict = {}
_codes: dict = {}


def _base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.url.netloc)
    return f"{proto}://{host}"


@router.get("/.well-known/oauth-authorization-server")
def oauth_metadata(request: Request):
    b = _base(request)
    return {
        "issuer": b,
        "authorization_endpoint": f"{b}/oauth/authorize",
        "token_endpoint": f"{b}/oauth/token",
        "registration_endpoint": f"{b}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "scopes_supported": ["mcp"],
    }


@router.post("/oauth/register")
async def register_client(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid_request")
    cid = secrets.token_urlsafe(16)
    csecret = secrets.token_urlsafe(32)
    _clients[cid] = {
        "client_secret": csecret,
        "redirect_uris": body.get("redirect_uris", []),
        "client_name": body.get("client_name", ""),
    }
    return JSONResponse({
        "client_id": cid,
        "client_secret": csecret,
        "client_id_issued_at": int(datetime.utcnow().timestamp()),
        "client_secret_expires_at": 0,
        "redirect_uris": _clients[cid]["redirect_uris"],
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
    })


@router.get("/oauth/authorize", response_class=HTMLResponse)
def authorize_get(
    client_id: str,
    redirect_uri: str,
    state: str = "",
    code_challenge: str = "",
    code_challenge_method: str = "S256",
    scope: str = "",
):
    client = _clients.get(client_id, {})
    name = client.get("client_name") or client_id
    return HTMLResponse(f"""<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autoriser — notask</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:400px;margin:80px auto;padding:0 20px}}
.card{{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;text-align:center;color:#eee}}
h1{{font-size:1.2rem;margin:0 0 8px}}
p{{color:#aaa;font-size:.9rem}}
.app{{font-weight:600;color:#fff}}
button{{padding:12px 28px;border:none;border-radius:8px;cursor:pointer;font-size:1rem;margin:6px;font-weight:600}}
.allow{{background:#2563eb;color:#fff}}.allow:hover{{background:#1d4ed8}}
.deny{{background:#333;color:#ccc}}
.uri{{font-size:.7rem;color:#666;word-break:break-all;margin-top:16px}}
</style>
</head><body>
<div class="card">
  <h1>🔐 notask</h1>
  <p><span class="app">{name}</span><br>demande accès à vos notes.</p>
  <form method="POST">
    <input type="hidden" name="client_id" value="{client_id}">
    <input type="hidden" name="redirect_uri" value="{redirect_uri}">
    <input type="hidden" name="state" value="{state}">
    <input type="hidden" name="code_challenge" value="{code_challenge}">
    <input type="hidden" name="code_challenge_method" value="{code_challenge_method}">
    <input type="hidden" name="scope" value="{scope}">
    <br>
    <button type="submit" name="action" value="allow" class="allow">Autoriser</button>
    <button type="submit" name="action" value="deny" class="deny">Refuser</button>
  </form>
  <div class="uri">Redirection : {redirect_uri}</div>
</div>
</body></html>""")


@router.post("/oauth/authorize")
async def authorize_post(
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    state: str = Form(""),
    code_challenge: str = Form(""),
    code_challenge_method: str = Form("S256"),
    scope: str = Form(""),
    action: str = Form("allow"),
):
    sep = "&" if "?" in redirect_uri else "?"
    if action != "allow":
        return RedirectResponse(
            f"{redirect_uri}{sep}error=access_denied&state={state}", status_code=302
        )
    code = secrets.token_urlsafe(32)
    _codes[code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "expires": datetime.utcnow() + timedelta(minutes=5),
    }
    return RedirectResponse(
        f"{redirect_uri}{sep}code={code}&state={state}", status_code=302
    )


@router.post("/oauth/token")
async def token_endpoint(request: Request):
    body = await request.form()
    if body.get("grant_type") != "authorization_code":
        raise HTTPException(400, "unsupported_grant_type")

    code = body.get("code", "")
    code_verifier = body.get("code_verifier", "")

    code_data = _codes.pop(code, None)
    if not code_data:
        raise HTTPException(400, "invalid_grant")
    if datetime.utcnow() > code_data["expires"]:
        raise HTTPException(400, "invalid_grant")

    # Vérification PKCE (S256)
    if code_data["code_challenge"]:
        if not code_verifier:
            raise HTTPException(400, "invalid_grant")
        expected = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).rstrip(b"=").decode()
        if expected != code_data["code_challenge"]:
            raise HTTPException(400, "invalid_grant")

    master_key = os.getenv("NOTASK_MCP_KEY", "")
    if not master_key:
        raise HTTPException(500, "server_error")

    return JSONResponse({
        "access_token": master_key,
        "token_type": "bearer",
        "expires_in": 315360000,  # ~10 ans
        "scope": "mcp",
    })

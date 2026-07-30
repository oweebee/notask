"""Hachage des mots de passe (scrypt, bibliothèque standard) et jetons JWT."""

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import jwt

from app.db import DATA_DIR

# --- Paramètres scrypt (recommandations OWASP) ---
_SCRYPT_N = 2 ** 15
_SCRYPT_R = 8
_SCRYPT_P = 1
_SALT_BYTES = 16
_KEY_LEN = 32
# scrypt consomme 128 * N * r octets (~34 Mo ici). La limite OpenSSL par défaut
# est de 32 Mo : sans ce relèvement explicite, le hachage échoue.
_MAXMEM = 128 * _SCRYPT_N * _SCRYPT_R * 2

ALGORITHM = "HS256"
TOKEN_TTL_DAYS = int(os.getenv("NOTASK_TOKEN_TTL_DAYS", "30"))


def _load_secret() -> str:
    """Clé de signature : variable d'environnement, sinon générée et conservée dans /data."""
    env_secret = os.getenv("NOTASK_SECRET_KEY")
    if env_secret:
        return env_secret

    secret_file = Path(DATA_DIR) / "secret.key"
    if secret_file.exists():
        value = secret_file.read_text(encoding="utf-8").strip()
        if value:
            return value

    value = secrets.token_urlsafe(48)
    secret_file.write_text(value, encoding="utf-8")
    try:
        secret_file.chmod(0o600)
    except OSError:
        pass  # systèmes de fichiers sans support des permissions POSIX
    return value


SECRET_KEY = _load_secret()


# ============================ Mots de passe ============================

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_BYTES)
    key = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
        dklen=_KEY_LEN, maxmem=_MAXMEM,
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, key_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        key = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(bytes.fromhex(key_hex)),
            maxmem=max(_MAXMEM, 128 * int(n) * int(r) * 2),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(key, bytes.fromhex(key_hex))


# ================================ JWT ================================

def create_access_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=TOKEN_TTL_DAYS)).timestamp()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[int]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None

import hashlib
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Request, Response, Cookie
from pydantic import BaseModel
from database.db import users_collection, refresh_tokens_collection
from auth import (
    get_password_hash,
    verify_password,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    get_access_token_ttl_seconds,
    get_current_user,
)
from config import get_settings
from models.schemas import AuthTokenResponse
from rate_limit import limiter

router = APIRouter(prefix="/auth", tags=["Auth"])
settings = get_settings()

class UserCredentials(BaseModel):
    username: str
    password: str

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    cookie_kwargs = {
        "httponly": True,
        "secure": settings.REFRESH_COOKIE_SECURE,
        "samesite": settings.REFRESH_COOKIE_SAMESITE,
        "max_age": int(settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60),
        "path": settings.REFRESH_COOKIE_PATH,
    }
    if settings.REFRESH_COOKIE_DOMAIN:
        cookie_kwargs["domain"] = settings.REFRESH_COOKIE_DOMAIN

    response.set_cookie(
        key=settings.REFRESH_TOKEN_COOKIE_NAME,
        value=refresh_token,
        **cookie_kwargs,
    )

def _clear_refresh_cookie(response: Response) -> None:
    cookie_kwargs = {
        "path": settings.REFRESH_COOKIE_PATH,
    }
    if settings.REFRESH_COOKIE_DOMAIN:
        cookie_kwargs["domain"] = settings.REFRESH_COOKIE_DOMAIN
    response.delete_cookie(settings.REFRESH_TOKEN_COOKIE_NAME, **cookie_kwargs)

@router.post("/register")
@limiter.limit("5/minute")
async def register(request: Request, user: UserCredentials):
    # Check if user exists
    existing = users_collection.find_one({"username": user.username})
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Create user with a default 'doctor' role (Security AI access requirement)
    hashed_password = get_password_hash(user.password)
    users_collection.insert_one({
        "username": user.username,
        "password": hashed_password,
        "role": "doctor"  # default role for healthcare application
    })
    return {"message": "User registered successfully"}

@router.post("/login", response_model=AuthTokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, response: Response, user: UserCredentials):
    db_user = users_collection.find_one({"username": user.username})
    if not db_user or not verify_password(user.password, db_user["password"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    access_token = create_access_token(data={"sub": user.username})
    refresh_token, refresh_jti, refresh_expires_at = create_refresh_token(user.username)

    refresh_tokens_collection.insert_one(
        {
            "jti": refresh_jti,
            "user_id": user.username,
            "token_hash": _hash_refresh_token(refresh_token),
            "created_at": _now_iso(),
            "rotated_at": None,
            "revoked_at": None,
            "expires_at": refresh_expires_at,
        }
    )

    _set_refresh_cookie(response, refresh_token)

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": get_access_token_ttl_seconds(),
    }

@router.post("/refresh", response_model=AuthTokenResponse)
@limiter.limit("30/minute")
async def refresh_access_token(
    request: Request,
    response: Response,
    refresh_cookie: str | None = Cookie(default=None, alias=settings.REFRESH_TOKEN_COOKIE_NAME),
):
    if not refresh_cookie:
        raise HTTPException(status_code=401, detail="Refresh token is missing")

    payload = decode_refresh_token(refresh_cookie)
    username = payload.get("sub")
    jti = payload.get("jti")

    token_record = refresh_tokens_collection.find_one({"jti": jti, "user_id": username})
    if not token_record:
        raise HTTPException(status_code=401, detail="Refresh token is invalid")

    if token_record.get("revoked_at") or token_record.get("rotated_at"):
        raise HTTPException(status_code=401, detail="Refresh token has been revoked")

    if token_record.get("token_hash") != _hash_refresh_token(refresh_cookie):
        raise HTTPException(status_code=401, detail="Refresh token is invalid")

    new_refresh_token, new_jti, new_expires_at = create_refresh_token(username)
    now_iso = _now_iso()

    refresh_tokens_collection.update_one(
        {"_id": token_record["_id"]},
        {"$set": {"rotated_at": now_iso}},
    )

    refresh_tokens_collection.insert_one(
        {
            "jti": new_jti,
            "user_id": username,
            "token_hash": _hash_refresh_token(new_refresh_token),
            "created_at": now_iso,
            "rotated_at": None,
            "revoked_at": None,
            "expires_at": new_expires_at,
        }
    )

    access_token = create_access_token(data={"sub": username})
    _set_refresh_cookie(response, new_refresh_token)

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": get_access_token_ttl_seconds(),
    }

@router.post("/logout")
async def logout(
    response: Response,
    refresh_cookie: str | None = Cookie(default=None, alias=settings.REFRESH_TOKEN_COOKIE_NAME),
):
    if refresh_cookie:
        try:
            payload = decode_refresh_token(refresh_cookie)
            refresh_tokens_collection.update_one(
                {"jti": payload.get("jti"), "user_id": payload.get("sub")},
                {"$set": {"revoked_at": _now_iso()}},
            )
        except HTTPException:
            pass

    _clear_refresh_cookie(response)
    return {"message": "Logged out"}

@router.get("/me")
async def get_me(username: str = Depends(get_current_user)):
    # Check user role as well to expose to frontend
    db_user = users_collection.find_one({"username": username})
    role = db_user.get("role", "doctor") if db_user else "doctor"
    return {"username": username, "role": role}

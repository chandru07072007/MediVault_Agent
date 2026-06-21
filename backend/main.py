import asyncio
import sys
import os

# Append the parent directory to sys.path so agents and tools can be imported cleanly
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from routers.upload import router as upload_router
from routers.auth import router as auth_router
from routers.agent import router as agent_router
from config import get_settings
from rate_limit import limiter
from database.db import check_database_connection
from cleanup import cleanup_expired_upload_sessions_once, run_expired_upload_cleanup_loop

settings = get_settings()

app = FastAPI(
    title="MediPack AI API",
    description="Multi-Agent Package Management and Medical File Upload System",
    version="2.0.0",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# CORS configuration supporting wildcard/dynamic origins with credentials
origins = settings.cors_origins()
allow_origin_regex = None
if "*" in origins:
    allow_origin_regex = r"https?://.*"
    origins = [o for o in origins if o != "*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Route mounting
app.include_router(auth_router, prefix="/api")
app.include_router(upload_router, prefix="/api")
app.include_router(agent_router, prefix="/api")


@app.on_event("startup")
async def startup_event():
    check_database_connection()
    cleanup_expired_upload_sessions_once()
    app.state.cleanup_task = asyncio.create_task(
        run_expired_upload_cleanup_loop(settings.UPLOAD_CLEANUP_INTERVAL_SECONDS)
    )


@app.on_event("shutdown")
async def shutdown_event():
    task = getattr(app.state, "cleanup_task", None)
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "medipack-upload-api"}

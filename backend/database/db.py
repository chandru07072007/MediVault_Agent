import logging
from urllib.parse import urlparse
from pymongo import MongoClient, ASCENDING
from config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)

def _safe_mongo_target(uri: str) -> str:
    try:
        parsed = urlparse(uri)
        host = parsed.hostname or "unknown-host"
        port = f":{parsed.port}" if parsed.port else ""
        return f"{host}{port}"
    except Exception:
        return "unknown-host"

client = None
try:
    client = MongoClient(settings.MONGO_URI, serverSelectionTimeoutMS=5000)
except Exception as e:
    logger.error(f"Failed to initialize MongoClient with settings.MONGO_URI: {e}. Falling back to DummyMongoClient.")
    class DummyMongoClient:
        def __getitem__(self, name):
            return self
        def __getattr__(self, name):
            return self
        def __call__(self, *args, **kwargs):
            return self
        def __iter__(self):
            return iter([])
        def get(self, *args, **kwargs):
            return None
        def find_one(self, *args, **kwargs):
            return None
        def count_documents(self, *args, **kwargs):
            return 0
        def command(self, *args, **kwargs):
            raise RuntimeError("Database not available")
    client = DummyMongoClient()

# Handle collection referencing depending on whether client is a dummy
if hasattr(client, "__class__") and client.__class__.__name__ == "DummyMongoClient":
    db = client
else:
    db = client[settings.MONGO_DB_NAME]

users_collection = db["users"]
upload_sessions_collection = db["upload_sessions"]
uploads_collection = db["uploads"]
bucket_credentials_collection = db["bucket_credentials"]
refresh_tokens_collection = db["refresh_tokens"]
packages_collection = db["packages"]


def check_database_connection() -> None:
    try:
        client.admin.command("ping")
        upload_sessions_collection.create_index(
            [("expires_at", ASCENDING)],
            expireAfterSeconds=0,
            name="upload_sessions_expires_at_ttl",
        )
        upload_sessions_collection.create_index(
            [("status", ASCENDING), ("expires_at", ASCENDING)],
            name="upload_sessions_status_expires_idx",
        )
        refresh_tokens_collection.create_index(
            [("expires_at", ASCENDING)],
            expireAfterSeconds=0,
            name="refresh_tokens_expires_at_ttl",
        )
        refresh_tokens_collection.create_index(
            [("jti", ASCENDING)],
            unique=True,
            name="refresh_tokens_jti_unique_idx",
        )
        refresh_tokens_collection.create_index(
            [("user_id", ASCENDING), ("expires_at", ASCENDING)],
            name="refresh_tokens_user_expires_idx",
        )
        logger.info(
            "MongoDB connection successful target=%s database=%s",
            _safe_mongo_target(settings.MONGO_URI),
            settings.MONGO_DB_NAME,
        )
    except Exception as e:
        logger.warning(
            "MongoDB connection check failed target=%s. The application will continue to boot, but database operations may fail until credentials/network access are corrected. Error: %s",
            _safe_mongo_target(settings.MONGO_URI),
            str(e),
            exc_info=True
        )

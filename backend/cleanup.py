import asyncio
import logging
from datetime import datetime, timezone
from database.db import upload_sessions_collection
from s3_client import abort_multipart_upload

logger = logging.getLogger(__name__)
CLEANUP_TARGET_STATUSES = ["in_progress", "cleanup_failed"]

def cleanup_expired_upload_sessions_once(limit: int = 200) -> None:
    # Skip cleanup if database is not available
    if hasattr(upload_sessions_collection, "__class__") and upload_sessions_collection.__class__.__name__ == "DummyMongoClient":
        return
    now = datetime.now(timezone.utc)
    try:
        expired_sessions = list(
            upload_sessions_collection.find(
                {
                    "status": {"$in": CLEANUP_TARGET_STATUSES},
                    "expires_at": {"$lte": now},
                }
            ).limit(limit)
        )
    except Exception as e:
        logger.warning(
            "Failed to query expired sessions from database: %s. Cleanup skipped for this run.",
            str(e),
            exc_info=True
        )
        return

    if not expired_sessions:
        return

    logger.info("Expired upload cleanup started sessions=%s", len(expired_sessions))

    for session in expired_sessions:
        session_id = session.get("_id")
        upload_id = session.get("upload_id")
        file_key = session.get("file_key")
        user_id = session.get("user_id", "unknown")

        if not upload_id or not file_key:
            upload_sessions_collection.update_one(
                {"_id": session_id},
                {
                    "$set": {
                        "status": "expired",
                        "expired_at": now.isoformat(),
                        "cleanup_note": "Missing upload_id or file_key",
                    }
                },
            )
            logger.warning(
                "Expired session missing identifiers marked expired user_id=%s upload_id=%s",
                user_id,
                upload_id,
            )
            continue

        try:
            abort_multipart_upload(file_key, upload_id)
            upload_sessions_collection.update_one(
                {"_id": session_id},
                {
                    "$set": {
                        "status": "expired",
                        "expired_at": now.isoformat(),
                        "cleanup_last_run_at": now.isoformat(),
                    }
                },
            )
            logger.info(
                "Aborted expired multipart upload user_id=%s upload_id=%s",
                user_id,
                upload_id,
            )
        except Exception as e:
            error_response = getattr(e, "response", None)
            code = "Unknown"
            msg = str(e)
            if isinstance(error_response, dict):
                code = error_response.get("Error", {}).get("Code", "Unknown")
                msg = error_response.get("Error", {}).get("Message", msg)

            if code in {"NoSuchUpload", "NoSuchKey"}:
                upload_sessions_collection.update_one(
                    {"_id": session_id},
                    {
                        "$set": {
                            "status": "expired",
                            "expired_at": now.isoformat(),
                            "cleanup_last_run_at": now.isoformat(),
                            "cleanup_note": f"S3 {code}",
                        }
                    },
                )
                logger.info(
                    "Expired upload already absent in S3 user_id=%s upload_id=%s code=%s",
                    user_id,
                    upload_id,
                    code,
                )
                continue

            upload_sessions_collection.update_one(
                {"_id": session_id},
                {
                    "$set": {
                        "status": "cleanup_failed",
                        "cleanup_last_run_at": now.isoformat(),
                        "cleanup_error": f"S3 {code}: {msg}"[:500],
                    }
                },
            )
            logger.warning(
                "Failed abort on expired upload user_id=%s upload_id=%s code=%s",
                user_id,
                upload_id,
                code,
            )


async def run_expired_upload_cleanup_loop(interval_seconds: int) -> None:
    logger.info("Started expired upload cleanup loop interval_seconds=%s", interval_seconds)
    while True:
        cleanup_expired_upload_sessions_once()
        await asyncio.sleep(interval_seconds)

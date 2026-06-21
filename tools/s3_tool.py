import logging
import sys
import os
import boto3

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.config import get_settings
from backend import mock_s3_service
from backend.s3_client import _get_s3_client, _use_mock_s3

logger = logging.getLogger(__name__)

def upload_file(file_key: str, file_content: bytes, bucket_name: str = None) -> dict:
    """Upload raw file content to S3 (or Mock S3)."""
    try:
        settings = get_settings()
        bucket = bucket_name or settings.S3_BUCKET_NAME
        
        if _use_mock_s3():
            # Mock S3 upload - use the generated key returned by start_multipart_upload
            upload_info = mock_s3_service.start_multipart_upload(file_key.split("/")[-1], "application/pdf")
            upload_id = upload_info["upload_id"]
            generated_key = upload_info["file_key"]
            
            etag = mock_s3_service.upload_part(generated_key, upload_id, 1, file_content)
            mock_s3_service.complete_multipart_upload(generated_key, upload_id, [{"PartNumber": 1, "ETag": etag}])
            return {"status": "success", "location": f"mock://{generated_key}", "file_key": generated_key}

        s3 = _get_s3_client()
        s3.put_object(
            Bucket=bucket,
            Key=file_key,
            Body=file_content
        )
        return {"status": "success", "location": f"s3://{bucket}/{file_key}", "file_key": file_key}
    except Exception as e:
        logger.exception(f"Error uploading file to key: {file_key}")
        return {"status": "error", "message": str(e)}

def download_file(file_key: str, bucket_name: str = None, user_id: str = None) -> bytes:
    """Download file content from S3 (or generate mock contents if in mock mode)."""
    try:
        if _use_mock_s3():
            logger.info("Mock S3 download requested. Generating mock PDF content.")
            # Return a simple mock PDF byte content containing medical text
            return b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 50 >>\nstream\nBT /F1 12 Tf 100 700 Td (Patient: John Doe. Diagnosis: Normal Brain MRI. No anomalies detected.) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000192 00000 n\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n310\n%%EOF"

        s3 = None
        bucket = bucket_name
        if user_id and bucket:
            try:
                from backend.routers.upload import _get_user_bucket_context
                s3, resolved_bucket = _get_user_bucket_context(user_id, bucket, strict_preferred=True)
                if resolved_bucket:
                    bucket = resolved_bucket
            except Exception as ex:
                logger.warning(f"Could not resolve user custom S3 client: {ex}")

        if not s3:
            settings = get_settings()
            bucket = bucket or settings.S3_BUCKET_NAME
            s3 = _get_s3_client()

        response = s3.get_object(Bucket=bucket, Key=file_key)
        return response["Body"].read()
    except Exception as e:
        logger.exception(f"Error downloading file from S3: {file_key}")
        raise e

def list_files(prefix: str = "", bucket_name: str = None) -> list:
    """List files in S3 under a specific prefix."""
    try:
        if _use_mock_s3():
            state = mock_s3_service._load_state()
            all_keys = []
            for u in state.get("completed", {}).values():
                key = u.get("file_key", "")
                if key.startswith(prefix):
                    all_keys.append(key)
            return all_keys

        settings = get_settings()
        bucket = bucket_name or settings.S3_BUCKET_NAME
        s3 = _get_s3_client()
        response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
        keys = []
        if "Contents" in response:
            for obj in response["Contents"]:
                keys.append(obj["Key"])
        return keys
    except Exception:
        logger.exception(f"Error listing S3 files under prefix: {prefix}")
        return []

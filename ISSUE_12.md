# Issue #12 - Upload Reliability and S3 CORS Guidance

## Problem

Users saw upload failures when long uploads outlived access tokens or when newly added S3 buckets were missing browser CORS rules.

Common UI error:

- Transmission Error
- Browser could not send chunk to S3

## What Was Implemented

### 1. Token refresh and session continuity

- Backend issues short-lived access token and rotating refresh token.
- Refresh token is stored as an HttpOnly cookie.
- Frontend silently refreshes access token before expiry and retries protected requests.
- Upload flow pauses (instead of hard reset) when refresh cannot be completed.

### 2. Upload auth resilience

- Upload engine retries auth path by attempting token refresh on 401/403.
- If refresh fails, upload state is preserved and user can login and resume.

### 3. Bucket CORS helper in UI

- Buckets page now includes:
  - One-click `Copy CORS Policy` button.
  - Step-by-step AWS instructions.
  - Ready-to-paste JSON CORS block.

## Required AWS CORS Policy for New Buckets

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["http://localhost:5173"],
    "ExposeHeaders": ["ETag", "x-amz-version-id"],
    "MaxAgeSeconds": 3000
  }
]
```

Apply this per bucket in AWS S3:

1. Open bucket in AWS console.
2. Permissions tab.
3. Cross-origin resource sharing (CORS) -> Edit.
4. Paste policy and save.

## Verification Completed

- Backend import smoke test passed.
- Frontend production build passed.

## Notes

- Block Public Access being ON does not prevent private pre-signed uploads.
- CORS is configured per bucket and must be added for each new bucket.
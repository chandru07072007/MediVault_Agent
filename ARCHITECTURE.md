# Architecture

This document describes the high-level design, core modules, data and control flow, security model, and extensibility points of MediVault.

---

## Table of Contents

- [High-Level Design](#high-level-design)
- [Core Modules](#core-modules)
  - [Backend](#backend-modules)
  - [Frontend](#frontend-modules)
- [Data Flow](#data-flow)
  - [Authentication flow](#authentication-flow)
  - [Upload lifecycle](#upload-lifecycle)
  - [Resume flow](#resume-flow)
- [Database Schema](#database-schema)
- [Security Considerations](#security-considerations)
- [Extensibility Notes](#extensibility-notes)

---

## High-Level Design

```
┌───────────────────────────────────────────────────────────┐
│                        Browser                            │
│                                                           │
│  React 19 + Vite 8 + Tailwind CSS                         │
│  ┌────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ Login /    │  │ useChunkedUpload  │  │ File Preview  │ │
│  │ Register   │  │ (state machine)   │  │ Modal         │ │
│  └─────┬──────┘  └────────┬─────────┘  └───────────────┘ │
│        │                  │                               │
└────────┼──────────────────┼───────────────────────────────┘
         │  JWT Bearer       │  REST (Axios)
         ▼                  ▼
┌─────────────────────────────────┐
│       FastAPI Backend           │
│  /api/auth/*   /api/upload/*    │
│                                 │
│  ┌─────────┐  ┌──────────────┐  │
│  │  Auth   │  │  Upload      │  │
│  │ Routes  │  │  Routes      │  │
│  └────┬────┘  └──────┬───────┘  │
│       │              │          │
│  ┌────▼──────────────▼───────┐  │
│  │  MongoDB (pymongo)        │  │
│  │  users · upload_sessions  │  │
│  │  uploads · bucket_creds   │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌──────────────────────────┐   │
│  │  boto3 / Mock S3 service │   │
│  └──────────┬───────────────┘   │
└─────────────┼───────────────────┘
              │  Pre-signed URLs + Multipart API
              ▼
        ┌───────────┐
        │  AWS S3   │
        └───────────┘
```

The browser **never** receives raw AWS credentials. The backend generates short-lived pre-signed S3 URLs and hands them to the frontend. Each chunk PUT goes directly from the browser to S3; only the resulting ETag is passed back through the backend to record progress.

---

## Core Modules

### Backend Modules

#### `app/main.py`
FastAPI application factory. Registers middleware (CORS, SlowAPI rate limiting), includes routers, and manages the async background cleanup task that aborts expired multipart uploads.

#### `app/config.py`
Pydantic `BaseSettings` class that reads configuration from environment variables and `.env`. Includes validators that:
- Reject weak `JWT_SECRET_KEY` values (a set of known-weak strings).
- Require `MONGO_URI` to start with `mongodb://` or `mongodb+srv://`.

All configuration is consumed via a cached `get_settings()` factory to avoid repeated I/O.

#### `app/auth.py` + `app/auth_routes.py`
Authentication layer:
- **Password hashing** — bcrypt with auto-generated salt.
- **Token creation** — HS256 JWT with a configurable expiry (default 60 minutes).
- **Token verification** — `HTTPBearer` dependency; expired and invalid tokens return HTTP 401.
- **Routes** — `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`.
- Registration is limited to 5 requests/minute per IP; login to 10 requests/minute per IP.

#### `app/routes.py`
Upload lifecycle router (`/api/upload/*`):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/start-upload` | POST | Initiate a multipart upload in S3 and create a session document in MongoDB |
| `/presigned-url` | POST | Generate a pre-signed PUT URL for one chunk part |
| `/update-part` | POST | Record a successfully uploaded chunk ETag in the session |
| `/complete-upload` | POST | Finalize the multipart upload in S3, move session to upload history |
| `/abort` | POST | Abort the in-progress multipart upload in S3 and delete the session |
| `/resume-session` | GET | Return session state (uploaded part numbers) for a given file ID |
| `/history` | GET | Return the authenticated user's upload history |
| `/buckets` | GET/POST/DELETE | Manage per-user S3 bucket credentials |
| `/bucket-usage/{bucket_id}` | GET | Return storage usage statistics for a bucket |

All endpoints require a valid JWT. File extension is validated against an allowlist (`dcm`, `dicom`, `jpg`, `jpeg`, `png`, `pdf`, `zip`). Folder paths (containing `/` or `\`) in file names are rejected.

#### `app/s3_client.py`
Thin wrappers around `boto3` S3 multipart API:
- `initiate_multipart_upload` — calls `create_multipart_upload`.
- `generate_presigned_url` — calls `generate_presigned_url` for `upload_part`.
- `complete_multipart_upload` — calls `complete_multipart_upload` with all ETags.
- `abort_multipart_upload` — calls `abort_multipart_upload`.
- `generate_presigned_get_url` — pre-signed GET URL for file preview.

When `USE_MOCK_S3=true`, all calls are transparently redirected to `mock_s3_service.py` which uses a local JSON file to track state.

#### `app/mock_s3_service.py`
File-backed S3 mock for local development and CI. Supports simulated part failure via `MOCK_S3_PART_FAILURE_RATE` to exercise retry logic without real AWS.

#### `app/database.py`
Initialises the MongoDB client and exposes four collections:
- `users` — authentication records.
- `upload_sessions` — in-progress upload state (TTL index at `expires_at`; sessions expire 24 hours after creation).
- `uploads` — completed upload history.
- `bucket_credentials` — encrypted per-user AWS bucket credentials.

TTL and compound indexes are created on startup if they do not already exist.

#### `app/encryption_utils.py`
Symmetric Fernet encryption for sensitive values (AWS access key, secret key) before they are persisted to MongoDB. The Fernet key is read from `ENCRYPTION_KEY` in the environment and cached.

#### `app/cleanup.py`
Background async task that periodically:
1. Queries for upload sessions past their `expires_at` timestamp.
2. Calls `abort_multipart_upload` on S3 for any that are still in progress.
3. Marks aborted sessions in MongoDB.

The interval is configurable via `UPLOAD_CLEANUP_INTERVAL_SECONDS` (default 300 s).

#### `app/rate_limit.py`
Exports a `limiter` instance (slowapi) shared by all routes. Limits are applied per remote IP.

---

### Frontend Modules

#### `src/hooks/useChunkedUpload.js`
The central upload state machine. Exposes:

| Export | Type | Description |
|--------|------|-------------|
| `status` | string | `idle` · `uploading` · `paused` · `completed` · `error` |
| `progress` | number | 0–100% completion |
| `chunkStatuses` | array | Per-chunk state: `pending` · `uploading` · `completed` · `error` |
| `error` / `errorMeta` | string/object | Normalized error message and metadata |
| `networkType` | string | `Slow` · `Medium` · `Fast` (computed from rolling average speed) |
| `displayChunkMB` | number | Current adaptive chunk size in MB |
| `prepareUpload(file)` | function | Validate file type, check for existing session |
| `upload(file, bucket?)` | function | Start or resume an upload |
| `pause()` | function | Pause the in-progress upload |
| `resume()` | function | Resume from last uploaded chunk |
| `cancel()` | function | Abort the upload and clean up |

Internally the hook manages:
- A **concurrency pool** of up to 5 parallel chunk uploads.
- **Exponential back-off** retry (up to 3 retries per chunk, base delay 1 s).
- **Adaptive chunk sizing** — after 2 baseline chunks, adjusts chunk size to 5/7/10 MB based on rolling average speed.
- **Stale-run guard** — a monotonically increasing `runId` ensures callbacks from cancelled runs are silently dropped.
- **AbortController** per chunk PUT — cancelling the upload immediately aborts in-flight fetches.

#### `src/api/uploadApi.js`
Axios wrappers for all upload lifecycle and bucket management endpoints. Reads base paths from `VITE_API_AUTH_BASE` and `VITE_API_UPLOAD_BASE` environment variables (defaulting to `/api/auth` and `/api/upload`).

#### `src/utils/chunker.js`
`splitFileIntoChunks(file, chunkSizeBytes)` — slices a `File` object into numbered `Blob` chunks.

#### `src/utils/checksum.js`
`computeFileChecksum(file)` — computes a SHA-256 hex digest in-browser using `SubtleCrypto`. Runs in parallel with the upload; a pending placeholder is used if the digest is not ready when `start-upload` fires.

#### `src/utils/fileTypeUtils.js`
`validateFileTypeByMagicBytes(file)` — reads the first bytes of the file and checks magic byte signatures (DICOM `DICM`, JPEG `FFD8FF`, PNG `89504E47`, PDF `%PDF`, ZIP `PK`). This prevents the extension from being spoofed.

---

## Data Flow

### Authentication flow

```
Browser                          Backend                  MongoDB
  │                                 │                        │
  ├─ POST /api/auth/register ──────►│                        │
  │   {username, password}          ├─ bcrypt hash ─────────►│ insert users
  │                                 │◄──────────────────────┤
  │◄─ {message: "registered"} ──────┤                        │
  │                                 │                        │
  ├─ POST /api/auth/login ─────────►│                        │
  │   {username, password}          ├─ find + bcrypt verify ►│
  │                                 │◄──────────────────────┤
  │◄─ {access_token, token_type} ───┤                        │
  │   (stored in localStorage)      │                        │
```

### Upload lifecycle

```
Browser                          Backend                   S3
  │                                 │                       │
  ├─ POST /api/upload/start-upload ►│                       │
  │                                 ├─ create_multipart ───►│
  │                                 │◄─ {upload_id} ────────┤
  │                                 ├─ insert upload_session │
  │◄─ {upload_id, file_key} ────────┤                       │
  │                                 │                       │
  │  (for each chunk):              │                       │
  ├─ POST /api/upload/presigned-url►│                       │
  │◄─ {url, part_number} ───────────┤                       │
  │                                 │                       │
  ├─ PUT <presigned_url> (chunk) ───────────────────────────►│
  │◄─ ETag ─────────────────────────────────────────────────┤
  │                                 │                       │
  ├─ POST /api/upload/update-part ─►│                       │
  │   {file_id, file_key,           ├─ $push part to session│
  │    upload_id, part_number, etag}│                       │
  │◄─ {message: "ok"} ──────────────┤                       │
  │                                 │                       │
  ├─ POST /api/upload/complete ─────►│                       │
  │   {file_id, file_key,           ├─ complete_multipart ─►│
  │    upload_id, parts, …}         │◄─ location ───────────┤
  │                                 ├─ insert uploads record │
  │◄─ {message, location} ──────────┤                       │
```

### Resume flow

If the browser reloads or the connection drops mid-upload:

```
Browser                          Backend                MongoDB
  │                                 │                      │
  ├─ GET /api/upload/resume-session►│                      │
  │   ?file_id=<id>                 ├─ find upload_session►│
  │                                 │◄─ session doc ───────┤
  │◄─ {has_session, upload_id,      │                      │
  │    file_key,                    │                      │
  │    uploaded_part_numbers,       │                      │
  │    total_parts}  ───────────────┤                      │
  │                                 │                      │
  │  (upload skips completed parts) │                      │
```

---

## Database Schema

### `users`
| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | MongoDB primary key |
| `username` | string | Unique login name |
| `password` | string | bcrypt hash |

### `upload_sessions`
| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | |
| `file_id` | string | Client-generated `name-size` key |
| `file_key` | string | S3 object key |
| `upload_id` | string | S3 multipart upload ID |
| `username` | string | Owning user |
| `status` | string | `in_progress` · `aborted` |
| `parts_uploaded` | array | `[{PartNumber, ETag}]` |
| `total_parts` | int | Calculated chunk count |
| `expires_at` | datetime | TTL: 24 hours after creation |
| `created_at` | datetime | |

Indexes: TTL on `expires_at`; compound `(status, expires_at)`.

### `uploads`
| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | |
| `file_name` | string | Original file name |
| `file_key` | string | S3 object key |
| `size` | int | File size in bytes |
| `checksum` | string | SHA-256 hex digest |
| `location` | string | S3 URL returned on complete |
| `username` | string | Owning user |
| `uploaded_at` | datetime | Completion timestamp |
| `bucket_name` | string | Target S3 bucket |

### `bucket_credentials`
| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | |
| `username` | string | Owning user |
| `bucket_name` | string | S3 bucket name |
| `region` | string | AWS region |
| `aws_access_key_id` | string | Fernet-encrypted |
| `aws_secret_access_key` | string | Fernet-encrypted |
| `size_limit` | int | Max bytes allowed |
| `created_at` | datetime | |
| `validation_status` | string | `valid` · `invalid` · `unknown` |
| `system_default` | bool | Whether this is the server-default bucket |

---

## Security Considerations

### Credential isolation
- AWS credentials are **never** sent to the browser.
- Pre-signed URLs are time-limited (default 1 hour, configurable via `PRESIGNED_URL_EXPIRY`).
- Per-user bucket credentials are encrypted with Fernet before storage and only decrypted server-side when generating pre-signed URLs.

### Authentication
- Passwords stored as bcrypt hashes with auto-generated salts.
- JWT secrets are validated at startup; known-weak values are rejected.
- `ACCESS_TOKEN_EXPIRE_MINUTES` is bounded to 60–1440 minutes.

### Transport
- CORS origins are explicitly allowlisted via `CORS_ALLOW_ORIGINS`.
- All API routes require a valid Bearer token (except `/api/auth/register` and `/api/auth/login`).

### Rate limiting
| Endpoint | Limit |
|----------|-------|
| `POST /api/auth/register` | 5/min per IP |
| `POST /api/auth/login` | 10/min per IP |
| `POST /api/upload/start-upload` | 30/min per IP |
| `POST /api/upload/presigned-url` | 600/min per IP |
| `POST /api/upload/update-part` | 600/min per IP |
| `POST /api/upload/complete-upload` | 30/min per IP |
| `POST /api/upload/abort` | 60/min per IP |

### S3 hygiene
- MongoDB TTL index expires upload sessions after 24 hours.
- The background cleanup task aborts orphaned S3 multipart uploads.
- An S3 lifecycle rule (abort incomplete multiparts after 1–2 days) is recommended as a safety net.

### Input validation
- File names are validated: folder paths (containing `/` or `\`) are rejected.
- File extensions must be in the server-side allowlist.
- Magic-byte validation is also performed client-side before the first API call.
- All Pydantic schemas enforce length and format constraints.

---

## Extensibility Notes

### Adding a new file type
1. Add the extension to `ALLOWED_UPLOAD_EXTENSIONS` in `backend/app/routes.py`.
2. Add the magic-byte signature to `frontend/src/utils/fileTypeUtils.js`.
3. Optionally add a preview viewer component under `frontend/src/components/viewers/`.

### Adding a new storage backend
`backend/app/s3_client.py` is the only file that calls `boto3`. Replace or wrap its functions to target a different object store (GCS, Azure Blob, MinIO) without changing routes or business logic.

### Scaling the backend
- The FastAPI app is stateless except for the MongoDB client (a single process-level singleton). Multiple Uvicorn workers or processes share MongoDB safely.
- The background cleanup task runs per-process; to avoid duplicate work at scale, move cleanup to a dedicated worker or use a distributed lock in MongoDB.

### Refresh token support
Authentication currently issues short-lived access tokens only. To add refresh tokens:
1. Store refresh tokens in a `refresh_tokens` MongoDB collection with an expiry and a revocation flag.
2. Add `POST /api/auth/refresh` that validates the refresh token and issues a new access token.
3. Add `POST /api/auth/logout` that revokes the refresh token.

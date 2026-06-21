# Usage Guide

Step-by-step instructions, configuration reference, common commands, sample user flows, and answers to frequently asked questions.

---

## Table of Contents

- [Environment Configuration](#environment-configuration)
- [Common Commands](#common-commands)
- [Sample User Flows](#sample-user-flows)
  - [Register and log in](#1-register-and-log-in)
  - [Upload a file](#2-upload-a-file)
  - [Pause and resume an upload](#3-pause-and-resume-an-upload)
  - [View upload history](#4-view-upload-history)
  - [Add a custom S3 bucket](#5-add-a-custom-s3-bucket)
  - [Preview a file locally](#6-preview-a-file-locally)
- [Mock S3 Mode (No AWS)](#mock-s3-mode-no-aws)
- [FAQ and Common Pitfalls](#faq-and-common-pitfalls)

---

## Environment Configuration

### Backend — `backend/.env`

Copy the template and fill in each value:

```bash
cp backend/.env.example backend/.env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes* | — | IAM access key with S3 multipart permissions |
| `AWS_SECRET_ACCESS_KEY` | Yes* | — | IAM secret key |
| `AWS_REGION` | Yes* | `ap-south-1` | S3 bucket region |
| `S3_BUCKET_NAME` | Yes* | — | Default S3 bucket for uploads |
| `MONGO_URI` | Yes | — | Full MongoDB connection string, e.g. `mongodb://localhost:27017` |
| `MONGO_DB_NAME` | No | `medivault` | MongoDB database name |
| `JWT_SECRET_KEY` | Yes | — | Must be ≥ 32 characters, cryptographically random |
| `JWT_ALGORITHM` | No | `HS256` | JWT signing algorithm |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No | `60` | Token lifetime in minutes (60–1440) |
| `CORS_ALLOW_ORIGINS` | No | `http://localhost:5173` | Comma-separated list of allowed frontend origins |
| `PRESIGNED_URL_EXPIRY` | No | `3600` | Pre-signed URL TTL in seconds |
| `USE_MOCK_S3` | No | `false` | Set `true` to bypass real AWS (local testing) |
| `MOCK_S3_STATE_FILE` | No | `tmp/mock_s3_state.json` | Path to mock S3 state file |
| `MOCK_S3_PART_FAILURE_RATE` | No | `0.0` | Fraction of chunk uploads to fail (0.0–1.0) for retry testing |
| `UPLOAD_CLEANUP_INTERVAL_SECONDS` | No | `300` | Background cleanup task interval (60–86400) |
| `ENCRYPTION_KEY` | Yes† | — | Fernet key for encrypting stored bucket credentials |

\* Not required when `USE_MOCK_S3=true`.  
† Required when users add custom buckets via the UI. Generate a key with:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### Frontend — `frontend/.env` (optional)

Only needed if the API is not at the Vite proxy default:

```env
VITE_API_AUTH_BASE=/api/auth
VITE_API_UPLOAD_BASE=/api/upload
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000` automatically, so no `.env` file is needed for local development.

---

## Common Commands

### Backend

```bash
# Install dependencies
pip install -r backend/requirements.txt

# Start development server (auto-reload)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Start production server (4 workers)
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4

# Check health
curl http://127.0.0.1:8000/health

# Create a seed user for local testing
cd backend && python seed_user.py

# Run mock end-to-end validation (no AWS required)
cd backend && USE_MOCK_S3=true python validate_mock_e2e.py
```

### Frontend

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Lint
npm run lint

# Build production assets
npm run build

# Serve production build locally
npm run preview
```

### Docker / MongoDB

```bash
# Start MongoDB in Docker (detached)
docker compose up -d mongo

# View MongoDB logs
docker compose logs -f mongo

# Stop and remove containers
docker compose down

# Stop and remove containers + volumes (deletes all data)
docker compose down -v
```

---

## Sample User Flows

### 1. Register and log in

1. Open [http://localhost:5173](http://localhost:5173).
2. Click **Register** and enter a username and password.
3. Click **Register** to create the account.
4. Enter the same credentials and click **Login**.
5. The dashboard loads. Your username appears in the top bar.

> **API equivalent**
> ```bash
> # Register
> curl -X POST http://127.0.0.1:8000/api/auth/register \
>   -H "Content-Type: application/json" \
>   -d '{"username": "alice", "password": "strongpassword123"}'
>
> # Login
> curl -X POST http://127.0.0.1:8000/api/auth/login \
>   -H "Content-Type: application/json" \
>   -d '{"username": "alice", "password": "strongpassword123"}'
> # Response: {"access_token": "eyJ...", "token_type": "bearer"}
> ```

---

### 2. Upload a file

1. On the **Dashboard** tab, click the upload area or drag a file onto it.
2. Accepted formats: DICOM (`.dcm`, `.dicom`), JPEG, PNG, PDF, ZIP.
3. The app validates the file type by magic bytes before contacting the backend.
4. Select the target bucket from the dropdown (or leave on the default if configured).
5. Click **Upload**.
6. The progress bar and per-chunk status grid update in real time.
7. When all chunks are confirmed, status changes to **Completed**.

---

### 3. Pause and resume an upload

1. While an upload is in progress, click **Pause**.
   - The current in-flight chunks finish; no new chunks start.
   - Status changes to **Paused**.
2. Click **Resume** to continue from the last completed chunk.
   - The backend `GET /api/upload/resume-session?file_id=<id>` returns the list of already-uploaded part numbers.
   - The frontend skips those parts and uploads only the remaining chunks.
3. If the page is refreshed or the tab is closed, **re-select the same file** and click **Upload**. The app automatically detects the existing session and resumes.

> **What counts as "same file"?** The file ID is `filename + filesize`. If the file name or size changes, a new upload session is started.

---

### 4. View upload history

1. Click the **History** tab.
2. The table shows all completed uploads for the logged-in user: file name, size, checksum, bucket, and completion time.
3. Click the download/preview icon next to an entry to generate a temporary pre-signed URL and open or download the file.

---

### 5. Add a custom S3 bucket

1. Click the **Buckets** tab.
2. Click **Add Bucket**.
3. Fill in:
   - **Bucket name** — must follow S3 naming rules (3–63 chars, lowercase, no underscores).
   - **Region** — must match the bucket's actual region (e.g. `us-east-1`).
   - **AWS Access Key ID** — uppercase alphanumeric, 16–128 chars.
   - **AWS Secret Access Key** — 16–256 chars.
   - **Size limit (GB)** — maximum allowed storage for this bucket.
4. Click **Save**. The backend validates the credentials against S3 before storing them.
5. The new bucket appears in the list with a usage bar.
6. To delete a bucket, click the trash icon. This removes only the stored credentials; the S3 bucket itself is not affected.

#### Required CORS for each new bucket

After adding a bucket in the app, configure AWS S3 bucket CORS for browser chunk uploads:

1. Open your bucket in AWS console.
2. Go to **Permissions** -> **Cross-origin resource sharing (CORS)**.
3. Click **Edit** and paste this policy.
4. Save changes.

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

Note: CORS is configured per bucket. Every newly added bucket needs this rule.

---

### 6. Preview a file locally

1. Select a file in the upload area (do not click Upload yet, or do so during upload).
2. Click the **Preview** button below the file selector.
3. The preview modal opens:
   - **DICOM** — rendered with Cornerstone Core (windowing, zoom).
   - **JPEG / PNG** — rendered as an `<img>` element.
   - **PDF** — rendered with pdf.js.
   - **Excel / CSV** — parsed and displayed as a table.
   - **Other** — file name, size, and type are shown.
4. The preview is local-only (in-browser `ObjectURL`). No data is sent to the server at this step.

---

## Mock S3 Mode (No AWS)

For local development and CI, set `USE_MOCK_S3=true` in the backend environment. This routes all S3 operations to a file-backed mock in `tmp/mock_s3_state.json`.

```bash
# Run with mock S3
cd backend
USE_MOCK_S3=true uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Run the full mock end-to-end validation
USE_MOCK_S3=true python validate_mock_e2e.py
```

The validation script covers:
- Normal upload (start → chunks → complete).
- Pause and resume mid-upload.
- Crash recovery (simulated mid-upload restart).
- Chunk retry handling (set `MOCK_S3_PART_FAILURE_RATE=0.3` to simulate 30% chunk failures).
- Cancel flow (abort + session cleanup).

---

## FAQ and Common Pitfalls

### The backend exits immediately with a validation error

Pydantic validates settings on startup. Common causes:
- `JWT_SECRET_KEY` is missing or is a known-weak value — use a random 32+ character string.
- `MONGO_URI` does not start with `mongodb://` or `mongodb+srv://`.
- `ACCESS_TOKEN_EXPIRE_MINUTES` is outside the 60–1440 range.

### My upload always restarts from the beginning instead of resuming

The resume key is `filename + filesize`. Ensure:
- You re-select the **exact same file** (same name, same size).
- The upload session has not expired (sessions expire 24 hours after creation).
- The file was not modified between sessions.

### Chunks keep retrying and eventually fail

The frontend retries each chunk up to 3 times with exponential back-off (1 s, 2 s, 4 s). Check:
- AWS credentials are correct and the IAM policy allows `s3:PutObject` and `s3:ListMultipartUploadParts`.
- The S3 bucket CORS policy allows PUT from your frontend origin.
- Network is stable — use `USE_MOCK_S3=true` to rule out AWS-side issues.

### "CORS error" in the browser console

The backend's `CORS_ALLOW_ORIGINS` must include the exact origin of the frontend (scheme + hostname + port). Example:

```env
CORS_ALLOW_ORIGINS=http://localhost:5173
```

For multiple origins, separate with commas (no spaces):

```env
CORS_ALLOW_ORIGINS=http://localhost:5173,https://app.example.com
```

### The bucket usage bar always shows 0

The usage endpoint fetches object sizes from S3. Ensure:
- The IAM policy grants `s3:ListBucket`.
- The stored credentials match the correct region for that bucket.

### How do I rotate the JWT secret?

1. Update `JWT_SECRET_KEY` in `.env` to a new random value.
2. Restart the backend.
3. All existing tokens are immediately invalidated. Users will need to log in again.

### How do I rotate the `ENCRYPTION_KEY`?

Currently, rotating `ENCRYPTION_KEY` requires re-encrypting all stored bucket credentials. Steps:
1. Export all bucket credentials (decrypt with the old key).
2. Update `ENCRYPTION_KEY`.
3. Re-encrypt and update each record in MongoDB.
4. Restart the backend.

A migration helper script is not yet included; this is tracked as future work.

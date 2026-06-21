# Contributing to MediVault

Thank you for considering a contribution! This guide covers everything you need to get started: setting up a local development environment, coding conventions, branch and commit standards, the PR process, and how to report issues.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Local Development](#local-development)
- [Coding Standards](#coding-standards)
- [Branch and Commit Conventions](#branch-and-commit-conventions)
- [Pull Request Checklist](#pull-request-checklist)
- [Issue Reporting](#issue-reporting)

---

## Code of Conduct

Be respectful, collaborative, and constructive. Harassment or abusive behaviour of any kind is not welcome.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/package-system.git
   cd package-system
   ```
3. Add the upstream remote so you can keep your fork in sync:
   ```bash
   git remote add upstream https://github.com/ANURA4G/package-system.git
   ```
4. Set up the development environment (see [Local Development](#local-development)).

---

## Local Development

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Python | 3.10 |
| Node.js | 18 |
| npm | 9 |
| Docker (optional) | any recent version |

### Backend

```bash
cd backend

# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy and configure environment
cp .env.example .env
# Edit .env — at minimum set MONGO_URI and JWT_SECRET_KEY
# Use USE_MOCK_S3=true to skip real AWS credentials

# Start MongoDB (if using Docker)
docker compose up -d mongo

# Start development server
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Verify the backend is running:
```bash
curl http://127.0.0.1:8000/health
# {"status":"healthy","service":"medical-upload-api"}
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start Vite development server
npm run dev
# Open http://localhost:5173
```

### Running the Mock End-to-End Validation

No AWS account is needed for this:

```bash
cd backend
USE_MOCK_S3=true python validate_mock_e2e.py
```

This exercises the full upload lifecycle (start, chunks, complete, pause/resume, abort) against the file-backed mock.

---

## Coding Standards

### Python (backend)

- **Style** — follow [PEP 8](https://peps.python.org/pep-0008/). Use 4-space indentation.
- **Type hints** — add type hints to all function signatures.
- **Pydantic models** — all request and response bodies must be Pydantic models defined in `app/schemas.py`.
- **Settings** — read configuration exclusively via `get_settings()` from `app/config.py`. Do not hard-code values.
- **Logging** — use `logging.getLogger(__name__)`. Do not use `print()`.
- **Error handling** — raise `HTTPException` with appropriate status codes. For S3 errors, use `_handle_s3_error` in `routes.py`.
- **Security** — never log or return AWS credentials, JWT secrets, or encrypted values.
- **Linting** — run `ruff` or `flake8` before committing (the project does not currently mandate a specific linter, but contributions should be clean).

### JavaScript / React (frontend)

- **Style** — follow the existing ESLint configuration (`eslint.config.js`). Run `npm run lint` before committing.
- **Component files** — one component per file; name matches the exported component (PascalCase).
- **Hooks** — custom hooks live in `src/hooks/`. File names use `use` prefix (camelCase).
- **API calls** — all HTTP calls go through `src/api/`. Do not use `fetch` or `axios` directly in components.
- **State management** — React state + hooks only. No Redux or external state library is used.
- **Error handling** — catch and normalize errors using the patterns established in `useChunkedUpload.js`. Propagate meaningful messages to the UI via `error`/`errorMeta` state.
- **No console.log in production code** — use the error/status state for user feedback.

---

## Branch and Commit Conventions

### Branches

Create branches from `main`. Use the following naming scheme:

```
<type>/<short-description>
```

| Type | When to use |
|------|-------------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation-only change |
| `refactor/` | Code restructuring with no behaviour change |
| `test/` | Adding or updating tests |
| `chore/` | Tooling, dependencies, CI |

Examples:
```
feat/refresh-token-endpoint
fix/abort-race-condition
docs/architecture-diagram
```

### Commits

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short summary>
```

- **type** — `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **scope** — optional; e.g. `auth`, `upload`, `frontend`, `mock-s3`
- **summary** — imperative mood, ≤ 72 characters, no trailing period

Examples:
```
feat(upload): add adaptive chunk size based on measured speed
fix(auth): reject tokens signed with wrong algorithm
docs(architecture): add database schema section
chore(deps): upgrade boto3 to 1.35.0
```

For a breaking change, add `!` after the type/scope and a `BREAKING CHANGE:` footer:
```
feat(auth)!: require refresh token on session renewal

BREAKING CHANGE: access tokens no longer auto-renew; clients must implement the /auth/refresh flow
```

---

## Pull Request Checklist

Before opening a PR, confirm the following:

### General
- [ ] Branch is based on the latest `main` (rebase or merge if needed).
- [ ] The PR description explains **what** changed and **why**.
- [ ] No unrelated files are modified.

### Backend
- [ ] `pip install -r requirements.txt` succeeds cleanly.
- [ ] The API starts without errors: `uvicorn app.main:app --reload`.
- [ ] New endpoints have Pydantic request and response models.
- [ ] All new endpoints require JWT authentication (unless explicitly public).
- [ ] Rate limits are applied to new auth/upload endpoints.
- [ ] No secrets, credentials, or PII are logged or returned.
- [ ] `USE_MOCK_S3=true python validate_mock_e2e.py` passes if upload logic was changed.

### Frontend
- [ ] `npm install` succeeds cleanly.
- [ ] `npm run lint` passes with zero errors.
- [ ] `npm run build` completes without errors.
- [ ] New API calls go through `src/api/`, not inline `fetch`/`axios`.
- [ ] Error states are handled and surfaced to the user.

### Documentation
- [ ] `README.md`, `ARCHITECTURE.md`, or `USAGE.md` updated if behaviour changed.
- [ ] New environment variables are documented in `.env.example` and `USAGE.md`.

---

## Issue Reporting

### Bugs

Open a GitHub issue with the **bug** label and include:

1. **Summary** — one-sentence description.
2. **Steps to reproduce** — numbered list.
3. **Expected behaviour** — what should happen.
4. **Actual behaviour** — what actually happens (include error messages and stack traces).
5. **Environment** — Python version, Node.js version, OS, browser (if frontend).
6. **Relevant logs** — backend log output, browser console errors.

> Do **not** include AWS credentials, JWT secrets, or any personal health information in issue reports.

### Feature requests

Open a GitHub issue with the **enhancement** label and describe:

1. The problem you are trying to solve.
2. The proposed solution.
3. Alternatives you have considered.
4. Any relevant prior art or references.

### Security vulnerabilities

**Do not open a public issue for security vulnerabilities.** Report them privately by emailing the repository maintainers or using GitHub's private security advisory feature. See [`backend/SECURITY.md`](backend/SECURITY.md) for the security policy.

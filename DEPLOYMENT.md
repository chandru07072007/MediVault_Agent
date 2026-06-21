# Deployment Guide - MediPack AI

This guide contains step-by-step instructions to deploy **MediPack AI** locally or to cloud environments in a fully containerized, reproducible format.

---

## 1. Quick Local / VM Deployment (Docker Compose)

The entire application stack (Frontend, Backend, and MongoDB Database) can be built and launched with a single command.

### Prerequisites
* [Docker](https://docs.docker.com/get-docker/) installed.
* [Docker Compose](https://docs.docker.com/compose/install/) installed.

### Step 1: Clone and Configure Environment
Copy the environment template in the project:
```bash
cd backend
cp .env.example .env
```
Ensure you have configured a strong `JWT_SECRET_KEY` and your `GEMINI_API_KEY` (if you want live AI summarization).

### Step 2: Launch the Stack
Run the following command from the root of the `package-system/` directory:
```bash
docker compose up -d --build
```

This will automatically:
1. Fetch and start the MongoDB database.
2. Build the FastAPI backend image, resolve module paths (`agents/` and `tools/`), install python requirements, and start the API on port `8000`.
3. Compile the React Vite frontend assets, pull Nginx, set up SPA route proxying, and start the web server on port `80`.

### Step 3: Verify
Open your browser and navigate to:
* **Frontend Portal**: [http://localhost](http://localhost) (port 80)
* **Backend OpenAPI docs**: [http://localhost:8000/docs](http://localhost:8000/docs)

---

## 2. Cloud Providers Production Deployment

For staging/production environments, you can split frontend assets and backend service hosting for maximum performance.

### A. Deploying the Backend API (e.g., Render, Railway, Fly.io)
You can deploy the backend container directly using the custom Dockerfile:
1. Connect your GitHub repository to your cloud provider.
2. Create a new **Web Service** pointing to your repository.
3. Configure the following environment variable settings:
   * **Root Directory**: `package-system`
   * **Dockerfile Path**: `backend/Dockerfile`
   * **Build Context**: `.` (important so python can import `agents/` and `tools/` from the root)
4. Add environment variables:
   * `MONGO_URI`: The connection string for your cloud MongoDB (e.g., MongoDB Atlas).
   * `MONGO_DB_NAME`: `medivault`
   * `JWT_SECRET_KEY`: A strong 32-character string.
   * `ENCRYPTION_KEY`: A Fernet encryption key (`cryptography`).
   * `GEMINI_API_KEY`: Your Gemini API key.
   * `CORS_ALLOW_ORIGINS`: The URL of your deployed frontend.

### B. Deploying the Frontend (e.g., Netlify, Vercel, Cloudflare Pages)
Since the frontend is a pure static React application, it can be hosted on static CDNs:
1. Configure a new site on your hosting provider.
2. Set the build settings:
   * **Root Directory**: `package-system/frontend`
   * **Build Command**: `npm run build`
   * **Output Directory**: `dist`
3. Configure redirect rules to support SPA routing (so refreshing subpages like `/history` doesn't throw a 404):
   * For **Netlify**, add a `_redirects` file in the build output with:
     ```text
     /*   /index.html   200
     ```
   * For **Vercel**, add a `vercel.json` config file:
     ```json
     {
       "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
     }
     ```
4. Set the environment variable `VITE_API_UPLOAD_BASE` to point to your deployed backend API URL (e.g. `https://your-backend-service.onrender.com/api/upload`).

FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy backend requirements and install
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend, agents, and tools directories
COPY backend/ ./backend/
COPY agents/ ./agents/
COPY tools/ ./tools/

# Set Python path to resolve packages correctly
ENV PYTHONPATH=/app

WORKDIR /app/backend
EXPOSE 8000

CMD python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}

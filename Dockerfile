FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-por \
    tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY cofre_app ./cofre_app
COPY public ./public

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    COFRE_DB=/data/cofre.sqlite

EXPOSE 8787
CMD ["sh", "-c", "uvicorn cofre_app.main:app --host ${HOST:-0.0.0.0} --port ${PORT:-8787}"]

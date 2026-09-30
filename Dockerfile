FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-por \
    tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    COFRE_DB=/data/cofre.sqlite \
    COFRE_NO_DEMO=1

EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "start"]

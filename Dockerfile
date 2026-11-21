
# syntax=docker/dockerfile:1

# IHS Backend — Express 5 + Sequelize 6 + MySQL (CommonJS)
# Multi-stage production image with Chromium for prescription PDF rendering.

# ── Stage 1: dependencies ────────────────────────────────────────────────
FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS deps

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    && npm cache clean --force

# ── Stage 2: runtime ─────────────────────────────────────────────────────
FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        tini \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-noto-core \
        fonts-noto-color-emoji \
        fonts-indic \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000 \
    API_PREFIX=/api \
    UPLOAD_DIR=/app/uploads \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

COPY --from=deps /app/node_modules ./node_modules

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /app/uploads \
    && chown -R node:node /app/uploads

VOLUME ["/app/uploads"]

USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+(process.env.API_PREFIX||'/api')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "src/server.js"]

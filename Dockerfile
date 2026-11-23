# The server and web app in one image.
#   docker build -t einvoicing .
#   docker run --env-file deploy/env.example -p 3000:3000 einvoicing
# Node runs the TypeScript sources directly (type stripping), so there is no compile step
# for the server; the web app is built in the first stage.

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY web ./web
RUN npm run web:build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# pg_dump and pg_restore for scripts/backup.sh and scripts/restore.sh.
# Chromium prints documents from the businesses' templates (--build-arg PDF_BROWSER=none leaves it
# out: documents then print with the built-in layouts).
ARG PDF_BROWSER=chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
  && if [ "$PDF_BROWSER" = "chromium" ]; then apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core; fi \
  && rm -rf /var/lib/apt/lists/*
ENV PDF_RENDERER=${PDF_BROWSER} CHROMIUM_PATH=/usr/bin/chromium
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
COPY schemas ./schemas
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]

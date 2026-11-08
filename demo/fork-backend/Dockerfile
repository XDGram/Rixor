# Rixor fork-demo backend. Runs a private, persistent demo chain built from Robinhood Chain mainnet state.
# Exposes only the allowlisted HTTP API on $PORT. Mount a persistent volume at /data.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY artifacts ./artifacts

ENV NODE_ENV=production \
    STATE_DIR=/data \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080

# tini forwards SIGTERM so anvil saves the chain state on shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.mjs"]
